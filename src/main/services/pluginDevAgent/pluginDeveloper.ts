import { app } from 'electron'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readTestUserDataPath } from '@shared/appIdentity'
import { buildDryRunToolArgs } from '@shared/pluginDevKindProfile'
import type {
  PluginDevAgentEvent,
  PluginDevAgentMessageInput,
  PluginDevAgentSnapshot,
  PluginDevAgentSessionResult,
  PluginDevAgentStartInput,
  PluginDevAgentWorkLogEntry
} from '@shared/pluginDevTypes'
import { agentConfiguration } from '../../agent-platform/agentConfiguration'
import { agentExecution } from '../../agent-platform/agentExecution'
import { agentRunStore } from '../../agent-platform/agentRunStore'
import { createCacheAffinityId } from '../../agent-platform/cacheAffinity'
import { modelControlPlane } from '../../agent-platform/modelControlPlane'
import { toolHost } from '../../agent-platform/toolHost'
import type {
  AgentRunId,
  HostedToolBinding,
  PersistedRunConfigurationSnapshot,
  ResolvedRunConfiguration,
  RuntimeDurableObservation,
  RuntimeObservation
} from '../../agent-platform/types'
import { hasSubstantialPluginCode } from './pluginDevCodePolicy'
import { buildAgentSystemPrompt, buildContinueUserMessage, buildInitialUserMessage } from './prompts'
import {
  appendWorkLogEvent,
  appendWorkLogUserMessage
} from './workLog'
import {
  cancelSession,
  createSession,
  getSession,
  hashCode,
  markSessionEnded
} from './sessionStore'
import { createPluginDeveloperToolHandlers } from './toolPack'
import type { PluginDevSession } from './types'

interface PluginDeveloperProductState extends Record<string, unknown> {
  schemaVersion: 1
  input: PluginDevAgentStartInput
  status: PluginDevSession['status']
  phase: PluginDevSession['phase']
  step: number
  totalTokens: number
  package: PluginDevSession['package']
  lastDryRun?: PluginDevSession['lastDryRun']
  lastVerification?: PluginDevSession['lastVerification']
  summary: string
  workLog: PluginDevAgentWorkLogEntry[]
  recoveryBlocked?: boolean
}

interface ActivePluginRun {
  input: PluginDevAgentStartInput
  session: PluginDevSession
  tools: readonly HostedToolBinding[]
  emit?: (event: PluginDevAgentEvent) => void
  assistantText: string
  summary: string
  waiter?: {
    resolve: (result: PluginDevAgentSessionResult) => void
  }
}

function agentSessionDirectory(runId: string): string {
  const root = readTestUserDataPath() ?? app.getPath('userData')
  return path.join(root, 'agent-sessions', runId)
}

function toProductState(
  session: PluginDevSession,
  input: PluginDevAgentStartInput,
  summary: string
): PluginDeveloperProductState {
  return {
    schemaVersion: 1,
    input: structuredClone(input),
    status: session.status,
    phase: session.phase,
    step: session.step,
    totalTokens: session.totalTokens,
    package: structuredClone(session.package),
    lastDryRun: session.lastDryRun ? structuredClone(session.lastDryRun) : undefined,
    lastVerification: session.lastVerification ? structuredClone(session.lastVerification) : undefined,
    summary,
    workLog: structuredClone(session.workLog ?? [])
  }
}

