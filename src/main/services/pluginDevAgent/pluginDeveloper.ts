import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readTestUserDataPath } from '@shared/appIdentity'
import { sanitizeUnicodeScalars, truncateUnicode } from '@shared/unicodeText'
import type {
  PluginDevAgentEvent,
  PluginDevFrozenModelSummary,
  PluginDevAgentMessageInput,
  PluginDevAgentSnapshot,
  PluginDevAgentSessionResult,
  PluginDevAgentStartInput,
  PluginDevAgentWorkLogEntry,
  PluginDevPendingApproval,
  PluginDevRunTarget,
  PluginDevUserResponse,
  PluginExecutionArtifact
} from '@shared/pluginDevTypes'
import { agentConfiguration } from '../../agent-platform/agentConfiguration'
import { agentExecution } from '../../agent-platform/agentExecution'
import { agentRunStore, type AgentRunStatus } from '../../agent-platform/agentRunStore'
import { createCacheAffinityId } from '../../agent-platform/cacheAffinity'
import { modelControlPlane } from '../../agent-platform/modelControlPlane'
import { toolHost } from '../../agent-platform/toolHost'
import type {
  AgentRunId,
  HostedToolBinding,
  PersistedRunConfigurationSnapshot,
  ResolvedRunConfiguration,
  RuntimeDurableObservation,
  RuntimeObservation,
  NormalizedModelUsage,
  PiNativeToolName
} from '../../agent-platform/types'
import { hasSubstantialPluginCode } from './pluginDevCodePolicy'
import { buildContinuation, buildRunInstructionSet } from './pluginDevInstructions'
import {
  appendWorkLogEvent,
  appendWorkLogUserMessage
} from './workLog'
import {
  cancelSession,
  createSession,
  deleteSession,
  fingerprintValue,
  hashCode,
  invalidateExecution
} from './sessionStore'
import { createPluginDeveloperToolHandlers } from './toolPack'
import type { PluginDevSession } from './types'
import { pluginArtifactHash } from './pluginArtifact'
import { isPluginExecutionUnmatchedTargets } from './pluginExecution'
import { pluginWorkspace } from './pluginWorkspace'
import {
  pluginRunAcceptance,
  projectPluginRunAcceptance,
  type PluginRunAcceptanceProjection
} from './pluginRunAcceptance'
import {
  releasePluginDeveloperBrowser
} from './toolExecutor'

interface PluginDeveloperProductState extends Record<string, unknown> {
  schemaVersion: 7
  input: PluginDevAgentStartInput
  status: PluginDevSession['status']
  phase: PluginDevSession['phase']
  step: number
  totalTokens: number
  usageByRole?: PluginDevSession['usageByRole']
  contextInputTokens?: number
  modelTurnCount: number
  discoveryToolCalls: number
  runTargets: PluginDevRunTarget[]
  package: PluginDevSession['package']
  workspaceDraftError?: string
  lastUserInstruction?: string
  lastExecution?: PluginDevSession['lastExecution']
  acceptance?: PluginDevSession['acceptance']
  pendingUserRequest?: PluginDevSession['pendingUserRequest']
  endedAt?: number
  failureMessage?: string
  summary: string
  workLog: PluginDevAgentWorkLogEntry[]
  recoveryBlocked?: boolean
}

interface LegacyPluginDeveloperProductState extends Record<string, unknown> {
  schemaVersion: 5 | 6
  lastExecution?: Record<string, unknown>
}

function persistCurrentAcceptance(
  session: PluginDevSession,
  projection: PluginRunAcceptanceProjection
): void {
  if (!session.workspaceDirectory) return
  try {
    pluginWorkspace.updateCurrentAcceptance(session.workspaceDirectory, projection)
  } catch (error) {
    console.error('[plugin-dev] failed to persist current acceptance projection', error)
  }
}

function invalidateRecoverableExecution(
  session: PluginDevSession,
  projection: PluginRunAcceptanceProjection
): void {
  invalidateExecution(session)
  persistCurrentAcceptance(session, projection)
}

function legacyExecutionForDisplay(value: unknown): PluginExecutionArtifact | undefined {
  if (!value || typeof value !== 'object') return undefined
  const execution = value as Record<string, unknown>
  if (!Array.isArray(execution.targets) || !Array.isArray(execution.cases)) return undefined
  const scope = execution.scope === 'targeted' ? 'targeted' : execution.scope === 'all' ? 'all' : undefined
  if (!scope) return undefined
  const cases = execution.cases.flatMap((rawCase) => {
    if (!rawCase || typeof rawCase !== 'object') return []
    const item = rawCase as Record<string, unknown>
    if (!item.target || typeof item.target !== 'object') return []
    const legacyProjectionKeys = Array.isArray(item.droppedResultKeys)
      ? item.droppedResultKeys.filter((key): key is string => typeof key === 'string')
      : []
    return [{
      target: structuredClone(item.target) as PluginDevRunTarget,
      pluginResult: (item.pluginResult ?? null) as PluginExecutionArtifact['cases'][number]['pluginResult'],
      effectiveResult: (item.effectiveResult ?? null) as PluginExecutionArtifact['cases'][number]['effectiveResult'],
      manifestCoverage: {
        returnedFieldIds: [],
        undeclaredReturnedFieldIds: [],
        runtimeOnlyKeys: []
      },
      ...(legacyProjectionKeys.length > 0 ? { legacyProjectionKeys } : {}),
      logs: Array.isArray(item.logs)
        ? item.logs.filter((log): log is string => typeof log === 'string')
        : [],
      ...(typeof item.error === 'string' ? { error: item.error } : {}),
      runtimeAccepted: item.runtimeAccepted === true
    }]
  })
  return {
    runtimeVersion: typeof execution.runtimeVersion === 'string' ? execution.runtimeVersion : 'runtime-v1',
    artifactHash: typeof execution.artifactHash === 'string' ? execution.artifactHash : '',
    targetFingerprint: typeof execution.targetFingerprint === 'string' ? execution.targetFingerprint : '',
    scope,
    targets: structuredClone(execution.targets) as PluginDevRunTarget[],
    cases,
    executionPassed: execution.executionPassed === true,
    reportPath: typeof execution.reportPath === 'string' ? execution.reportPath : '',
    cached: execution.cached === true
  }
}

interface ActivePluginRun {
  input: PluginDevAgentStartInput
  session: PluginDevSession
  tools: readonly HostedToolBinding[]
  emit?: (event: PluginDevAgentEvent) => void
  assistantText: string
  reasoningText: string
  reasoningTruncated: boolean
  pendingAssistantDelta: string
  pendingReasoningDelta: string
  streamFlushTimer?: ReturnType<typeof setTimeout>
  summary: string
  frozenModel?: PluginDevFrozenModelSummary
  lastAssistantStopReason?: string
  waiter?: {
    resolve: (result: PluginDevAgentSessionResult) => void
  }
}

const PI_NATIVE_FILE_TOOLS = new Set<PiNativeToolName>([
  'read', 'write', 'edit', 'grep', 'find', 'ls'
])
const PI_NATIVE_DRAFT_MUTATION_TOOLS = new Set<PiNativeToolName>(['write', 'edit'])
const MAX_REASONING_DISPLAY_CHARS = 64_000
const MODEL_STREAM_FLUSH_MS = 40

function agentSessionDirectory(runId: string): string {
  const root = readTestUserDataPath() ?? app.getPath('userData')
  return path.join(root, 'agent-sessions', runId)
}

