import { PLUGIN_DEV_TOOL_NAMES } from './toolSchemas'
import {
  fitTranscriptToContextBudget,
  summarizeToolForProgress
} from './contextCompress'
import {
  responseToAssistantTurn,
  systemTurn,
  toolResultsTurn,
  userTurn,
  type AgentLlmResponse,
  type AgentToolCall,
  type AgentTranscript
} from './agentMessages'
import { requestAgentToolChat } from '../llm/agentToolChatClient'
import { buildAgentSystemPrompt, buildContinueUserMessage, buildInitialUserMessage } from './prompts'
import { hasSubstantialPluginCode } from './pluginDevCodePolicy'
import { buildDryRunToolArgs } from '@shared/pluginDevKindProfile'
import {
  cancelSession,
  createSession,
  getSession,
  hashCode,
  isDryRunStaleForVerify,
  markSessionEnded
} from './sessionStore'
import { executeTool } from './toolExecutor'
import { isBlockingVerificationFailure } from '../pluginDevVerification'
import type {
  PluginDevAgentMessageInput,
  PluginDevAgentPhase,
  PluginDevAgentProgressCallback,
  PluginDevAgentSessionResult,
  PluginDevAgentStartInput
} from './types'

export interface AgentRunnerDeps {
  requestChat: (
    transcript: AgentTranscript,
    options?: { retryOnce?: boolean }
  ) => Promise<AgentLlmResponse>
  executeToolFn: typeof executeTool
}

let runnerDeps: AgentRunnerDeps = {
  requestChat: requestAgentToolChat,
  executeToolFn: executeTool
}

export function __setRunnerDepsForTest(deps: Partial<AgentRunnerDeps>): void {
  runnerDeps = { ...runnerDeps, ...deps }
}

export function __resetRunnerDepsForTest(): void {
  runnerDeps = {
    requestChat: requestAgentToolChat,
    executeToolFn: executeTool
  }
}

function verificationPassed(session: NonNullable<ReturnType<typeof getSession>>): boolean {
  const report = session.lastVerification
  if (!report) return false
  const bad = report.items.filter((item) => isBlockingVerificationFailure(item))
  return bad.length === 0
}

function canFinishSuccess(session: NonNullable<ReturnType<typeof getSession>>): boolean {
  return Boolean(session.lastDryRun?.ok) && verificationPassed(session)
}

function isDebugLikeMode(input: Pick<PluginDevAgentStartInput, 'mode'>): boolean {
  return input.mode !== 'create'
}

