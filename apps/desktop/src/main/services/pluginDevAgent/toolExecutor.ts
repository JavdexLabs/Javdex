import type {
  PluginDevAgentEvent,
  PluginDevBrowserInteractionReason,
  PluginDevPendingUserRequest
} from '@shared/pluginDevTypes'
import { resolveScrapeProxyUrl } from '@shared/settingsTypes'
import { getSettings } from '../../settings/settingsStore'
import {
  isScrapeBrowserBusyError,
  isScrapeBrowserActionUncertainError,
  isScrapeBrowserChallengeError,
  isScrapeBrowserObservationPendingError,
  scrapeBrowser,
  type AgentBrowserCommand,
  type ScrapeBrowserLease
} from '../../scrapers/scrapeBrowser'
import {
  fingerprintValue,
  getSession,
  invalidateExecution
} from './sessionStore'
import type { ToolExecutionResult } from './types'
import {
  isPluginExecutionCloudflareInterruption,
  isPluginExecutionUnmatchedTargets,
  pluginExecution,
  pluginRunTargetFingerprint
} from './pluginExecution'
import {
  pluginRunAcceptance,
  projectPluginRunAcceptance
} from './pluginRunAcceptance'
import { pluginWorkspace } from './pluginWorkspace'
import {
  PluginDevRunTargetInputError,
  resolveRunTargetsFromArgs,
  runTargetLabel
} from '@shared/pluginDevKindProfile'
import {
  pluginBrowserCapability,
  boundedJson,
  type PluginBrowserAction
} from './browserCapability'

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function toolError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {}
): ToolExecutionResult {
  return { ok: false, content: JSON.stringify({ code, message, ...extra }, null, 2) }
}

interface PluginDevBrowserLeaseState {
  lease: ScrapeBrowserLease
  controller: AbortController
}

const pluginDevBrowserLeases = new Map<string, PluginDevBrowserLeaseState>()

async function pluginDevBrowserLease(
  sessionId: string,
  signal?: AbortSignal
): Promise<PluginDevBrowserLeaseState> {
  const existing = pluginDevBrowserLeases.get(sessionId)
  if (existing) {
    if (existing.controller.signal.aborted) {
      pluginDevBrowserLeases.delete(sessionId)
      await existing.lease.release()
    } else {
      return existing
    }
  }
  signal?.throwIfAborted()
  const controller = new AbortController()
  const lease = await scrapeBrowser.acquire({
    ownerId: `plugin-dev:${sessionId}`,
    purpose: 'agent-browser',
    proxyUrl: resolveScrapeProxyUrl(getSettings()),
    signal: controller.signal
  })
  const state: PluginDevBrowserLeaseState = { lease, controller }
  pluginDevBrowserLeases.set(sessionId, state)
  return state
}

export async function releasePluginDeveloperBrowser(sessionId: string): Promise<void> {
  pluginBrowserCapability.reset(sessionId)
  const state = pluginDevBrowserLeases.get(sessionId)
  if (!state) return
  pluginDevBrowserLeases.delete(sessionId)
  await state.lease.release()
  state.controller.abort(new Error('PluginDeveloper operation settled'))
}

export function requiresPluginDeveloperBrowserLease(
  request: PluginDevPendingUserRequest | undefined
): boolean {
  return request?.type === 'browser_interaction'
}

function browserInteractionPrompt(reason: PluginDevBrowserInteractionReason): string {
  switch (reason) {
    case 'human_verification':
      return '请在已保留的浏览器窗口中完成人机验证，然后点击「我已完成，继续」。'
    case 'login':
      return '当前页面需要登录。请只在已保留的浏览器窗口中完成登录，然后点击「我已完成，继续」。不要在对话中发送账号、密码或验证码。'
    case 'required_user_action':
      return '当前页面需要你亲自在已保留的浏览器窗口中完成必要操作。完成后点击「我已完成，继续」。'
  }
}

function createBrowserInteractionRequest(input: {
  sessionId: string
  step: number
  reason: PluginDevBrowserInteractionReason
  url?: string
}): PluginDevPendingUserRequest {
  return {
    requestId: `browser-interaction:${fingerprintValue(input)}`,
    type: 'browser_interaction',
    reason: input.reason,
    prompt: browserInteractionPrompt(input.reason),
    ...(input.url ? { url: input.url } : {})
  }
}