function workspaceSkillHashes(session: PluginDevSession): Record<string, string> {
  if (!session.workspaceDirectory) throw new Error('插件工作区尚未初始化')
  const files = pluginWorkspace.filePaths(session.workspaceDirectory)
  return {
    'javdex-plugin-dev': createHash('sha256').update(fs.readFileSync(files.pluginSkill, 'utf8')).digest('hex'),
    'javdex-browser-operation': createHash('sha256').update(fs.readFileSync(files.browserSkill, 'utf8')).digest('hex')
  }
}

/** The installed package is the draft of record, including display-only rename at install. */
function persistInstalledPackage(
  directory: string | undefined,
  packageInput: PluginDevSession['package']
): void {
  if (!directory || !fs.existsSync(path.join(directory, 'plugin.json'))) return
  try {
    pluginWorkspace.writePackage(directory, packageInput)
  } catch (error) {
    console.error('[plugin-dev] failed to persist installed package onto workspace', error)
  }
}

function adoptInstalledPackage(
  session: PluginDevSession,
  packageInput: PluginDevSession['package'],
  startInput?: PluginDevAgentStartInput
): PluginDevSession['package'] {
  const installed = structuredClone(packageInput)
  session.package = installed
  session.siteName = installed.name
  if (startInput) startInput.siteName = installed.name
  persistInstalledPackage(session.workspaceDirectory, installed)
  return installed
}

function toProductState(
  session: PluginDevSession,
  input: PluginDevAgentStartInput,
  summary: string
): PluginDeveloperProductState {
  return {
    schemaVersion: 7,
    input: structuredClone(input),
    status: session.status,
    phase: session.phase,
    step: session.step,
    totalTokens: session.totalTokens,
    usageByRole: structuredClone(session.usageByRole),
    contextInputTokens: session.contextInputTokens,
    modelTurnCount: session.modelTurnCount,
    discoveryToolCalls: session.discoveryToolCalls,
    runTargets: structuredClone(session.runTargets),
    package: structuredClone(session.package),
    workspaceDraftError: session.workspaceDraftError,
    lastUserInstruction: session.lastUserInstruction,
    lastExecution: session.lastExecution ? structuredClone(session.lastExecution) : undefined,
    acceptance: session.acceptance
      ? structuredClone(session.acceptance)
      : undefined,
    pendingUserRequest: session.pendingUserRequest
      ? structuredClone(session.pendingUserRequest)
      : undefined,
    endedAt: session.endedAt,
    failureMessage: session.failureMessage,
    summary,
    workLog: structuredClone(session.workLog ?? [])
  }
}

function toResult(active: ActivePluginRun): PluginDevAgentSessionResult {
  const session = active.session
  return {
    sessionId: session.id,
    status: session.status,
    frozenModel: active.frozenModel ? structuredClone(active.frozenModel) : undefined,
    package: session.package,
    runTargets: structuredClone(session.runTargets),
    execution: session.lastExecution,
    acceptance: session.acceptance,
    summary: active.summary || (
      session.status === 'completed'
        ? '插件开发已完成'
        : session.status === 'waiting_user'
          ? '等待用户操作'
          : session.status === 'cancelled'
            ? '用户已终止'
            : 'Agent 已结束'
    )
  }
}

function frozenModelSummary(
  revision: string,
  model: PersistedRunConfigurationSnapshot['model']['descriptor']
): PluginDevFrozenModelSummary {
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    modelName: model.name,
    revision
  }
}

function runStatus(session: PluginDevSession): 'running' | 'waiting_user' | 'settled' | 'failed' | 'cancelled' {
  if (session.status === 'waiting_user') return 'waiting_user'
  if (session.status === 'completed') return 'settled'
  if (session.status === 'failed') return 'failed'
  if (session.status === 'cancelled') return 'cancelled'
  return 'running'
}

const PLUGIN_DEV_RECOVERABLE_RUN_STATUSES = new Set<AgentRunStatus>([
  'created',
  'running',
  'recovering',
  'waiting_user'
])

function isRecoverablePluginDevRunStatus(status: AgentRunStatus): boolean {
  return PLUGIN_DEV_RECOVERABLE_RUN_STATUSES.has(status)
}

export class PluginDeveloper {
  private readonly active = new Map<string, ActivePluginRun>()
  private readonly releases = new Map<string, {
    active: ActivePluginRun | undefined
    promise: Promise<void>
  }>()

  private materializeWorkspace(
    session: PluginDevSession,
    input: PluginDevAgentStartInput,
    resourcePolicy: 'refresh' | 'preserve-frozen' = 'refresh'
  ): void {
    session.workspaceDirectory = agentSessionDirectory(session.id)
    const openWorkspace = () => pluginWorkspace.open({
        directory: session.workspaceDirectory!,
        task: {
          ...input,
          supportedFields: session.supportedFields,
          testTargets: input.testTargets
        },
        package: session.package,
        resourcePolicy
      })
    let snapshot
    try {
      snapshot = openWorkspace()
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException
      if (fileError.code) throw error
      // Keep both the invalid file for Pi to repair and the last valid product-state package.
      // This also upgrades old runs whose result keys were previously filtered silently.
      session.workspaceDraftError =
        `插件工作区当前无效，请检查 plugin.json 或 index.js：${error instanceof Error ? error.message : String(error)}`
      invalidateRecoverableExecution(session, {
        installReady: false,
        reasons: ['workspace_invalid']
      })
      return
    }
    session.package = snapshot.package
  }

  private syncWorkspaceDraft(active: ActivePluginRun): boolean {
    if (!active.session.workspaceDirectory) throw new Error('插件工作区尚未初始化')
    const wasInvalid = Boolean(active.session.workspaceDraftError)
    const snapshot = pluginWorkspace.snapshot(active.session.workspaceDirectory)
    const changed = fingerprintValue(snapshot.package) !== fingerprintValue(active.session.package)
    const runtimeChanged = pluginArtifactHash(snapshot.package) !== pluginArtifactHash(active.session.package)
    active.session.workspaceDraftError = undefined
    if (changed) {
      active.session.package = snapshot.package
      if (runtimeChanged) {
        const stale = pluginRunAcceptance.evaluate({
          package: snapshot.package,
          targets: active.session.runTargets,
          execution: active.session.lastExecution
        })
        invalidateRecoverableExecution(
          active.session,
          projectPluginRunAcceptance(stale)
        )
      }
      this.emitDomainEvent(active, {
        type: 'package_updated',
        sessionId: active.session.id,
        step: active.session.step,
        package: active.session.package
      })
    }
    if (wasInvalid) {
      active.summary = '插件工作区已恢复为合法状态。'
      this.emitDomainEvent(active, {
        type: 'workspace_status',
        sessionId: active.session.id,
        step: active.session.step,
        valid: true,
        message: active.summary
      })
    }
    return changed
  }

  private async waitForPriorRelease(runId: string): Promise<void> {
    await this.releases.get(runId)?.promise
  }

  private releaseRunResources(
    runId: string,
    expectedActive = this.active.get(runId)
  ): Promise<void> {
    const existing = this.releases.get(runId)
    if (existing && existing.active === expectedActive) return existing.promise
    if (existing) {
      return existing.promise.then(() => this.releaseRunResources(runId, expectedActive))
    }
    if (expectedActive && this.active.get(runId) !== expectedActive) return Promise.resolve()

    // Discard approval capabilities synchronously, before the potentially slow runtime dispose.
    // A terminal snapshot must never expose a permit that can be consumed by a later lazy reopen.
    toolHost.discardApprovals(runId)
    toolHost.disposeRun(runId)
    if (expectedActive?.streamFlushTimer) clearTimeout(expectedActive.streamFlushTimer)
    if (expectedActive) {
      expectedActive.streamFlushTimer = undefined
      expectedActive.pendingAssistantDelta = ''
      expectedActive.pendingReasoningDelta = ''
    }
    const promise = (async () => {
      try {
        await Promise.all([
          releasePluginDeveloperBrowser(runId),
          agentExecution.releaseRun(runId)
        ])
      } finally {
        if (!expectedActive || this.active.get(runId) === expectedActive) {
          this.active.delete(runId)
          deleteSession(runId)
        }
      }
    })()
    const release = { active: expectedActive, promise }
    this.releases.set(runId, release)
    void promise.finally(() => {
      if (this.releases.get(runId) === release) this.releases.delete(runId)
    }).catch(() => undefined)
    return promise
  }