function verificationFailurePrompt(
  session: NonNullable<ReturnType<typeof getSession>>
): string | null {
  if (!session.lastVerification || isDryRunStaleForVerify(session)) return null
  const bad = session.lastVerification.items.filter((item) =>
    isBlockingVerificationFailure(item)
  )
  if (bad.length === 0) return null
  const hash = hashCode(JSON.stringify(bad))
  if (session.lastVerificationPromptHash === hash) return null
  session.lastVerificationPromptHash = hash
  return `验证未通过：${session.lastVerification.summary}\n${bad
    .map(
      (item) =>
        `- ${item.field} [${item.status}]: ${item.note}${
          item.pageHint ? ` 应为 ${item.pageHint}` : ''
        }`
    )
    .join('\n')}`
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function phaseForTool(toolName: string): PluginDevAgentPhase {
  if (toolName.startsWith('browser_')) return 'discover'
  if (toolName === 'plugin_update_code' || toolName === 'plugin_update_package') {
    return 'implement'
  }
  if (toolName === 'plugin_dry_run') return 'dry_run'
  if (toolName === 'plugin_verify') return 'verify'
  if (toolName === 'plugin_finish' || toolName === 'plugin_install') return 'finish'
  if (toolName === 'session_request_user') return 'waiting_user'
  return 'discover'
}

function updatePhase(
  sessionId: string,
  step: number,
  phase: PluginDevAgentPhase,
  onProgress?: PluginDevAgentProgressCallback
): void {
  const session = getSession(sessionId)
  if (!session || session.phase === phase) return
  session.phase = phase
  onProgress?.({ type: 'phase_updated', sessionId, step, phase })
}

async function executeToolWithProgress(
  sessionId: string,
  step: number,
  toolName: string,
  rawArgs: string,
  onProgress?: PluginDevAgentProgressCallback
): Promise<import('./types').ToolExecutionResult> {
  const args = parseToolArgs(rawArgs)
  updatePhase(sessionId, step, phaseForTool(toolName), onProgress)
  onProgress?.({
    type: 'tool_start',
    sessionId,
    step,
    tool: toolName,
    args
  })

  const result = await runnerDeps
    .executeToolFn(sessionId, toolName, rawArgs, step)
    .catch((err: unknown): import('./types').ToolExecutionResult => ({
      ok: false,
      content: err instanceof Error ? err.message : String(err)
    }))
  const summaryText =
    result.structured?.summary != null
      ? String(result.structured.summary)
      : result.content.slice(0, 240)

  onProgress?.({
    type: 'tool_result',
    sessionId,
    step,
    tool: toolName,
    ok: result.ok,
    summary: summaryText,
    detail: result.content.length > 500 ? result.content.slice(0, 500) + '…' : result.content
  })

  for (const event of result.events ?? []) {
    onProgress?.(event)
  }

  return result
}

function addTokenUsage(
  session: NonNullable<ReturnType<typeof getSession>>,
  response: AgentLlmResponse
): void {
  if (typeof response.usage?.totalTokens !== 'number') return
  session.totalTokens += Math.max(0, Math.round(response.usage.totalTokens))
}

function buildInitialDebugDryRunArgs(
  session: NonNullable<ReturnType<typeof getSession>>
): Record<string, unknown> {
  return buildDryRunToolArgs(session.testTargets ?? [])
}

async function runInitialDebugDryRun(
  sessionId: string,
  onProgress?: PluginDevAgentProgressCallback
): Promise<string | null> {
  const session = getSession(sessionId)
  if (!session || session.mode === 'create') return null

  const step = 0
  const tool = 'plugin_dry_run'
  const args = buildInitialDebugDryRunArgs(session)
  const result = await executeToolWithProgress(
    sessionId,
    step,
    tool,
    JSON.stringify(args),
    onProgress
  )
  if (!result.ok) {
    return `AI调试启动 dry-run：失败\n${result.content}`
  }
  const verifyResult = await executeToolWithProgress(sessionId, step, 'plugin_verify', '{}', onProgress)
  return `AI调试启动 dry-run：成功\n${result.content}\n\n自动语义验证：\n${verifyResult.content}`
}

async function runToolCalls(
  sessionId: string,
  step: number,
  toolCalls: AgentToolCall[],
  onProgress?: PluginDevAgentProgressCallback
): Promise<{
  turn: AgentTranscript[number] | null
  shouldStop: boolean
  success?: boolean
  summary?: string
}> {
  const results: Array<{ callId: string; content: string; isError?: boolean }> = []
  let shouldStop = false
  let success: boolean | undefined
  let summary: string | undefined

  for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
    const liveSession = getSession(sessionId)
    if (liveSession?.cancelRequested) {
      results.push(
        ...toolCalls.slice(callIndex).map((call) => ({
          callId: call.id,
          content: '（工具未执行：用户已终止）'
        }))
      )
      shouldStop = true
      break
    }

    const call = toolCalls[callIndex]
    const toolName = call.name
    if (!PLUGIN_DEV_TOOL_NAMES.has(toolName)) {
      results.push({ callId: call.id, content: `未知工具：${toolName}`, isError: true })
      continue
    }

    const result = await executeToolWithProgress(sessionId, step, toolName, call.arguments, onProgress)

    if (toolName === 'plugin_finish' && result.finish) {
      const session = getSession(sessionId)
      if (!session) {
        results.push({ callId: call.id, content: '会话不存在，无法结束任务', isError: true })
        results.push(
          ...toolCalls.slice(callIndex + 1).map((item) => ({
            callId: item.id,
            content: '（工具未执行：会话已丢失）'
          }))
        )
        break
      }
      if (result.finish.success && !canFinishSuccess(session)) {
        results.push({
          callId: call.id,
          content:
            '拒绝结束：plugin_finish(success=true) 要求 lastDryRun.ok 且 plugin_verify 无失败项。请继续修复。',
          isError: true
        })
        continue
      }
      shouldStop = true
      success = result.finish.success && canFinishSuccess(session)
      summary = result.finish.summary
      session.status = success ? 'completed' : 'failed'
      results.push({
        callId: call.id,
        content: success ? '任务完成' : '任务结束但未通过验证'
      })
      continue
    }

    if (result.waitForUser) {
      shouldStop = true
      const waitSession = getSession(sessionId)
      if (waitSession) waitSession.status = 'waiting_user'
      results.push({ callId: call.id, content: result.content })
      results.push(
        ...toolCalls.slice(callIndex + 1).map((item) => ({
          callId: item.id,
          content: '（工具未执行：已暂停等待用户操作）'
        }))
      )
      break
    }

    let content = result.content
    let isError = !result.ok
    if (toolName === 'plugin_dry_run' && result.ok) {
      const verifyResult = await executeToolWithProgress(sessionId, step, 'plugin_verify', '{}', onProgress)
      content = `${content}\n\n自动语义验证：\n${verifyResult.content}`
    }
    results.push({ callId: call.id, content, isError })
  }

  return {
    turn: results.length ? toolResultsTurn(results) : null,
    shouldStop,
    success,
    summary
  }
}

