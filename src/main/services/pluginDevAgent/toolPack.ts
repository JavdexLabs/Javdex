import { PLUGIN_DEV_TOOL_SCHEMAS } from './toolSchemas'
import { executeTool } from './toolExecutor'
import { getSession } from './sessionStore'
import type { PluginDevAgentEvent, PluginDevAgentPhase } from './types'
import type { ToolDeclaration, ToolHandler, ToolPack } from '../../agent-platform/toolHost'
import { truncateUnicode } from '@shared/unicodeText'

function phaseForTool(name: string): PluginDevAgentPhase {
  if (name === 'browser') return 'working'
  if (name === 'plugin_dry_run') return 'checking'
  if (name === 'ask_user') return 'waiting_user'
  return 'working'
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
  if (name === 'plugin_dry_run') return 'plugin.test'
  if (name === 'browser') return 'browser.interact'
  return 'plugin.write'
}

function effect(name: string): ToolDeclaration['effect'] {
  if (name === 'browser' || name === 'plugin_dry_run') return 'network'
  return 'write'
}

function resourceKey(name: string): string | undefined {
  if (name === 'ask_user') return 'plugin-draft'
  return undefined
}

function redact(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'browser' && args.action === 'fill' && typeof args.text === 'string') {
    return { ...args, text: `[redacted ${args.text.length} chars]` }
  }
  return args
}

export const PLUGIN_DEVELOPER_TOOL_PACK: ToolPack = {
  ref: 'toolpack:plugin-developer:v11',
  tools: PLUGIN_DEV_TOOL_SCHEMAS.map(({ function: tool }) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    schema: tool.parameters,
    capability: capability(tool.name),
    effect: effect(tool.name),
    executionMode: 'sequential',
    timeoutMs: tool.name === 'plugin_dry_run'
      ? 360_000
      : tool.name === 'browser' ? 60_000 : 120_000,
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
      async ({ args, progress, signal }) => {
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
        const isBrowserTool = tool.name === 'browser'
        if (isBrowserTool) {
          session.discoveryToolCalls += 1
        }
        const result = await executeTool(
          input.domainSessionId,
          tool.name,
          JSON.stringify(args),
          step,
          { signal, emit: input.emit }
        )
        for (const event of result.events ?? []) input.emit(event)
        const resultEvent: PluginDevAgentEvent = {
          type: 'tool_result',
          sessionId: input.domainSessionId,
          step,
          tool: tool.name,
          ok: result.ok,
          summary: truncateUnicode(result.content, 240),
          detail: result.content
        }
        input.emit(resultEvent)
        if (result.waitForUser) {
          session.status = 'waiting_user'
          session.phase = 'waiting_user'
        }
        const summary = Array.from(result.content).length > 240
          ? truncateUnicode(result.content, 240, '…')
          : result.content
        return {
          ok: result.ok,
          content: result.content,
          summary,
          terminate: Boolean(result.waitForUser),
          recovery: {
            structured: result.structured,
            waitForUser: result.waitForUser,
            events: result.events
          }
        }
      }
    ])
  )
}