  private scheduleTerminalRelease(active: ActivePluginRun): void {
    if (!['completed', 'failed', 'cancelled'].includes(active.session.status)) return
    const runId = active.session.id
    void this.releaseRunResources(runId, active).catch((error) => {
      console.error('[plugin-dev] failed to release terminal run resources', error)
    })
  }

  private pendingApprovalViews(
    runId: string,
    workLog: readonly PluginDevAgentWorkLogEntry[]
  ): PluginDevPendingApproval[] {
    return toolHost.pendingApprovals(runId).map((pending) => {
      const event = [...workLog]
        .reverse()
        .find(
          (entry): entry is Extract<PluginDevAgentWorkLogEntry, { kind: 'event' }> =>
            entry.kind === 'event' &&
            entry.event.type === 'approval_required' &&
            entry.event.requestId === pending.requestId
        )?.event
      return event?.type === 'approval_required'
        ? {
            requestId: event.requestId,
            tool: event.tool,
            args: structuredClone(event.args),
            reason: event.reason
          }
        : {
            requestId: pending.requestId,
            tool: pending.toolName,
            args: {},
            reason: `工具 ${pending.toolName} 需要你确认后才能执行。`
          }
    })
  }

  private emitDomainEvent(active: ActivePluginRun, event: PluginDevAgentEvent): void {
    appendWorkLogEvent(active.session.id, event)
    active.emit?.(event)
    const record = agentRunStore.getRun(active.session.id)
    if (record) {
      agentRunStore.appendProductEvent(active.session.id, record.activeOperationId, `plugin.${event.type}`, event)
      if (event.type === 'done' && event.success) {
        agentRunStore.recordArtifact({
          runId: active.session.id,
          operationId: record.activeOperationId,
          kind: 'plugin-package',
          label: event.package.name || active.input.siteName,
          ref: {
            productStatePath: 'package',
            codeHash: hashCode(event.package.code),
            pluginKind: active.session.kind
          }
        })
      }
      agentRunStore.updateProductState(
        active.session.id,
        runStatus(active.session),
        toProductState(active.session, active.input, active.summary)
      )
    }
  }

  private failRun(active: ActivePluginRun, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const firstFailedTransition = active.session.status !== 'failed'
    active.session.status = 'failed'
    active.session.endedAt = Date.now()
    active.session.failureMessage = message
    active.summary = message
    if (firstFailedTransition) {
      this.emitDomainEvent(active, {
        type: 'error',
        sessionId: active.session.id,
        step: active.session.step,
        message
      })
    }
  }

  private flushStreamDeltas(active: ActivePluginRun, turn = active.session.modelTurnCount + 1): void {
    if (active.streamFlushTimer) clearTimeout(active.streamFlushTimer)
    active.streamFlushTimer = undefined
    const reasoningDelta = active.pendingReasoningDelta
    const assistantDelta = active.pendingAssistantDelta
    active.pendingReasoningDelta = ''
    active.pendingAssistantDelta = ''
    if (reasoningDelta) {
      active.emit?.({
        type: 'assistant_reasoning_delta',
        sessionId: active.session.id,
        step: active.session.step,
        turn,
        delta: reasoningDelta
      })
    }
    if (assistantDelta) {
      active.emit?.({
        type: 'assistant_text_delta',
        sessionId: active.session.id,
        step: active.session.step,
        turn,
        delta: assistantDelta
      })
    }
  }

  private scheduleStreamFlush(active: ActivePluginRun): void {
    if (active.streamFlushTimer) return
    active.streamFlushTimer = setTimeout(() => {
      active.streamFlushTimer = undefined
      this.flushStreamDeltas(active)
    }, MODEL_STREAM_FLUSH_MS)
  }

  private runtimeNotify(active: ActivePluginRun, event: RuntimeObservation): void {
    if (event.type === 'assistant.delta') {
      const safe = sanitizeUnicodeScalars(event.text)
      active.assistantText += safe
      active.pendingAssistantDelta += safe
      this.scheduleStreamFlush(active)
    }
    if (event.type === 'reasoning.delta') {
      const safe = sanitizeUnicodeScalars(event.text)
      const available = Math.max(
        0,
        MAX_REASONING_DISPLAY_CHARS - Array.from(active.reasoningText).length
      )
      const visible = truncateUnicode(safe, available)
      active.reasoningText += visible
      active.pendingReasoningDelta += visible
      if (visible !== safe) active.reasoningTruncated = true
      if (visible) this.scheduleStreamFlush(active)
    }
    if (event.type === 'tool.progress') {
      // Tool-specific start/result events carry the durable detail; progress stays ephemeral.
    }
  }

  private recordModelUsage(active: ActivePluginRun, usage: NormalizedModelUsage): void {
    const session = active.session
    const role = usage.role
    session.usageByRole ??= {}
    const current = session.usageByRole[role] ?? {
      uncachedInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      totalTokens: 0
    }
    session.usageByRole[role] = {
      uncachedInput: current.uncachedInput + usage.uncachedInput,
      cacheRead: current.cacheRead + usage.cacheRead,
      cacheWrite: current.cacheWrite + usage.cacheWrite,
      output: current.output + usage.output,
      reasoning: current.reasoning + usage.reasoning,
      totalTokens: current.totalTokens + usage.totalTokens
    }
    if (role === 'primary') session.contextInputTokens = usage.totalInput
    session.totalTokens += Math.max(0, Math.round(usage.totalTokens))
    this.emitContextUpdated(active)
  }