async function runAgentLoop(
  sessionId: string,
  transcript: AgentTranscript,
  onProgress?: PluginDevAgentProgressCallback
): Promise<PluginDevAgentSessionResult> {
  const session = getSession(sessionId)
  if (!session) throw new Error('会话不存在')

  let finishSummary = 'Agent 结束'
  let finishSuccess = false
  let hitStepLimit = false
  const maxSteps = session.limits.maxSteps
  onProgress?.({ type: 'phase_updated', sessionId, step: 0, phase: session.phase })

  for (let step = 1; ; step += 1) {
    if (maxSteps > 0 && step > maxSteps) {
      hitStepLimit = true
      session.step = maxSteps
      break
    }

    session.step = step
    if (session.cancelRequested) {
      session.status = 'cancelled'
      break
    }

    onProgress?.({ type: 'step_start', sessionId, step })
    const fitted = fitTranscriptToContextBudget(
      transcript,
      step,
      session.limits.maxContextTokens,
      session.totalTokens
    )
    onProgress?.({
      type: 'context_updated',
      sessionId,
      step,
      stats: fitted.stats
    })
    transcript = fitted.transcript

    let response: AgentLlmResponse
    try {
      response = await runnerDeps.requestChat(transcript)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isToolPairError =
        message.includes('tool_call_id') ||
        message.includes('tool_calls') ||
        message.includes('tool messages') ||
        message.includes('tool_use') ||
        message.includes('tool_result')

      if (!isToolPairError) throw err

      const repaired = fitTranscriptToContextBudget(
        transcript,
        step,
        session.limits.maxContextTokens,
        session.totalTokens
      )
      transcript = repaired.transcript
      response = await runnerDeps.requestChat(repaired.transcript, { retryOnce: false })
    }

    addTokenUsage(session, response)
    onProgress?.({
      type: 'context_updated',
      sessionId,
      step,
      stats: { ...fitted.stats, totalTokens: session.totalTokens }
    })

    if (session.cancelRequested) {
      session.status = 'cancelled'
      break
    }

    if (response.text?.trim()) {
      onProgress?.({
        type: 'assistant_text',
        sessionId,
        step,
        text: response.text.trim()
      })
    }

    transcript.push(responseToAssistantTurn(response))

    if (!response.toolCalls?.length) {
      if (session.status === 'waiting_user') break
      transcript.push(
        userTurn('请继续使用工具推进：探测页面、更新 code、dry-run、verify，不要只输出文字。')
      )
      continue
    }

    const toolRun = await runToolCalls(sessionId, step, response.toolCalls, onProgress)
    if (toolRun.turn) transcript.push(toolRun.turn)
    transcript = fitTranscriptToContextBudget(
      transcript,
      step,
      session.limits.maxContextTokens,
      session.totalTokens
    ).transcript

    if (session.cancelRequested) {
      session.status = 'cancelled'
      break
    }

    if (session.duplicateDryRunCount >= session.limits.maxDuplicateDryRun) {
      transcript.push(
        userTurn(
          '警告：连续多次 dry-run 结果相同且仍未通过验证。必须更换 selector 或解析逻辑，禁止重复相同 code。'
        )
      )
      session.duplicateDryRunCount = 0
    }

    const codeHash = hashCode(session.package.code)
    if (session.lastCodeHash === codeHash && step > 2) {
      transcript.push(userTurn('警告：code 与上一轮相同，必须实质修改 parse 逻辑。'))
    }
    session.lastCodeHash = codeHash

    const verificationPrompt = verificationFailurePrompt(session)
    if (verificationPrompt) {
      transcript.push(userTurn(verificationPrompt))
    }

    if (toolRun.shouldStop) {
      finishSuccess = toolRun.success === true
      finishSummary = toolRun.summary || finishSummary
      break
    }
  }

  const finalSession = getSession(sessionId)
  if (!finalSession) throw new Error('会话已丢失')

  if (finalSession.status === 'cancelled') {
    finishSummary = '用户已终止'
    finishSuccess = false
  } else if (finalSession.status === 'running') {
    finalSession.status = finishSuccess ? 'completed' : 'failed'
    if (!finishSuccess && hitStepLimit && finalSession.limits.maxSteps > 0) {
      finishSummary = `已达 ${finalSession.limits.maxSteps} 步上限`
    } else if (!finishSuccess && finishSummary === 'Agent 结束') {
      finishSummary = 'Agent 已中断'
    }
  }

  finalSession.transcript = transcript
  if (finalSession.status !== 'waiting_user') {
    markSessionEnded(sessionId)
  }

  onProgress?.({
    type: 'done',
    sessionId,
    step: finalSession.step,
    success: finishSuccess,
    summary: finishSummary,
    package: finalSession.package,
    dryRun: finalSession.lastDryRun,
    verification: finalSession.lastVerification
  })

  return {
    sessionId,
    status: finalSession.status,
    package: finalSession.package,
    dryRun: finalSession.lastDryRun,
    verification: finalSession.lastVerification,
    summary: finishSummary
  }
}