function toResult(active: ActivePluginRun): PluginDevAgentSessionResult {
  const session = active.session
  return {
    sessionId: session.id,
    status: session.status,
    package: session.package,
    dryRun: session.lastDryRun,
    verification: session.lastVerification,
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

function runStatus(session: PluginDevSession): 'running' | 'waiting_user' | 'settled' | 'failed' | 'cancelled' {
  if (session.status === 'waiting_user') return 'waiting_user'
  if (session.status === 'completed') return 'settled'
  if (session.status === 'failed') return 'failed'
  if (session.status === 'cancelled') return 'cancelled'
  return 'running'
}

export class PluginDeveloper {
  private readonly active = new Map<string, ActivePluginRun>()

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

  private runtimeNotify(active: ActivePluginRun, event: RuntimeObservation): void {
    if (event.type === 'assistant.delta') active.assistantText += event.text
    if (event.type === 'tool.progress') {
      // Tool-specific start/result events carry the durable detail; progress stays ephemeral.
    }
  }

  private runtimeProject(
    active: ActivePluginRun,
    event: RuntimeDurableObservation
  ): { state: PluginDeveloperProductState; status?: 'running' | 'waiting_user' | 'settled' | 'failed' | 'cancelled' } {
    const session = active.session
    if (event.type === 'message.completed' && event.audit.role === 'assistant') {
      const text = active.assistantText.trim() || event.audit.textPreview.trim()
      if (text) {
        active.summary = text.slice(-500)
        const assistantEvent: PluginDevAgentEvent = {
          type: 'assistant_text',
          sessionId: session.id,
          step: session.step,
          text
        }
        this.emitDomainEvent(active, assistantEvent)
      }
      active.assistantText = ''
    }
    if (event.type === 'usage') {
      session.totalTokens += Math.max(0, Math.round(event.usage.totalTokens))
      this.emitDomainEvent(active, {
        type: 'context_updated',
        sessionId: session.id,
        step: session.step,
        stats: {
          messageCount: 0,
          originalChars: 0,
          compressedChars: 0,
          savedChars: 0,
          estimatedTokens: event.usage.totalInput,
          totalTokens: session.totalTokens,
          maxTokens: session.limits.maxContextTokens,
          overBudget: false
        }
      })
    }
    if (event.type === 'runtime.fault') {
      session.status = 'failed'
      session.endedAt = Date.now()
      active.summary = event.message
      this.emitDomainEvent(active, {
        type: 'error',
        sessionId: session.id,
        step: session.step,
        message: event.message
      })
    }
    if (event.type === 'agent.settled') {
      if (session.status === 'running') {
        session.status = 'failed'
        session.endedAt = Date.now()
        active.summary = active.summary || 'Agent 未调用 plugin_finish 即结束'
        this.emitDomainEvent(active, {
          type: 'done',
          sessionId: session.id,
          step: session.step,
          success: false,
          summary: active.summary,
          package: session.package,
          dryRun: session.lastDryRun,
          verification: session.lastVerification
        })
      }
      const waiter = active.waiter
      active.waiter = undefined
      waiter?.resolve(toResult(active))
    }
    return {
      state: toProductState(session, active.input, active.summary),
      status: runStatus(session)
    }
  }

  private async resolvedConfiguration(
    runId: string,
    session: PluginDevSession,
    emit: (event: PluginDevAgentEvent) => void
  ) {
    const { revision, profile } = agentConfiguration.getProfile('profile:plugin-developer:default')
    const primary = modelControlPlane.resolveAgentModel(profile.id, 'primary')
    // Pi 0.84.2 summarizes with the primary model. Resolution still validates all configured roles.
    const verifier = modelControlPlane.resolveAgentModel(profile.id, 'verifier')
    const summarizer = modelControlPlane.resolveAgentModel(profile.id, 'summarizer')
    const tools = toolHost.registerRun({
      runId,
      profile,
      status: () => agentRunStore.getRun(runId)?.status ?? 'created',
      operationId: () => agentRunStore.getRun(runId)?.activeOperationId,
      handlers: createPluginDeveloperToolHandlers({
        domainSessionId: session.id,
        step: () => session.step,
        emit
      })
    })
    const systemText = buildAgentSystemPrompt(session.kind)
    const cache = {
      primaryAffinityId: createCacheAffinityId(runId, 'primary', primary.routeRevision),
      verifierAffinityId: createCacheAffinityId(runId, 'verifier', verifier.routeRevision),
      summarizerAffinityId: createCacheAffinityId(runId, 'summarizer', summarizer.routeRevision),
      retention: {
        primary: primary.preset.cacheRetention,
        verifier: verifier.preset.cacheRetention,
        summarizer: summarizer.preset.cacheRetention
      }
    }
    session.verifierAffinityId = cache.verifierAffinityId
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
        retry: { enabled: true, maxRetries: 3, baseDelayMs: 1_000 }
      },
      sessionDirectory: agentSessionDirectory(runId)
    }
  }

  private restoreSession(
    runId: AgentRunId,
    state: PluginDeveloperProductState
  ): PluginDevSession {
    if (state.schemaVersion !== 1 || !state.input || !state.package) {
      throw new Error('PluginDeveloper 产品快照版本不兼容')
    }
    const session = createSession(state.input, runId)
    session.status = state.status
    session.phase = state.phase
    session.step = state.step
    session.totalTokens = state.totalTokens
    session.package = structuredClone(state.package)
    session.lastDryRun = state.lastDryRun ? structuredClone(state.lastDryRun) : undefined
    session.lastVerification = state.lastVerification
      ? structuredClone(state.lastVerification)
      : undefined
    session.workLog = structuredClone(state.workLog ?? [])
    if (session.lastDryRun) session.lastDryRunCodeHash = hashCode(session.package.code)
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
      })
    })
    const expectedTools = snapshot.tools.map((tool) => `${tool.name}:${tool.schemaHash}`)
    const restoredTools = tools.map((tool) => `${tool.name}:${tool.schemaHash}`)
    if (JSON.stringify(expectedTools) !== JSON.stringify(restoredTools)) {
      toolHost.disposeRun(runId)
      throw new Error('ToolPack 已变化，拒绝热恢复到不同工具契约')
    }
    session.verifierAffinityId = snapshot.cache.verifierAffinityId
    return {
      revision: snapshot.revision,
      definitionId: snapshot.definitionId,
      profile: structuredClone(snapshot.profile),
      model: modelControlPlane.restoreAgentModel(snapshot.model),
      cache: structuredClone(snapshot.cache),
      systemPrompt: structuredClone(snapshot.systemPrompt),
      tools,
      settings: structuredClone(snapshot.settings),
      sessionDirectory: agentSessionDirectory(runId)
    }
  }

  async restoreRecoverableRuns(): Promise<Array<{ runId: string; error: string }>> {
    const failures: Array<{ runId: string; error: string }> = []
    for (const record of agentRunStore.listRecoverableRuns()) {
      if (record.useCase !== 'plugin-developer' || this.active.has(record.id)) continue
      let active: ActivePluginRun | undefined
      try {
        const state = record.productState as PluginDeveloperProductState
        if (state.recoveryBlocked) continue
        const session = this.restoreSession(record.id, state)
        active = {
          input: structuredClone(state.input),
          session,
          tools: [],
          assistantText: '',
          summary: state.summary || '已恢复 Agent 会话'
        }
        this.active.set(record.id, active)
        const resolved = this.restoredConfiguration(
          record.id,
          record.configSnapshot,
          session,
          (event) => this.emitDomainEvent(active!, event)
        )
        active.tools = resolved.tools
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

  getSnapshot(sessionId?: string): PluginDevAgentSnapshot | null {
    const runId = sessionId ?? agentRunStore.findLatestRun<PluginDeveloperProductState>('plugin-developer')?.id
    if (!runId) return null
    const active = this.active.get(runId)
    if (!active) return null
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
      workLog: structuredClone(active.session.workLog ?? [])
    }
  }

  private waitForSettled(active: ActivePluginRun): Promise<PluginDevAgentSessionResult> {
    if (active.waiter) throw new Error('Agent 仍在运行中')
    return new Promise((resolve) => { active.waiter = { resolve } })
  }

  private async runInitialDebugWorkflow(active: ActivePluginRun): Promise<string> {
    if (active.session.mode === 'create') return ''
    const controller = new AbortController()
    const dryRun = active.tools.find((tool) => tool.name === 'plugin_dry_run')
    if (!dryRun) throw new Error('PluginDeveloper ToolPack 不完整')
    const dryRunResult = await dryRun.invoke({
      runId: active.session.id,
      callId: `workflow:${randomUUID()}`,
      args: buildDryRunToolArgs(active.session.testTargets ?? []),
      signal: controller.signal,
      progress: () => undefined
    })
    return `AI调试启动 dry-run：${dryRunResult.ok ? '成功' : '失败'}\n${dryRunResult.content}`
  }

  async start(
    input: PluginDevAgentStartInput,
    emit?: (event: PluginDevAgentEvent) => void
  ): Promise<PluginDevAgentSessionResult> {
    const session = createSession(input)
    if (input.lastDryRun) {
      session.lastDryRun = input.lastDryRun
      session.lastDryRunCodeHash = hashCode(session.package.code)
    }
    if (hasSubstantialPluginCode(session.kind, session.package.code) && (input.mode !== 'create' || input.package)) {
      session.incrementalEditOnly = true
    }
    appendWorkLogUserMessage(
      session.id,
      input.userMessage?.trim() || `mode=${input.mode}; site=${session.siteName}; targets=${(session.testTargets ?? []).join(', ') || '无'}`,
      'start'
    )
    const active: ActivePluginRun = {
      input: structuredClone(input),
      session,
      tools: [],
      emit,
      assistantText: '',
      summary: 'Agent 已启动'
    }
    this.active.set(session.id, active)
    let opened = false
    try {
      const resolved = await this.resolvedConfiguration(
        session.id,
        session,
        (event) => this.emitDomainEvent(active, event)
      )
      active.tools = resolved.tools
      await agentExecution.openRun({
        runId: session.id,
        useCase: 'plugin-developer',
        resolved,
        productState: toProductState(session, input, active.summary),
        notify: (event) => this.runtimeNotify(active, event),
        project: (event) => this.runtimeProject(active, event)
      })
      opened = true
      session.step = 1
      this.emitDomainEvent(active, { type: 'step_start', sessionId: session.id, step: session.step })
      const debugContext = await this.runInitialDebugWorkflow(active)
      const prompt = [buildInitialUserMessage(input, session), debugContext].filter(Boolean).join('\n\n')
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
      session.status = 'failed'
      markSessionEnded(session.id)
      active.waiter?.resolve(toResult(active))
      active.waiter = undefined
      this.emitDomainEvent(active, {
        type: 'error',
        sessionId: session.id,
        step: session.step,
        message: error instanceof Error ? error.message : String(error)
      })
      if (!opened) {
        toolHost.disposeRun(session.id)
        this.active.delete(session.id)
      }
      throw error
    }
  }

  async message(
    input: PluginDevAgentMessageInput,
    emit?: (event: PluginDevAgentEvent) => void
  ): Promise<PluginDevAgentSessionResult> {
    const active = this.active.get(input.sessionId)
    const session = active?.session ?? getSession(input.sessionId)
    if (!active || !session) throw new Error('会话不存在或需要从持久化记录恢复')
    if (session.status === 'running') throw new Error('Agent 仍在运行中')
    active.emit = emit ?? active.emit
    if (input.lastDryRun) {
      session.lastDryRun = input.lastDryRun
      session.lastDryRunCodeHash = hashCode(session.package.code)
    }
    session.lastUserInstruction = input.text.trim() || session.lastUserInstruction
    appendWorkLogUserMessage(session.id, input.text, 'continue')
    if (/^(同意|批准|确认)(安装|执行)?|允许安装|继续安装/.test(input.text.trim())) {
      for (const approval of toolHost.pendingApprovals(session.id)) {
        toolHost.approve(session.id, approval.requestId)
      }
    }
    session.status = 'running'
    session.cancelRequested = false
    session.endedAt = undefined
    session.step += 1
    if (hasSubstantialPluginCode(session.kind, session.package.code)) {
      session.incrementalEditOnly = true
      session.phase = 'implement'
    }
    this.emitDomainEvent(active, { type: 'step_start', sessionId: session.id, step: session.step })
    const settled = this.waitForSettled(active)
    try {
      const dispatched = await agentExecution.dispatch({
        runId: session.id,
        kind: 'prompt',
        text: buildContinueUserMessage(input.text, session),
        idempotencyKey: `message:${session.id}:${session.step}:${hashCode(input.text)}`
      })
      if (!dispatched.accepted) throw new Error('Pi runtime 拒绝了 prompt')
      return await settled
    } catch (error) {
      active.waiter = undefined
      session.status = 'failed'
      active.summary = error instanceof Error ? error.message : String(error)
      this.emitDomainEvent(active, {
        type: 'error',
        sessionId: session.id,
        step: session.step,
        message: active.summary
      })
      throw error
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId)
    cancelSession(sessionId)
    if (!active) return
    active.summary = '用户已终止'
    await agentExecution.abort(sessionId, '用户终止插件开发')
    agentRunStore.updateProductState(
      sessionId,
      'cancelled',
      toProductState(active.session, active.input, active.summary)
    )
    const waiter = active.waiter
    active.waiter = undefined
    waiter?.resolve(toResult(active))
  }

  async dispose(): Promise<void> {
    await agentExecution.dispose()
    for (const runId of this.active.keys()) toolHost.disposeRun(runId)
    this.active.clear()
  }
}

export const pluginDeveloper = new PluginDeveloper()