  private emitContextUpdated(active: ActivePluginRun): void {
    const session = active.session
    session.usageByRole ??= {}
    const totals = Object.values(session.usageByRole).reduce(
      (sum, item) => ({
        uncachedInput: sum.uncachedInput + (item?.uncachedInput ?? 0),
        cacheRead: sum.cacheRead + (item?.cacheRead ?? 0),
        cacheWrite: sum.cacheWrite + (item?.cacheWrite ?? 0),
        output: sum.output + (item?.output ?? 0),
        reasoning: sum.reasoning + (item?.reasoning ?? 0)
      }),
      { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
    )
    this.emitDomainEvent(active, {
      type: 'context_updated',
      sessionId: session.id,
      step: session.step,
      stats: {
        messageCount: session.modelTurnCount,
        originalChars: 0,
        compressedChars: 0,
        savedChars: 0,
        estimatedTokens: session.contextInputTokens ?? 0,
        totalTokens: session.totalTokens,
        maxTokens: session.limits.maxContextTokens,
        overBudget: (session.contextInputTokens ?? 0) > session.limits.maxContextTokens,
        inputTokens: totals.uncachedInput,
        outputTokens: totals.output,
        reasoningTokens: totals.reasoning,
        cacheReadTokens: totals.cacheRead,
        cacheWriteTokens: totals.cacheWrite,
        usageByRole: structuredClone(session.usageByRole)
      }
    })
  }

  private runtimeProject(
    active: ActivePluginRun,
    event: RuntimeDurableObservation
  ): { state: PluginDeveloperProductState; status?: 'running' | 'waiting_user' | 'settled' | 'failed' | 'cancelled' } {
    const session = active.session
    if (event.type === 'message.completed' && event.audit.role === 'assistant') {
      const turn = session.modelTurnCount + 1
      session.modelTurnCount = turn
      this.flushStreamDeltas(active, turn)
      active.lastAssistantStopReason = event.audit.stopReason
      const reasoning = active.reasoningText.trim()
      if (reasoning) {
        const reasoningCharCount = Math.max(
          event.audit.reasoningChars ?? 0,
          Array.from(reasoning).length
        )
        this.emitDomainEvent(active, {
          type: 'assistant_reasoning',
          sessionId: session.id,
          step: session.step,
          turn,
          text: reasoning,
          charCount: reasoningCharCount,
          truncated: active.reasoningTruncated
        })
      }
      this.emitDomainEvent(active, {
        type: 'model_turn_completed',
        sessionId: session.id,
        step: session.step,
        stopReason: event.audit.stopReason,
        rawStopReason: event.audit.rawStopReason,
        textChars: event.audit.textChars ?? 0,
        reasoningChars: event.audit.reasoningChars ?? 0,
        toolCallCount: event.audit.toolCallCount ?? 0
      })
      const text = active.assistantText.trim() || event.audit.textPreview.trim()
      if (text) {
        active.summary = text.slice(-500)
        const assistantEvent: PluginDevAgentEvent = {
          type: 'assistant_text',
          sessionId: session.id,
          step: session.step,
          turn,
          text
        }
        this.emitDomainEvent(active, assistantEvent)
      }
      active.assistantText = ''
      active.reasoningText = ''
      active.reasoningTruncated = false
      active.pendingAssistantDelta = ''
      active.pendingReasoningDelta = ''
    }
    if (event.type === 'usage') {
      this.recordModelUsage(active, event.usage)
    }
    if (
      event.type === 'compaction.changed'
      && event.phase === 'end'
      && typeof event.result?.tokensAfter === 'number'
      && Number.isFinite(event.result.tokensAfter)
    ) {
      session.contextInputTokens = Math.max(0, Math.round(event.result.tokensAfter))
      this.emitContextUpdated(active)
    }
    if (event.type === 'tool.started' && PI_NATIVE_FILE_TOOLS.has(event.call.toolName as PiNativeToolName)) {
      this.emitDomainEvent(active, {
        type: 'tool_start',
        sessionId: session.id,
        step: session.step,
        tool: event.call.toolName,
        args: { argsDigest: event.call.argsDigest }
      })
    }
    if (event.type === 'tool.completed') {
      if (PI_NATIVE_FILE_TOOLS.has(event.result.toolName as PiNativeToolName)) {
        this.emitDomainEvent(active, {
          type: 'tool_result',
          sessionId: session.id,
          step: session.step,
          tool: event.result.toolName,
          ok: event.result.ok,
          summary: event.result.summary
        })
      }
      if (PI_NATIVE_DRAFT_MUTATION_TOOLS.has(event.result.toolName as PiNativeToolName)) {
        try {
          this.syncWorkspaceDraft(active)
        } catch (error) {
          const firstInvalidObservation = !session.workspaceDraftError
          session.workspaceDraftError =
            `插件工作区当前无效，请检查 plugin.json 或 index.js：${error instanceof Error ? error.message : String(error)}`
          invalidateRecoverableExecution(session, {
            installReady: false,
            reasons: ['workspace_invalid']
          })
          active.summary = session.workspaceDraftError
          if (firstInvalidObservation) {
            this.emitDomainEvent(active, {
              type: 'workspace_status',
              sessionId: session.id,
              step: session.step,
              valid: false,
              message: active.summary
            })
          }
        }
      }
    }
    if (event.type === 'runtime.fault') {
      this.failRun(active, event.message)
    }
    if (event.type === 'limit.reached' && session.status === 'running') {
      this.settleAgentTurn(
        active,
        `Agent 已达到本次模型轮次上限（${event.current}/${event.limit}），可继续当前会话。`
      )
    }
    if (event.type === 'agent.settled') {
      if (session.status === 'running') {
        if (active.lastAssistantStopReason === 'length') {
          this.settleAgentTurn(
            active,
            '模型输出达到上限，自动续跑后仍未完成；可继续当前会话。'
          )
        } else {
          this.settleAgentTurn(active)
        }
      }
      const waiter = active.waiter
      active.waiter = undefined
      waiter?.resolve(toResult(active))
      this.scheduleTerminalRelease(active)
    }
    return {
      state: toProductState(session, active.input, active.summary),
      status: runStatus(session)
    }
  }

  private settleAgentTurn(active: ActivePluginRun, stoppedSummary?: string): void {
    const session = active.session
    if (session.status !== 'running') return
    try {
      this.syncWorkspaceDraft(active)
    } catch (error) {
      session.workspaceDraftError =
        `插件工作区当前无效，请检查 plugin.json 或 index.js：${error instanceof Error ? error.message : String(error)}`
      invalidateRecoverableExecution(session, {
        installReady: false,
        reasons: ['workspace_invalid']
      })
    }
    const existing = pluginRunAcceptance.evaluate({
      package: session.package,
      targets: session.runTargets,
      execution: session.lastExecution
    })
    persistCurrentAcceptance(session, projectPluginRunAcceptance(existing))
    session.acceptance = existing.outcome
    session.status = 'waiting_user'
    session.phase = existing.ready ? 'ready' : 'working'
    session.endedAt = undefined
    if (existing.outcome) {
      this.emitDomainEvent(active, {
        type: 'acceptance_updated',
        sessionId: session.id,
        step: session.step,
        outcome: existing.outcome
      })
    }
    active.summary = stoppedSummary ?? (
      existing.ready
        ? '当前草稿机械验收通过，可以安装；如需继续完善，请先输入具体反馈。'
        : session.workspaceDraftError
          ? `${session.workspaceDraftError} 请继续 Agent 修复后显式调用完整 plugin_dry_run。`
          : session.runTargets.length === 0
            ? 'Agent 本轮已停止；尚无运行目标，请继续 Agent 发现目标并显式调用完整 plugin_dry_run。'
            : session.lastExecution && isPluginExecutionUnmatchedTargets(session.lastExecution)
              ? 'Agent 本轮已停止；当前测试目标没有精确匹配，空结果不能安装。请继续 Agent，用站点上已观察的真实目标调用 plugin_dry_run。'
              : 'Agent 本轮已停止；当前草稿缺少匹配的完整机械验收，请继续 Agent 并显式调用完整 plugin_dry_run。'
    )
    this.emitDomainEvent(active, {
      type: 'waiting_user',
      sessionId: session.id,
      step: session.step,
      reason: active.summary
    })
  }

  private async resolvedConfiguration(
    runId: string,
    session: PluginDevSession,
    emit: (event: PluginDevAgentEvent) => void
  ) {
    const { revision, profile, definition } = agentConfiguration.getProfile('profile:plugin-developer:default')
    const primary = modelControlPlane.resolveWorkloadModel('plugin-developer')
    const summarizer = primary
    const tools = toolHost.registerRun({
      runId,
      profile,
      status: () => agentRunStore.getRun(runId)?.status ?? 'created',
      operationId: () => agentRunStore.getRun(runId)?.activeOperationId,
      handlers: createPluginDeveloperToolHandlers({
        domainSessionId: session.id,
        step: () => session.step,
        emit
      }),
      onApprovalRequired: (request) => {
        session.status = 'waiting_user'
        session.phase = 'waiting_user'
        const reason = `工具 ${request.toolName} 需要你确认后才能执行。`
        emit({
          type: 'approval_required',
          sessionId: session.id,
          step: session.step,
          requestId: request.requestId,
          tool: request.toolName,
          args: { pluginName: session.package.name, ...request.args },
          reason
        })
        emit({ type: 'waiting_user', sessionId: session.id, step: session.step, reason })
      },
      singlePendingApproval: true
    })
    const systemText = definition.systemPrompt
    const cache = {
      primaryAffinityId: createCacheAffinityId(runId, 'primary', primary.routeRevision),
      verifierAffinityId: createCacheAffinityId(runId, 'verifier', 'disabled'),
      summarizerAffinityId: createCacheAffinityId(runId, 'summarizer', summarizer.routeRevision),
      retention: {
        primary: primary.preset.cacheRetention,
        verifier: 'none' as const,
        summarizer: summarizer.preset.cacheRetention
      }
    }
    return {
      revision,
      definitionId: 'plugin-developer',
      profile,
      model: primary,
      cache,
      systemPrompt: {
        text: systemText,
        sha256: createHash('sha256').update(systemText).digest('hex')
      },
      tools,
      settings: {
        compaction: profile.compaction,
        retry: { enabled: true, maxRetries: 3, baseDelayMs: 1_000 },
        maxTurns: session.limits.maxSteps
      },
      resources: {
        nativeTools: ['read', 'write', 'edit', 'grep', 'find', 'ls'] as PiNativeToolName[],
        skillNames: ['javdex-plugin-dev', 'javdex-browser-operation'],
        skillHashes: workspaceSkillHashes(session)
      },
      sessionDirectory: agentSessionDirectory(runId)
    }
  }

  private restoreSession(
    runId: AgentRunId,
    state: PluginDeveloperProductState
  ): PluginDevSession {
    if (state.schemaVersion !== 7 || !state.input || !state.package) {
      throw new Error('PluginDeveloper 产品快照版本不兼容')
    }
    const session = createSession(state.input, runId)
    session.status = state.status
    session.phase = state.phase
    session.step = state.step
    session.totalTokens = state.totalTokens
    session.usageByRole = structuredClone(state.usageByRole ?? {})
    session.contextInputTokens = state.contextInputTokens ?? 0
    session.modelTurnCount = state.modelTurnCount ?? 0
    session.discoveryToolCalls = state.discoveryToolCalls ?? 0
    session.runTargets = structuredClone(state.runTargets ?? [])
    session.package = structuredClone(state.package)
    session.workspaceDraftError = state.workspaceDraftError
    session.lastUserInstruction =
      state.lastUserInstruction ?? (state.input.userMessage?.trim() || undefined)
    session.lastExecution = state.lastExecution ? structuredClone(state.lastExecution) : undefined
    session.acceptance = state.acceptance ? structuredClone(state.acceptance) : undefined
    session.pendingUserRequest = state.pendingUserRequest
      ? structuredClone(state.pendingUserRequest)
      : undefined
    session.endedAt = state.endedAt
    session.failureMessage = state.failureMessage
    session.workLog = structuredClone(state.workLog ?? [])
    const acceptance = pluginRunAcceptance.evaluate({
      package: session.package,
      targets: session.runTargets,
      execution: session.lastExecution
    })
    persistCurrentAcceptance(session, projectPluginRunAcceptance(acceptance))
    if (!acceptance.ready) {
      session.lastExecution = undefined
      session.acceptance = undefined
    } else {
      session.acceptance = acceptance.outcome
    }
    return session
  }

  private restoredConfiguration(
    runId: string,
    snapshot: PersistedRunConfigurationSnapshot,
    session: PluginDevSession,
    emit: (event: PluginDevAgentEvent) => void
  ): ResolvedRunConfiguration {
    if (snapshot.definitionId !== 'plugin-developer') {
      throw new Error(`无法用 PluginDeveloper 恢复 Definition ${snapshot.definitionId}`)
    }
    const tools = toolHost.registerRun({
      runId,
      profile: snapshot.profile,
      status: () => agentRunStore.getRun(runId)?.status ?? 'closed',
      operationId: () => agentRunStore.getRun(runId)?.activeOperationId,
      handlers: createPluginDeveloperToolHandlers({
        domainSessionId: session.id,
        step: () => session.step,
        emit
      }),
      onApprovalRequired: (request) => {
        session.status = 'waiting_user'
        session.phase = 'waiting_user'
        const reason = `工具 ${request.toolName} 需要你确认后才能执行。`
        emit({
          type: 'approval_required',
          sessionId: session.id,
          step: session.step,
          requestId: request.requestId,
          tool: request.toolName,
          args: { pluginName: session.package.name, ...request.args },
          reason
        })
        emit({ type: 'waiting_user', sessionId: session.id, step: session.step, reason })
      },
      singlePendingApproval: true
    })
    const expectedTools = snapshot.tools.map((tool) => `${tool.name}:${tool.schemaHash}`)
    const restoredTools = tools.map((tool) => `${tool.name}:${tool.schemaHash}`)
    if (JSON.stringify(expectedTools) !== JSON.stringify(restoredTools)) {
      toolHost.disposeRun(runId)
      throw new Error('ToolPack 已变化，拒绝热恢复到不同工具契约')
    }
    return {
      revision: snapshot.revision,
      definitionId: snapshot.definitionId,
      profile: structuredClone(snapshot.profile),
      model: modelControlPlane.restoreAgentModel(snapshot.model),
      cache: structuredClone(snapshot.cache),
      systemPrompt: structuredClone(snapshot.systemPrompt),
      tools,
      settings: structuredClone(snapshot.settings),
      resources: structuredClone(snapshot.resources),
      sessionDirectory: agentSessionDirectory(runId)
    }
  }

  async restoreRecoverableRuns(): Promise<Array<{ runId: string; error: string }>> {
    const failures: Array<{ runId: string; error: string }> = []
    for (const record of agentRunStore.listRecoverableRuns()) {
      if (record.useCase !== 'plugin-developer' || this.active.has(record.id)) continue
      if (!isRecoverablePluginDevRunStatus(record.status)) continue
      let active: ActivePluginRun | undefined
      try {
        const state = record.productState as PluginDeveloperProductState
        if (state.recoveryBlocked) continue
        const session = this.restoreSession(record.id, state)
        this.materializeWorkspace(session, state.input, 'preserve-frozen')
        active = {
          input: structuredClone(state.input),
          session,
          tools: [],
          assistantText: '',
          reasoningText: '',
          reasoningTruncated: false,
          pendingAssistantDelta: '',
          pendingReasoningDelta: '',
          summary: state.summary || '已恢复 Agent 会话'
        }
        this.active.set(record.id, active)
        const resolved = this.restoredConfiguration(
          record.id,
          record.configSnapshot,
          session,
          (event) => this.emitDomainEvent(active!, event)
        )
        active.frozenModel = frozenModelSummary(
          record.configSnapshot.revision,
          record.configSnapshot.model.descriptor
        )
        active.tools = resolved.tools
        // Persist restore-time migrations before opening Pi. A healthy restored checkpoint is not
        // required to emit another durable observation, so relying on runtime projection here can
        // leave legacy verification/loop state in the durable product snapshot indefinitely.
        agentRunStore.updateProductState(
          record.id,
          runStatus(session),
          toProductState(session, state.input, active.summary)
        )
        const opened = await agentExecution.openRun({
          useCase: 'plugin-developer',
          resolved,
          productState: toProductState(session, state.input, active.summary),
          resume: record,
          notify: (event) => this.runtimeNotify(active!, event),
          project: (event) => this.runtimeProject(active!, event)
        })
        if (record.status === 'created' || record.status === 'running' || record.status === 'recovering' || opened.source === 'rebuilt') {
          agentRunStore.interruptAcceptedOperations(record.id, 'app-restart')
          session.status = 'waiting_user'
          session.phase = 'waiting_user'
          active.summary = opened.source === 'rebuilt'
            ? 'checkpoint 已从 ExecutionHistory 重建，请确认后继续'
            : '应用已恢复会话，请确认后继续'
          this.emitDomainEvent(active, {
            type: 'waiting_user',
            sessionId: record.id,
            step: session.step,
            reason: active.summary
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({ runId: record.id, error: message })
        toolHost.disposeRun(record.id)
        this.active.delete(record.id)
        agentRunStore.interruptAcceptedOperations(record.id, message)
        agentRunStore.updateProductState(record.id, 'failed', {
          ...record.productState,
          recoveryBlocked: true,
          recoveryError: message
        })
        agentRunStore.appendProductEvent(record.id, undefined, 'plugin.recovery_failed', { message })
      }
    }
    return failures
  }

  private async activatePersistedRun(runId: string): Promise<ActivePluginRun> {
    await this.waitForPriorRelease(runId)
    const existing = this.active.get(runId)
    if (existing) return existing
    const record = agentRunStore.getRun<PluginDeveloperProductState>(runId)
    if (!record || record.useCase !== 'plugin-developer') {
      throw new Error('会话不存在')
    }
    const state = record.productState
    if (state.schemaVersion !== 7 || state.recoveryBlocked) {
      throw new Error(state.recoveryBlocked ? '会话恢复已被阻止' : '会话快照版本不兼容')
    }
    const session = this.restoreSession(runId, state)
    try {
      this.materializeWorkspace(session, state.input, 'preserve-frozen')
    } catch (error) {
      deleteSession(runId)
      throw error
    }
    session.status = 'waiting_user'
    session.endedAt = undefined
    const active: ActivePluginRun = {
      input: structuredClone(state.input),
      session,
      tools: [],
      assistantText: '',
      reasoningText: '',
      reasoningTruncated: false,
      pendingAssistantDelta: '',
      pendingReasoningDelta: '',
      summary: state.summary || '已恢复 Agent 会话'
    }
    this.active.set(runId, active)
    try {
      const resolved = this.restoredConfiguration(
        runId,
        record.configSnapshot,
        session,
        (event) => this.emitDomainEvent(active, event)
      )
      active.frozenModel = frozenModelSummary(
        record.configSnapshot.revision,
        record.configSnapshot.model.descriptor
      )
      active.tools = resolved.tools
      agentRunStore.updateProductState(
        runId,
        'waiting_user',
        toProductState(session, state.input, active.summary)
      )
      await agentExecution.openRun({
        useCase: 'plugin-developer',
        resolved,
        productState: toProductState(session, state.input, active.summary),
        resume: { ...record, status: 'waiting_user' },
        notify: (event) => this.runtimeNotify(active, event),
        project: (event) => this.runtimeProject(active, event)
      })
      return active
    } catch (error) {
      await this.releaseRunResources(runId, active)
      throw error
    }
  }

  getSnapshot(sessionId?: string): PluginDevAgentSnapshot | null {
    const runId = sessionId ?? agentRunStore.findLatestRun<PluginDeveloperProductState>('plugin-developer')?.id
    if (!runId) return null
    const active = this.active.get(runId)
    if (!active) {
      const record = agentRunStore.getRun<PluginDeveloperProductState | LegacyPluginDeveloperProductState>(runId)
      const state = record?.productState
      if (!record || record.useCase !== 'plugin-developer' ||
          (state?.schemaVersion !== 5 && state?.schemaVersion !== 6 && state?.schemaVersion !== 7)) return null
      const legacyV5 = state.schemaVersion === 5
      const historicalReadOnly = state.schemaVersion !== 7
      const readable = state as unknown as PluginDeveloperProductState
      const execution = legacyV5
        ? legacyExecutionForDisplay(state.lastExecution)
        : readable.lastExecution ? structuredClone(readable.lastExecution) : undefined
      const workLog = structuredClone(readable.workLog ?? [])
      return {
        cursor: agentRunStore.readProductJournal(runId).at(-1)?.seq ?? 0,
        input: structuredClone(readable.input),
        result: {
          sessionId: runId,
          status: readable.status,
          frozenModel: frozenModelSummary(record.configSnapshot.revision, record.configSnapshot.model.descriptor),
          package: structuredClone(readable.package),
          runTargets: structuredClone(readable.runTargets),
          execution,
          acceptance: historicalReadOnly || !readable.acceptance
            ? undefined
            : structuredClone(readable.acceptance),
          historicalReadOnly,
          summary: readable.summary || 'Agent 已结束'
        },
        phase: readable.phase,
        step: readable.step,
        totalTokens: readable.totalTokens,
        events: workLog
          .filter((entry): entry is Extract<PluginDevAgentWorkLogEntry, { kind: 'event' }> =>
            entry.kind === 'event'
          )
          .map((entry) => structuredClone(entry.event)),
        workLog,
        pendingApprovals: this.pendingApprovalViews(runId, workLog),
        pendingUserRequest: readable.pendingUserRequest
          ? structuredClone(readable.pendingUserRequest)
          : undefined
      }
    }
    const journal = agentRunStore.readProductJournal(runId)
    return {
      cursor: journal.at(-1)?.seq ?? 0,
      input: structuredClone(active.input),
      result: structuredClone(toResult(active)),
      phase: active.session.phase,
      step: active.session.step,
      totalTokens: active.session.totalTokens,
      events: (active.session.workLog ?? [])
        .filter((entry): entry is Extract<PluginDevAgentWorkLogEntry, { kind: 'event' }> => entry.kind === 'event')
        .map((entry) => structuredClone(entry.event)),
      workLog: structuredClone(active.session.workLog ?? []),
      pendingApprovals: this.pendingApprovalViews(runId, active.session.workLog ?? []),
      pendingUserRequest: active.session.pendingUserRequest
        ? structuredClone(active.session.pendingUserRequest)
        : undefined
    }
  }

  /** User-driven installation gate; the Agent never receives installation capability. */
  assertReadyArtifact(sessionId: string, packageInput: PluginDevSession['package']): void {
    const active = this.active.get(sessionId)
    const record = active ? undefined : agentRunStore.getRun<PluginDeveloperProductState>(sessionId)
    if (!active && record?.productState.schemaVersion !== 7) {
      throw new Error('历史插件开发会话只读，不能用于当前安装门禁。')
    }
    const workspaceDraftError = active?.session.workspaceDraftError ?? record?.productState.workspaceDraftError
    if (workspaceDraftError) {
      throw new Error('插件工作区当前无效，请修复 plugin.json 或 index.js 后重新执行完整检查。')
    }
    const execution = active?.session.lastExecution ?? record?.productState.lastExecution
    const targets = active?.session.runTargets ?? record?.productState.runTargets ?? []
    const gate = pluginRunAcceptance.evaluate({ package: packageInput, targets, execution })
    if (!gate.ready) {
      throw new Error('当前插件未通过机械验收，或运行结果已过期，不能安装。')
    }
  }

  /** Project a successful user-driven installation into the Agent lifecycle. */
  markInstalled(sessionId: string, packageInput: PluginDevSession['package']): void {
    this.assertReadyArtifact(sessionId, packageInput)
    const active = this.active.get(sessionId)
    const installedAt = Date.now()
    const summary = '当前机械验收通过的插件版本已安装。'
    if (active) {
      const installed = adoptInstalledPackage(active.session, packageInput, active.input)
      active.session.status = 'completed'
      active.session.phase = 'ready'
      active.session.endedAt = installedAt
      active.summary = summary
      this.emitDomainEvent(active, {
        type: 'done',
        sessionId,
        step: active.session.step,
        success: true,
        summary,
        package: installed,
        execution: active.session.lastExecution,
        acceptance: active.session.acceptance
      })
      this.scheduleTerminalRelease(active)
      return
    }

    const record = agentRunStore.getRun<PluginDeveloperProductState>(sessionId)
    if (!record || record.useCase !== 'plugin-developer' || record.productState.schemaVersion !== 7) {
      throw new Error('插件开发会话不存在或版本不兼容')
    }
    const gate = pluginRunAcceptance.evaluate({
      package: packageInput,
      targets: record.productState.runTargets,
      execution: record.productState.lastExecution
    })
    const installed = structuredClone(packageInput)
    persistInstalledPackage(agentSessionDirectory(sessionId), installed)
    const nextState: PluginDeveloperProductState = {
      ...structuredClone(record.productState),
      status: 'completed',
      phase: 'ready',
      endedAt: installedAt,
      summary,
      package: installed,
      input: {
        ...structuredClone(record.productState.input),
        siteName: installed.name
      },
      acceptance: gate.outcome
    }
    agentRunStore.updateProductState(sessionId, 'settled', nextState)
    agentRunStore.appendProductEvent(sessionId, record.activeOperationId, 'plugin.done', {
      type: 'done',
      sessionId,
      step: nextState.step,
      success: true,
      summary,
      package: installed,
      execution: nextState.lastExecution,
      acceptance: nextState.acceptance
    })
    agentRunStore.recordArtifact({
      runId: sessionId,
      operationId: record.activeOperationId,
      kind: 'plugin-package',
      label: packageInput.name,
      ref: {
        productStatePath: 'package',
        codeHash: hashCode(packageInput.code),
        pluginKind: packageInput.kind
      }
    })
  }

  recordInstallationProjectionFailure(sessionId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    try {
      const record = agentRunStore.getRun(sessionId)
      agentRunStore.appendProductEvent(
        sessionId,
        record?.activeOperationId,
        'plugin.install_projection_failed',
        { message }
      )
    } catch (auditError) {
      console.error('[plugin-dev] failed to record installation projection error', auditError)
    }
  }

  private waitForSettled(active: ActivePluginRun): Promise<PluginDevAgentSessionResult> {
    if (active.waiter) throw new Error('Agent 仍在运行中')
    return new Promise((resolve) => { active.waiter = { resolve } })
  }

  private applyUserResponse(
    session: PluginDevSession,
    response: PluginDevUserResponse
  ): { prompt: string; transcriptText: string; updatesInstruction: boolean } {
    const pending = session.pendingUserRequest
    if (!pending) throw new Error('当前没有待处理的用户请求')
    if (pending.requestId !== response.requestId || pending.type !== response.type) {
      throw new Error('用户响应已过期、类型不匹配或属于其他会话')
    }
    if (pending.type === 'browser_challenge' && response.type === 'browser_challenge') {
      session.pendingUserRequest = undefined
      return {
        prompt: buildContinuation({
          kind: 'browser_interaction_resolved',
          reason: 'human_verification'
        }),
        transcriptText: '用户已确认浏览器挑战处理完成。',
        updatesInstruction: false
      }
    }
    if (pending.type === 'browser_interaction' && response.type === 'browser_interaction') {
      session.pendingUserRequest = undefined
      return {
        prompt: buildContinuation({
          kind: 'browser_interaction_resolved',
          reason: pending.reason
        }),
        transcriptText: `用户已确认浏览器操作处理完成（${pending.reason}）。`,
        updatesInstruction: false
      }
    }
    if (pending.type === 'freeform' && response.type === 'freeform') {
      const text = response.text.trim()
      if (!text) throw new Error('用户回复不能为空')
      session.pendingUserRequest = undefined
      return {
        prompt: buildContinuation({ kind: 'user_feedback', text }),
        transcriptText: text,
        updatesInstruction: true
      }
    }
    if (pending.type === 'choice' && response.type === 'choice') {
      const option = pending.options.find((item) => item.id === response.optionId)
      if (!option) throw new Error('选择项不存在或已过期')
      if (!session.workspaceDirectory) throw new Error('插件工作区尚未初始化')
      const decision = {
        requestId: pending.requestId,
        question: pending.prompt,
        selectedOption: {
          id: option.id,
          label: option.label,
          ...(option.description ? { description: option.description } : {})
        },
        evidenceRefs: [...pending.evidenceRefs]
      }
      pluginWorkspace.recordDecision(session.workspaceDirectory, decision)
      session.pendingUserRequest = undefined
      return {
        prompt: buildContinuation({
          kind: 'choice_resolved',
          decision
        }),
        transcriptText:
          `用户针对“${pending.prompt}”选择了「${option.label}」（optionId=${option.id}）` +
          `${option.description ? `：${option.description}` : '。'}`,
        updatesInstruction: false
      }
    }
    throw new Error('用户响应与待处理请求不匹配')
  }

  private async runInitialDebugWorkflow(active: ActivePluginRun): Promise<string> {
    if (active.session.mode === 'create') return ''
    const controller = new AbortController()
    const pluginDryRun = active.tools.find((tool) => tool.name === 'plugin_dry_run')
    if (!pluginDryRun) throw new Error('PluginDeveloper ToolPack 不完整')
    const testResult = await pluginDryRun.invoke({
      runId: active.session.id,
      callId: `workflow:${randomUUID()}`,
      args: {},
      signal: controller.signal,
      progress: () => undefined
    })
    return `AI调试启动 plugin_dry_run：${testResult.ok ? '已执行' : '工具失败'}\n${testResult.content}`
  }

  async start(
    input: PluginDevAgentStartInput,
    emit?: (event: PluginDevAgentEvent) => void
  ): Promise<PluginDevAgentSessionResult> {
    const session = createSession(input)
    this.materializeWorkspace(session, input)
    if (hasSubstantialPluginCode(session.kind, session.package.code) && (input.mode !== 'create' || input.package)) {
      session.incrementalEditOnly = true
    }
    appendWorkLogUserMessage(
      session.id,
      input.userMessage?.trim() || `mode=${input.mode}; site=${session.siteName}; targets=${session.runTargets.map((target) => target.kind === 'video' ? target.code : target.mainName).join(', ') || '无'}`,
      'start'
    )
    const active: ActivePluginRun = {
      input: structuredClone(input),
      session,
      tools: [],
      emit,
      assistantText: '',
      reasoningText: '',
      reasoningTruncated: false,
      pendingAssistantDelta: '',
      pendingReasoningDelta: '',
      summary: 'Agent 已启动'
    }
    this.active.set(session.id, active)
    try {
      const resolved = await this.resolvedConfiguration(
        session.id,
        session,
        (event) => this.emitDomainEvent(active, event)
      )
      active.frozenModel = frozenModelSummary(resolved.revision, resolved.model.model)
      active.tools = resolved.tools
      await agentExecution.openRun({
        runId: session.id,
        useCase: 'plugin-developer',
        resolved,
        productState: toProductState(session, input, active.summary),
        notify: (event) => this.runtimeNotify(active, event),
        project: (event) => this.runtimeProject(active, event)
      })
      session.step = 1
      this.emitDomainEvent(active, { type: 'step_start', sessionId: session.id, step: session.step })
      const debugContext = await this.runInitialDebugWorkflow(active)
      const prompt = buildRunInstructionSet({
        task: input,
        debugResult: debugContext || undefined
      }).initialMessage
      const settled = this.waitForSettled(active)
      const dispatched = await agentExecution.dispatch({
        runId: session.id,
        kind: 'prompt',
        text: prompt,
        idempotencyKey: `start:${session.id}`
      })
      if (!dispatched.accepted) throw new Error('Pi runtime 拒绝了初始 prompt')
      return await settled
    } catch (error) {
      this.failRun(active, error)
      active.waiter?.resolve(toResult(active))
      active.waiter = undefined
      await this.releaseRunResources(session.id, active)
      throw error
    }
  }

  async message(
    input: PluginDevAgentMessageInput,
    emit?: (event: PluginDevAgentEvent) => void
  ): Promise<PluginDevAgentSessionResult> {
    await this.waitForPriorRelease(input.sessionId)
    const active = this.active.get(input.sessionId) ?? await this.activatePersistedRun(input.sessionId)
    const session = active.session
    if (active.waiter) throw new Error('Agent 当前操作仍在收尾，请等待完成后再继续')
    if (session.status === 'running') throw new Error('Agent 仍在运行中')
    if (input.approvalDecision && input.userResponse) {
      throw new Error('安装审批与用户问题响应必须分别提交')
    }
    if (session.pendingUserRequest && !input.userResponse) {
      throw new Error('请先使用当前请求的结构化控件完成响应，普通聊天文本不会被当作确认')
    }
    if (!session.pendingUserRequest && input.userResponse) {
      throw new Error('用户响应已过期或当前没有待处理请求')
    }
    const hasExplicitFeedback =
      input.continuationKind !== 'resume' && input.text.trim().length > 0
    if (
      session.acceptance?.ready === true &&
      !input.approvalDecision &&
      !input.userResponse &&
      !hasExplicitFeedback
    ) {
      throw new Error('当前插件已通过机械验收；如需继续完善，请先输入具体反馈')
    }
    const approvalDecision = input.approvalDecision
    const pendingApproval = approvalDecision
      ? toolHost
        .pendingApprovals(session.id)
        .find((item) => item.requestId === approvalDecision.requestId)
      : undefined
    if (approvalDecision && !pendingApproval) throw new Error('审批请求不存在或已处理')

    let approvedRequestId: string | undefined
    try {
      let effectiveText = input.text
      let updatesInstruction = !input.approvalDecision && input.continuationKind !== 'resume'
      let continuationPrompt = input.continuationKind === 'resume'
        ? buildContinuation({ kind: 'resume' })
        : buildContinuation({
            kind: 'user_feedback',
            text: effectiveText
          })
      if (input.userResponse) {
        const applied = this.applyUserResponse(session, input.userResponse)
        effectiveText = applied.transcriptText
        continuationPrompt = applied.prompt
        updatesInstruction = applied.updatesInstruction
      }
      if (approvalDecision && pendingApproval) {
        if (approvalDecision.decision === 'approve') {
          toolHost.approve(session.id, pendingApproval.requestId)
          approvedRequestId = pendingApproval.requestId
        } else {
          toolHost.deny(session.id, pendingApproval.requestId)
        }
      }
      if (session.workspaceDraftError) {
        continuationPrompt = `${session.workspaceDraftError}

下一步先直接修复当前 plugin.json 或 index.js；不要恢复旧值，也不要重新浏览。修复为合法工作区后调用 plugin_dry_run。

${continuationPrompt}`
      }
      active.emit = emit ?? active.emit
      active.lastAssistantStopReason = undefined
      if (updatesInstruction && effectiveText.trim()) {
        session.lastUserInstruction = effectiveText.trim()
      }
      appendWorkLogUserMessage(session.id, effectiveText, 'continue')
      session.status = 'running'
      session.failureMessage = undefined
      session.cancelRequested = false
      session.endedAt = undefined
      session.step += 1
      if (hasSubstantialPluginCode(session.kind, session.package.code)) {
        session.incrementalEditOnly = true
        session.phase = 'working'
      }
      agentRunStore.updateProductState(
        session.id,
        'running',
        toProductState(session, active.input, active.summary)
      )
      this.emitDomainEvent(active, { type: 'step_start', sessionId: session.id, step: session.step })
      const settled = this.waitForSettled(active)
      const dispatched = await agentExecution.dispatch({
        runId: session.id,
        kind: 'prompt',
        text: continuationPrompt,
        idempotencyKey: `message:${session.id}:${session.step}:${hashCode(effectiveText)}`
      })
      if (!dispatched.accepted) throw new Error('Pi runtime 拒绝了 prompt')
      return await settled
    } catch (error) {
      active.waiter = undefined
      try {
        if (approvedRequestId) toolHost.revokeApproval(session.id, approvedRequestId)
        this.failRun(active, error)
      } finally {
        await this.releaseRunResources(session.id, active)
      }
      throw error
    }
  }

  async releaseBrowser(sessionId: string): Promise<void> {
    await releasePluginDeveloperBrowser(sessionId)
  }

  async cancel(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId)
    cancelSession(sessionId)
    if (!active) return
    this.flushStreamDeltas(active)
    active.summary = '用户已终止'
    try {
      await agentExecution.abort(sessionId, '用户终止插件开发')
    } finally {
      agentRunStore.updateProductState(
        sessionId,
        'cancelled',
        toProductState(active.session, active.input, active.summary)
      )
      const waiter = active.waiter
      active.waiter = undefined
      waiter?.resolve(toResult(active))
      await this.releaseRunResources(sessionId, active)
    }
  }

  private collectPluginDevRunIds(): Set<string> {
    const ids = new Set(
      agentRunStore
        .listRecoverableRuns()
        .filter((record) => record.useCase === 'plugin-developer')
        .map((record) => record.id)
    )
    for (const runId of this.active.keys()) ids.add(runId)
    return ids
  }

  private isRecoverablePluginDevRun(runId: string): boolean {
    const active = this.active.get(runId)
    if (active?.waiter) return true
    if (active?.session.status === 'running' || active?.session.status === 'waiting_user') {
      return true
    }
    const record = agentRunStore.getRun(runId)
    return Boolean(record && isRecoverablePluginDevRunStatus(record.status))
  }

  private async retirePluginDevRuns(runIds: Iterable<string>): Promise<number> {
    const unique = [...new Set(runIds)]
    for (const runId of unique) {
      const active = this.active.get(runId)
      toolHost.discardApprovals(runId)
      toolHost.disposeRun(runId)
      await agentExecution.closeRun(runId)
      if (!active || this.active.get(runId) === active) this.active.delete(runId)
      deleteSession(runId)
      pluginWorkspace.remove(agentSessionDirectory(runId))
    }
    return unique.length
  }

  /**
   * Retire all persisted PluginDeveloper runs so opening the workbench starts clean.
   * Closed runs remain available to platform retention/audit policy, but are excluded from
   * recovery and from the unscoped "latest run" snapshot used by the renderer.
   */
  async clearHistory(): Promise<number> {
    const initialIds = this.collectPluginDevRunIds()
    await Promise.all([...initialIds].map((runId) => this.waitForPriorRelease(runId)))
    const targetIds = this.collectPluginDevRunIds()
    const running = [...targetIds]
      .map((runId) => this.active.get(runId))
      .find((active) => active?.waiter || active?.session.status === 'running')
    if (running) throw new Error('Agent 正在运行或收尾，请先终止并等待完成后再清除历史会话')
    return this.retirePluginDevRuns(targetIds)
  }

  /**
   * Close installed, failed, cancelled and other terminal PluginDeveloper runs that the
   * current workbench will not restore. Keep running / waiting_user sessions.
   */
  async discardUnrecoverableSessions(): Promise<number> {
    const initialIds = this.collectPluginDevRunIds()
    await Promise.all([...initialIds].map((runId) => this.waitForPriorRelease(runId)))
    return this.retirePluginDevRuns(
      [...this.collectPluginDevRunIds()].filter((runId) => !this.isRecoverablePluginDevRun(runId))
    )
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.releases.values()].map((release) => release.promise))
    await agentExecution.dispose()
    for (const runId of this.active.keys()) toolHost.disposeRun(runId)
    this.active.clear()
  }
}

export const pluginDeveloper = new PluginDeveloper()