export async function runWithPluginDeveloperBrowser<T>(
  sessionId: string,
  signal: AbortSignal,
  run: () => Promise<T>
): Promise<T> {
  const state = await pluginDevBrowserLease(sessionId, signal)
  const onAbort = (): void => state.controller.abort(
    signal.reason instanceof Error ? signal.reason : new Error('插件检查已取消')
  )
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await scrapeBrowser.runWithLease(state.lease, run)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function pendingUserResult(
  session: NonNullable<ReturnType<typeof getSession>>,
  request: PluginDevPendingUserRequest,
  step: number,
  events: PluginDevAgentEvent[],
  structured: Record<string, unknown> = {}
): ToolExecutionResult {
  session.pendingUserRequest = request
  session.status = 'waiting_user'
  session.phase = 'waiting_user'
  events.push({ type: 'user_input_required', sessionId: session.id, step, request })
  return {
    ok: true,
    content: JSON.stringify({
      code: 'USER_INPUT_REQUIRED',
      requestId: request.requestId,
      requestType: request.type,
      message: request.prompt,
      ...structured
    }, null, 2),
    structured: {
      code: 'USER_INPUT_REQUIRED',
      requestId: request.requestId,
      requestType: request.type,
      ...structured
    },
    pendingUserRequest: request,
    waitForUser: request.prompt,
    events
  }
}

async function executeBrowserHandoff(input: {
  session: NonNullable<ReturnType<typeof getSession>>
  sessionId: string
  step: number
  reason: PluginDevBrowserInteractionReason
  events: PluginDevAgentEvent[]
  signal?: AbortSignal
}): Promise<ToolExecutionResult> {
  const { session, sessionId, step, reason, events, signal } = input
  const state = await pluginDevBrowserLease(sessionId, signal)
  const onAbort = (): void => state.controller.abort(
    signal?.reason instanceof Error ? signal.reason : new Error('浏览器交接已取消')
  )
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const presentation = await state.lease.presentToUser()
    const request = createBrowserInteractionRequest({
      sessionId,
      step,
      reason,
      url: presentation.url
    })
    return pendingUserResult(session, request, step, events, {
      reason,
      url: presentation.url,
      title: presentation.title
    })
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

async function executeBrowserAction(input: {
  session: NonNullable<ReturnType<typeof getSession>>
  sessionId: string
  step: number
  action: PluginBrowserAction
  args: Record<string, unknown>
  events: PluginDevAgentEvent[]
  signal?: AbortSignal
}): Promise<ToolExecutionResult> {
  const { session, sessionId, step, action, args, events, signal } = input
  const state = await pluginDevBrowserLease(sessionId, signal)
  const onAbort = (): void => state.controller.abort(
    signal?.reason instanceof Error ? signal.reason : new Error('浏览器操作已取消')
  )
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let command: AgentBrowserCommand
    const target = typeof args.target === 'string' ? args.target.trim() : ''
    switch (action) {
      case 'open': {
        const url = typeof args.url === 'string' ? args.url.trim() : ''
        if (!url) return toolError('BROWSER_URL_REQUIRED', 'browser action=open 时 url 必填。')
        command = {
          action,
          url,
          ...(typeof args.readySelector === 'string' ? { readySelector: args.readySelector } : {}),
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: Math.round(args.timeoutMs) } : {})
        }
        break
      }
      case 'snapshot':
        command = {
          action,
          ...(target ? { target } : {}),
          ...(typeof args.depth === 'number' ? { depth: Math.round(args.depth) } : {}),
          ...(typeof args.boxes === 'boolean' ? { boxes: args.boxes } : {})
        }
        break
      case 'find':
        command = {
          action,
          ...(typeof args.text === 'string' ? { text: args.text } : {}),
          ...(typeof args.regex === 'string' ? { regex: args.regex } : {})
        }
        break
      case 'html':
        command = {
          action,
          ...(target ? { target } : {}),
          maxLength: typeof args.maxLength === 'number'
            ? Math.min(session.limits.maxHtmlChars, Math.round(args.maxLength))
            : session.limits.maxHtmlChars
        }
        break
      case 'evaluate':
        command = {
          action,
          expression: typeof args.expression === 'string' ? args.expression : '',
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: Math.round(args.timeoutMs) } : {})
        }
        break
      case 'click':
        if (!target) return toolError('BROWSER_TARGET_REQUIRED', 'browser action=click 时 target 必填。')
        command = { action, target }
        break
      case 'fill':
        if (!target) return toolError('BROWSER_TARGET_REQUIRED', 'browser action=fill 时 target 必填。')
        command = {
          action,
          target,
          text: typeof args.text === 'string' ? args.text : '',
          submit: args.submit === true
        }
        break
      case 'press':
        command = {
          action,
          key: typeof args.key === 'string' ? args.key : 'Enter',
          ...(target ? { target } : {})
        }
        break
      case 'scroll': {
        const direction = args.direction
        if (direction !== 'up' && direction !== 'down' && direction !== 'start') {
          return toolError(
            'BROWSER_SCROLL_DIRECTION_INVALID',
            'browser action=scroll 时 direction 必须为 up、down 或 start。'
          )
        }
        if (direction === 'start') {
          if (args.amount !== undefined) {
            return toolError(
              'BROWSER_SCROLL_AMOUNT_INVALID',
              'browser action=scroll 且 direction=start 时不得提供 amount。'
            )
          }
          command = { action, direction, ...(target ? { target } : {}) }
          break
        }
        const amount = args.amount
        if (
          amount !== undefined &&
          amount !== 'eighth-viewport' &&
          amount !== 'quarter-viewport' &&
          amount !== 'half-viewport' &&
          amount !== 'viewport'
        ) {
          return toolError(
            'BROWSER_SCROLL_AMOUNT_INVALID',
            'browser action=scroll 的 amount 必须为 eighth-viewport、quarter-viewport、half-viewport 或 viewport。'
          )
        }
        command = {
          action,
          direction,
          ...(target ? { target } : {}),
          ...(amount ? { amount } : {})
        }
        break
      }
      case 'wait':
        command = {
          action,
          ...(target ? { target } : {}),
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: Math.round(args.timeoutMs) } : {})
        }
        break
      case 'status':
        command = { action }
        break
    }
    try {
      const observation = await state.lease.agentAction(command)
      const { fullSnapshot, ...compact } = observation
      return {
        ok: true,
        content: '',
        structured: { observation: compact, ...(fullSnapshot ? { fullSnapshot } : {}) }
      }
    } catch (error) {
      if (isScrapeBrowserActionUncertainError(error)) {
        return toolError(error.code, error.message, {
          url: error.url,
          documentRevision: error.documentRevision,
          staleRefs: true,
          nextAction: 'snapshot_or_status'
        })
      }
      if (isScrapeBrowserObservationPendingError(error)) {
        return toolError(error.code, error.message, {
          url: error.url,
          documentRevision: error.documentRevision,
          nextAction: 'snapshot'
        })
      }
      if (!isScrapeBrowserChallengeError(error)) throw error
      const request = createBrowserInteractionRequest({
        sessionId,
        step,
        reason: 'human_verification',
        url: error.url
      })
      return pendingUserResult(session, request, step, events, {
        challengeCode: error.code,
        reason: 'human_verification',
        url: error.url,
        title: error.title
      })
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function executeTool(
  sessionId: string,
  toolName: string,
  rawArgs: string,
  step: number,
  context: { signal?: AbortSignal; emit?: (event: PluginDevAgentEvent) => void } = {}
): Promise<ToolExecutionResult> {
  const session = getSession(sessionId)
  if (!session) return toolError('SESSION_NOT_FOUND', '会话不存在。')
  const args = parseToolArgs(rawArgs)
  const events: PluginDevAgentEvent[] = []

  try {
    context.signal?.throwIfAborted()
    if (toolName === 'browser') {
      if (!session.workspaceDirectory) return toolError('WORKSPACE_NOT_READY', '插件工作区尚未初始化。')
      const action = typeof args.action === 'string' ? args.action : undefined
      if (!action || !['open', 'snapshot', 'find', 'html', 'evaluate', 'click', 'fill', 'press', 'scroll', 'wait', 'status', 'read-section', 'handoff'].includes(action)) {
        return toolError('BROWSER_ACTION_INVALID', 'browser.action 无效。')
      }
      const { action: _action, ...browserArgs } = args
      if (action === 'read-section') {
        const artifactRef = typeof browserArgs.artifactRef === 'string'
          ? browserArgs.artifactRef.trim()
          : ''
        const section = typeof browserArgs.section === 'string'
          ? browserArgs.section.trim()
          : ''
        const cursor = typeof browserArgs.cursor === 'string'
          ? browserArgs.cursor
          : undefined
        if (!artifactRef || !section) {
          return toolError(
            'BROWSER_ARTIFACT_SECTION_INPUT_INVALID',
            'browser action=read-section 时必须提供 artifactRef 和 section。'
          )
        }
        return pluginBrowserCapability.readSection({
          workspaceDirectory: session.workspaceDirectory,
          artifactRef,
          section,
          ...(cursor ? { cursor } : {})
        })
      }
      if (action === 'handoff') {
        const reason = typeof browserArgs.reason === 'string' ? browserArgs.reason : ''
        if (!['human_verification', 'login', 'required_user_action'].includes(reason)) {
          return toolError(
            'BROWSER_HANDOFF_REASON_INVALID',
            'browser action=handoff 时 reason 必须为 human_verification、login 或 required_user_action。'
          )
        }
        return executeBrowserHandoff({
          session,
          sessionId,
          step,
          reason: reason as PluginDevBrowserInteractionReason,
          events,
          signal: context.signal
        })
      }
      const browserAction = action as PluginBrowserAction
      return await pluginBrowserCapability.execute({
        sessionId,
        workspaceDirectory: session.workspaceDirectory,
        action: browserAction,
        args: browserArgs,
        run: () => executeBrowserAction({
          session,
          sessionId,
          step,
          action: browserAction,
          args: browserArgs,
          events,
          signal: context.signal
        })
      })
    }

    if (toolName === 'plugin_dry_run') {
      if (!session.workspaceDirectory) return toolError('WORKSPACE_NOT_READY', '插件工作区尚未初始化。')
      const previousWorkspaceError = session.workspaceDraftError
      let workspace: ReturnType<typeof pluginWorkspace.snapshot>
      try {
        workspace = pluginWorkspace.snapshot(session.workspaceDirectory)
      } catch (error) {
        const message =
          `插件工作区当前无效：${error instanceof Error ? error.message : String(error)}。` +
          '请修复 plugin.json 或 index.js 后重试。'
        session.workspaceDraftError = message
        invalidateExecution(session)
        pluginWorkspace.updateCurrentAcceptance(session.workspaceDirectory, {
          installReady: false,
          reasons: ['workspace_invalid']
        })
        events.push({
          type: 'workspace_status',
          sessionId,
          step,
          valid: false,
          message
        })
        return { ...toolError('WORKSPACE_INVALID', message), events }
      }
      if (previousWorkspaceError) {
        session.workspaceDraftError = undefined
        events.push({
          type: 'workspace_status',
          sessionId,
          step,
          valid: true,
          message: '插件工作区已恢复为合法状态。'
        })
      }
      session.package = workspace.package
      let requested: ReturnType<typeof resolveRunTargetsFromArgs>
      try {
        requested = resolveRunTargetsFromArgs(session.kind, args, session.runTargets)
      } catch (error) {
        if (error instanceof PluginDevRunTargetInputError) {
          return toolError(error.code, error.message)
        }
        throw error
      }
      if (requested.targets.length === 0) {
        return toolError(
          'RUN_TARGET_REQUIRED',
          session.kind === 'video'
            ? 'task.json 没有运行目标。请先从精确详情页提取番号，再用 videoCodes 调用 plugin_dry_run。'
            : 'task.json 没有运行目标。请先从精确资料页提取演员主名，再用 actresses 调用 plugin_dry_run。'
        )
      }
      const replacesUnmatchedTargets = requested.explicit &&
        session.runTargets.length > 0 &&
        session.lastExecution != null &&
        pluginRunTargetFingerprint(session.lastExecution.targets) ===
          pluginRunTargetFingerprint(session.runTargets) &&
        isPluginExecutionUnmatchedTargets(session.lastExecution)
      const adoptsDiscoveredTargets =
        (requested.explicit && session.runTargets.length === 0) || replacesUnmatchedTargets
      if (adoptsDiscoveredTargets) {
        pluginWorkspace.updateRunTargets(session.workspaceDirectory, requested.targets)
        session.runTargets = structuredClone(requested.targets)
        const targetDecision = pluginRunAcceptance.evaluate({
          package: workspace.package,
          targets: session.runTargets,
          execution: session.lastExecution
        })
        pluginWorkspace.updateCurrentAcceptance(
          session.workspaceDirectory,
          projectPluginRunAcceptance(targetDecision)
        )
        invalidateExecution(session)
        const event: PluginDevAgentEvent = {
          type: 'run_targets_updated',
          sessionId,
          step,
          runTargets: structuredClone(session.runTargets)
        }
        if (context.emit) context.emit(event)
        else events.push(event)
      }
      const dryRunSignal = context.signal ?? new AbortController().signal
      const coversSessionTargets = session.runTargets.length > 0 &&
        pluginRunTargetFingerprint(requested.targets) === pluginRunTargetFingerprint(session.runTargets)
      const scope = requested.explicit && !adoptsDiscoveredTargets && !coversSessionTargets
        ? 'targeted'
        : 'all'
      const execution = await runWithPluginDeveloperBrowser(sessionId, dryRunSignal, async () =>
        pluginExecution.run({
          package: workspace.package,
          targets: requested.targets,
          scope,
          reportsDirectory: workspace.files.reportsDirectory,
          signal: dryRunSignal
        })
      )
      if (isPluginExecutionCloudflareInterruption(execution)) {
        const message = '生产运行被 Cloudflare 验证中断。请完成验证后使用“继续 Agent”。'
        session.status = 'waiting_user'
        session.phase = 'waiting_user'
        events.push({ type: 'execution_updated', sessionId, step, execution })
        events.push({ type: 'waiting_user', sessionId, step, reason: message })
        return {
          ok: true,
          content: boundedJson({
            code: 'BROWSER_CHALLENGE_INTERRUPTED',
            message,
            scope: execution.scope,
            cases: execution.cases.map((item) => ({
              runtimeInput: item.target,
              error: item.error,
              logs: item.logs.slice(-20)
            })),
            reportPath: execution.reportPath
          }, 32_000),
          structured: { code: 'BROWSER_CHALLENGE_INTERRUPTED' },
          waitForUser: message,
          events
        }
      }
      events.push({ type: 'execution_updated', sessionId, step, execution })
      const acceptanceDecision = pluginRunAcceptance.evaluate({
        package: workspace.package,
        targets: session.runTargets,
        execution
      })
      if (scope === 'all') {
        session.lastExecution = execution
        session.acceptance = acceptanceDecision.outcome
        if (acceptanceDecision.outcome) {
          events.push({
            type: 'acceptance_updated',
            sessionId,
            step,
            outcome: acceptanceDecision.outcome
          })
        }
        const currentAcceptance = pluginRunAcceptance.evaluate({
          package: workspace.package,
          targets: session.runTargets,
          execution: session.lastExecution
        })
        pluginWorkspace.recordLatestDryRun(session.workspaceDirectory, {
          schemaVersion: 1,
          status: 'completed',
          artifactHash: execution.artifactHash,
          reportPath: execution.reportPath,
          scope: execution.scope,
          runtimeVersion: execution.runtimeVersion,
          targetFingerprint: execution.targetFingerprint,
          executionPassed: execution.executionPassed,
          cases: execution.cases.map((item) => ({
            runtimeInput: item.target,
            runtimeAccepted: item.runtimeAccepted,
            pluginResult: item.pluginResult,
            effectiveResult: item.effectiveResult,
            manifestCoverage: item.manifestCoverage,
            unrecognizedResultKeys: item.unrecognizedResultKeys ?? [],
            error: item.error
          })),
          currentAcceptance: projectPluginRunAcceptance(currentAcceptance)
        })
      }
      const compact = {
        executionPassed: execution.executionPassed,
        scope: execution.scope,
        runtimeVersion: execution.runtimeVersion,
        cases: execution.cases.map((item) => ({
          runtimeInput: item.target,
          runtimeAccepted: item.runtimeAccepted,
          pluginResult: item.pluginResult,
          effectiveResult: item.effectiveResult,
          manifestCoverage: item.manifestCoverage,
          unrecognizedResultKeys: item.unrecognizedResultKeys ?? [],
          error: item.error,
          logs: item.logs.slice(-20)
        })),
        artifactHash: execution.artifactHash,
        targetFingerprint: execution.targetFingerprint,
        mechanicalAcceptance: {
          installReady: acceptanceDecision.ready,
          reasons: acceptanceDecision.reasons
        },
        reportPath: execution.reportPath,
        adoptedTargets: adoptsDiscoveredTargets
      }
      return {
        ok: true,
        content: boundedJson(compact, 32_000, {
          executionPassed: execution.executionPassed,
          targets: execution.targets.map(runTargetLabel),
          artifactHash: execution.artifactHash,
          mechanicalAcceptance: {
            installReady: acceptanceDecision.ready,
            reasons: acceptanceDecision.reasons
          },
          message: '完整 dry-run 结果过大；可从 execution_updated 事件或结果面板查看。'
        }),
        structured: {
          executionPassed: execution.executionPassed,
          targetCount: execution.targets.length,
          artifactHash: execution.artifactHash,
          mechanicalAcceptance: {
            installReady: acceptanceDecision.ready,
            reasons: acceptanceDecision.reasons
          },
          adoptedTargets: adoptsDiscoveredTargets
        },
        events
      }
    }

    if (toolName === 'ask_user') {
      const question = typeof args.question === 'string' ? args.question.trim() : ''
      if (!question) return toolError('QUESTION_REQUIRED', 'question 必填。')
      const options = Array.isArray(args.options)
        ? args.options.flatMap((item) => {
            if (!item || typeof item !== 'object') return []
            const record = item as Record<string, unknown>
            const id = typeof record.id === 'string' ? record.id.trim() : ''
            const label = typeof record.label === 'string' ? record.label.trim() : ''
            if (!id || !label) return []
            return [{
              id,
              label,
              description: typeof record.description === 'string' ? record.description.trim() : undefined
            }]
          })
        : []
      const evidenceRefs = Array.isArray(args.evidenceRefs)
        ? args.evidenceRefs.filter((ref): ref is string => typeof ref === 'string').slice(0, 12)
        : []
      const request: PluginDevPendingUserRequest = options.length > 0
        ? {
            requestId: `choice:${fingerprintValue({ sessionId, step, question, options, evidenceRefs })}`,
            type: 'choice',
            prompt: question,
            options,
            evidenceRefs
          }
        : {
            requestId: `freeform:${fingerprintValue({ sessionId, step, question })}`,
            type: 'freeform',
            prompt: question
          }
      return pendingUserResult(session, request, step, events)
    }

    return toolError('UNKNOWN_TOOL', `未知工具：${toolName}`)
  } catch (error) {
    if (context.signal?.aborted) {
      throw context.signal.reason instanceof Error ? context.signal.reason : new Error('工具执行已取消')
    }
    if (isScrapeBrowserBusyError(error)) {
      const message = '刮削浏览器正被其他任务占用；本次 Agent operation 已终止，请稍后由用户继续，不要自动重试。'
      session.status = 'waiting_user'
      session.phase = 'waiting_user'
      events.push({ type: 'waiting_user', sessionId, step, reason: message })
      return {
        ...toolError(error.code, message, {
        activePurpose: error.purpose
        }),
        waitForUser: message,
        events
      }
    }
    return toolError('TOOL_ERROR', error instanceof Error ? error.message : String(error))
  }
}
