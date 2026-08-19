import { PLUGIN_DEV_TOOL_SCHEMAS } from './toolSchemas'
import { executeTool } from './toolExecutor'
import { getSession, markSessionEnded } from './sessionStore'
import { isBlockingVerificationFailure } from '../pluginDevVerification'
import type { PluginDevAgentEvent, PluginDevAgentPhase } from './types'
import type { ToolDeclaration, ToolHandler, ToolPack } from '../../agent-platform/toolHost'
import { withAgentJsonInvocationContext } from '../agentJsonClient'

const READ_TOOLS = new Set([
  'plugin_get_state',
  'browser_html',
  'browser_inspect',
  'browser_evaluate',
  'browser_status',
  'browser_wait'
])

function phaseForTool(name: string): PluginDevAgentPhase {
  if (name.startsWith('browser_')) return 'discover'
  if (name === 'plugin_update_code' || name === 'plugin_update_package') return 'implement'
  if (name === 'plugin_dry_run') return 'dry_run'
  if (name === 'plugin_verify') return 'verify'
  if (name === 'plugin_finish' || name === 'plugin_install') return 'finish'
  if (name === 'session_request_user') return 'waiting_user'
  return 'discover'
}

function updatePhase(
  sessionId: string,
  step: number,
  phase: PluginDevAgentPhase,
  emit: (event: PluginDevAgentEvent) => void
): void {
  const session = getSession(sessionId)
  if (!session || session.phase === phase) return
  session.phase = phase
  emit({ type: 'phase_updated', sessionId, step, phase })
}

function capability(name: string): string {
  if (name === 'plugin_get_state') return 'plugin.read'
  if (name === 'plugin_update_code' || name === 'plugin_update_package') return 'plugin.write'
  if (name === 'plugin_dry_run' || name === 'plugin_verify' || name === 'plugin_finish') return 'plugin.test'
  if (name === 'plugin_install') return 'plugin.install'
  if (name.startsWith('browser_')) {
    return READ_TOOLS.has(name) ? 'browser.read' : 'browser.interact'
  }
  return 'plugin.write'
}

function effect(name: string): ToolDeclaration['effect'] {
  if (name === 'plugin_install') return 'install'
  if (name === 'browser_fetch_page' || name === 'plugin_dry_run' || name === 'plugin_verify') return 'network'
  if (READ_TOOLS.has(name)) return 'read'
  return 'write'
}

function resourceKey(name: string): string | undefined {
  if (name.startsWith('browser_') || name === 'plugin_dry_run' || name === 'plugin_verify') return 'scrape-browser'
  if (name.startsWith('plugin_') || name.startsWith('session_')) return 'plugin-draft'
  return undefined
}

function redact(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'browser_type' && typeof args.text === 'string') {
    return { ...args, text: `[redacted ${args.text.length} chars]` }
  }
  if (name === 'plugin_update_code') {
    return {
      ...args,
      ...(typeof args.code === 'string' ? { code: `[source ${args.code.length} chars]` } : {}),
      ...(typeof args.newText === 'string' ? { newText: `[source ${args.newText.length} chars]` } : {})
    }
  }
  return args
}

export const PLUGIN_DEVELOPER_TOOL_PACK: ToolPack = {
  ref: 'toolpack:plugin-developer:v1',
  tools: PLUGIN_DEV_TOOL_SCHEMAS.map(({ function: tool }) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    schema: tool.parameters,
    capability: capability(tool.name),
    effect: effect(tool.name),
    executionMode: 'sequential',
    timeoutMs: tool.name.startsWith('browser_') || tool.name === 'plugin_dry_run' ? 60_000 : 120_000,
    resourceKey: () => resourceKey(tool.name),
    redact: (args) => redact(tool.name, args)
  }))
}

export function createPluginDeveloperToolHandlers(input: {
  domainSessionId: string
  step: () => number
  emit: (event: PluginDevAgentEvent) => void
}): ReadonlyMap<string, ToolHandler> {
  return new Map(
    PLUGIN_DEV_TOOL_SCHEMAS.map(({ function: tool }) => [
      tool.name,
      async ({ args, progress }) => {
        const session = getSession(input.domainSessionId)
        if (!session) throw new Error('插件开发会话不存在')
        const step = input.step()
        updatePhase(input.domainSessionId, step, phaseForTool(tool.name), input.emit)
        const startEvent: PluginDevAgentEvent = {
          type: 'tool_start',
          sessionId: input.domainSessionId,
          step,
          tool: tool.name,
          args
        }
        input.emit(startEvent)
        progress(`正在执行 ${tool.name}`)
        let result = await withAgentJsonInvocationContext(
          { affinityId: session.verifierAffinityId },
          () => executeTool(
            input.domainSessionId,
            tool.name,
            JSON.stringify(args),
            step
          )
        )
        if (tool.name === 'plugin_dry_run' && result.ok) {
          updatePhase(input.domainSessionId, step, 'verify', input.emit)
          const verification = await withAgentJsonInvocationContext(
            { affinityId: session.verifierAffinityId },
            () => executeTool(input.domainSessionId, 'plugin_verify', '{}', step)
          )
          result = {
            ...result,
            ok: result.ok && verification.ok,
            content: `${result.content}\n\n自动语义验证：\n${verification.content}`,
            events: [...(result.events ?? []), ...(verification.events ?? [])],
            structured: {
              ...(result.structured ?? {}),
              automaticVerification: verification.structured,
              automaticVerificationOk: verification.ok
            }
          }
        }
        if (
          result.finish?.success &&
          (!session.lastDryRun?.ok ||
            !session.lastVerification ||
            session.lastVerification.items.some((item) => isBlockingVerificationFailure(item)))
        ) {
          result = {
            ok: false,
            content: 'plugin_finish(success=true) 被领域规则拒绝：必须先通过当前代码的 dry-run 与语义验证。'
          }
        }
        for (const event of result.events ?? []) input.emit(event)
        const resultEvent: PluginDevAgentEvent = {
          type: 'tool_result',
          sessionId: input.domainSessionId,
          step,
          tool: tool.name,
          ok: result.ok,
          summary: result.content.slice(0, 240),
          detail: result.content
        }
        input.emit(resultEvent)
        if (result.waitForUser) {
          session.status = 'waiting_user'
          session.phase = 'waiting_user'
        }
        if (result.finish) {
          session.status = result.finish.success ? 'completed' : 'failed'
          session.phase = 'finish'
          markSessionEnded(session.id)
          const doneEvent: PluginDevAgentEvent = {
            type: 'done',
            sessionId: session.id,
            step,
            success: result.finish.success,
            summary: result.finish.summary,
            package: session.package,
            dryRun: session.lastDryRun,
            verification: session.lastVerification
          }
          input.emit(doneEvent)
        }
        const summary = result.content.length > 240
          ? `${result.content.slice(0, 237)}…`
          : result.content
        return {
          ok: result.ok,
          content: result.content,
          summary,
          terminate: Boolean(result.finish || result.waitForUser),
          recovery: {
            structured: result.structured,
            waitForUser: result.waitForUser,
            finish: result.finish,
            events: result.events
          }
        }
      }
    ])
  )
}