export async function startPluginDevAgent(
  input: PluginDevAgentStartInput,
  onProgress?: PluginDevAgentProgressCallback
): Promise<PluginDevAgentSessionResult> {
  const session = createSession(input)
  if (input.lastDryRun) {
    session.lastDryRun = input.lastDryRun
    session.lastDryRunCodeHash = hashCode(session.package.code)
  }
  if (
    hasSubstantialPluginCode(session.kind, session.package.code) &&
    (isDebugLikeMode(input) || input.package)
  ) {
    session.incrementalEditOnly = true
  }
  const initialDebugDryRun =
    isDebugLikeMode(input) ? await runInitialDebugDryRun(session.id, onProgress) : null
  const transcript: AgentTranscript = [
    systemTurn(buildAgentSystemPrompt(input.kind)),
    userTurn(
      [buildInitialUserMessage(input, session), initialDebugDryRun ? `\n${initialDebugDryRun}` : ''].join('')
    )
  ]

  try {
    return await runAgentLoop(session.id, transcript, onProgress)
  } catch (err) {
    session.status = 'failed'
    const message = err instanceof Error ? err.message : String(err)
    onProgress?.({
      type: 'error',
      sessionId: session.id,
      step: session.step,
      message
    })
    throw err
  }
}

export async function continuePluginDevAgent(
  input: PluginDevAgentMessageInput,
  onProgress?: PluginDevAgentProgressCallback
): Promise<PluginDevAgentSessionResult> {
  const session = getSession(input.sessionId)
  if (!session) throw new Error('会话不存在')
  if (session.status === 'running') {
    throw new Error('Agent 仍在运行中')
  }
  session.status = 'running'
  session.cancelRequested = false
  session.endedAt = undefined

  if (input.lastDryRun) {
    session.lastDryRun = input.lastDryRun
    session.lastDryRunCodeHash = hashCode(session.package.code)
  }

  session.lastUserInstruction = input.text.trim() || session.lastUserInstruction

  if (hasSubstantialPluginCode(session.kind, session.package.code)) {
    session.incrementalEditOnly = true
    session.phase = 'implement'
  }

  const userContent = buildContinueUserMessage(input.text, session)

  const transcript: AgentTranscript = session.transcript?.length
    ? [...session.transcript, userTurn(userContent)]
    : [systemTurn(buildAgentSystemPrompt(session.kind)), userTurn(userContent)]

  try {
    return await runAgentLoop(session.id, transcript, onProgress)
  } catch (err) {
    session.status = 'failed'
    const message = err instanceof Error ? err.message : String(err)
    onProgress?.({
      type: 'error',
      sessionId: session.id,
      step: session.step,
      message
    })
    throw err
  }
}

export function cancelPluginDevAgent(sessionId: string): void {
  cancelSession(sessionId)
}

export { summarizeToolForProgress }
