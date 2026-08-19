import { randomUUID } from 'node:crypto'
import { createPiRuntimePort } from '../agent-runtime/createPiRuntimePort'
import { AgentRunStore, agentRunStore, type AgentRunRecord } from './agentRunStore'
import type {
  AgentRuntimePort,
  ResolvedRunConfiguration,
  RuntimeDurableObservation,
  RuntimeObservation,
  RuntimeSessionPort
} from './types'

interface ActiveAgentRun {
  runId: string
  runtime: RuntimeSessionPort
  productState: Record<string, unknown>
  resolved: ResolvedRunConfiguration
  notify?: (event: RuntimeObservation) => void
  project?: (
    event: RuntimeDurableObservation,
    current: Record<string, unknown>
  ) => { state: Record<string, unknown>; status?: AgentRunRecord['status'] } | void
  operationTimings: Map<string, { startedAt: number; firstTokenAt?: number; commandKind: string }>
}

export interface OpenAgentRunInput {
  runId?: string
  useCase: string
  resolved: ResolvedRunConfiguration
  productState: Record<string, unknown>
  resume?: AgentRunRecord
  notify?: (event: RuntimeObservation) => void
  project?: ActiveAgentRun['project']
}

function recoveryCategory(error: unknown): 'checkpoint-corrupt' | 'checkpoint-incompatible' | 'checkpoint-migration-failed' | null {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('checkpoint-corrupt')) return 'checkpoint-corrupt'
  if (message.includes('checkpoint-incompatible')) return 'checkpoint-incompatible'
  if (message.includes('checkpoint-migration-failed')) return 'checkpoint-migration-failed'
  return null
}

export class AgentExecution {
  private runtimePort: AgentRuntimePort | null = null
  private readonly active = new Map<string, ActiveAgentRun>()

  constructor(
    private readonly store: AgentRunStore = agentRunStore,
    private readonly runtimeFactory: () => Promise<AgentRuntimePort> = createPiRuntimePort
  ) {}

  private async port(): Promise<AgentRuntimePort> {
    this.runtimePort ??= await this.runtimeFactory()
    return this.runtimePort
  }

  async openRun(input: OpenAgentRunInput): Promise<{ runId: string; source: 'created' | 'restored' | 'rebuilt' }> {
    const runId = input.resume?.id ?? input.runId ?? randomUUID()
    if (this.active.has(runId)) return { runId, source: 'restored' }
    if (!input.resume) {
      this.store.createRun({
        runId,
        useCase: input.useCase,
        resolved: input.resolved,
        productState: input.productState
      })
    }
    const activeBase = {
      runId,
      productState: structuredClone(input.productState),
      resolved: input.resolved,
      notify: input.notify,
      project: input.project,
      operationTimings: new Map<string, { startedAt: number; firstTokenAt?: number; commandKind: string }>()
    }
    const observer = {
      notify: (event: RuntimeObservation): void => {
        if (event.type === 'assistant.delta') {
          const active = this.active.get(runId)
          const timing = active
            ? [...active.operationTimings.values()].find((candidate) => candidate.firstTokenAt === undefined)
            : undefined
          if (timing) timing.firstTokenAt = Date.now()
        }
        input.notify?.(event)
      },
      commit: async (event: RuntimeDurableObservation): Promise<void> => {
        this.store.commitRuntimeObservation(runId, event)
        const active = this.active.get(runId)
        if (event.type === 'agent.settled') {
          const settledAt = Date.now()
          for (const operationId of event.acceptedCommandIds) {
            const timing = active?.operationTimings.get(operationId)
            this.store.appendProductEvent(runId, operationId, 'telemetry.operation', {
              operationId,
              commandKind: timing?.commandKind ?? 'restored',
              firstTokenMs: timing?.firstTokenAt === undefined
                ? null
                : Math.max(0, timing.firstTokenAt - timing.startedAt),
              settledMs: timing ? Math.max(0, settledAt - timing.startedAt) : null,
              source: timing ? 'live' : 'restored'
            })
            active?.operationTimings.delete(operationId)
          }
        }
        const current = active?.productState ?? activeBase.productState
        const projection = input.project?.(event, current)
        if (projection) {
          activeBase.productState = projection.state
          if (active) active.productState = projection.state
          const status = projection.status ?? this.store.getRun(runId)?.status ?? 'running'
          this.store.updateProductState(runId, status, projection.state)
        }
      }
    }
    const runtimeInput = {
      runId,
      ...(input.resume?.runtimeSessionRef ? { resume: input.resume.runtimeSessionRef } : {}),
      model: input.resolved.model,
      cache: input.resolved.cache,
      systemPrompt: input.resolved.systemPrompt,
      tools: input.resolved.tools,
      settings: input.resolved.settings,
      sessionDirectory: input.resolved.sessionDirectory
    }
    const port = await this.port()
    try {
      const opened = await port.open(runtimeInput, observer)
      this.active.set(runId, { ...activeBase, runtime: opened.session })
      return { runId, source: opened.source }
    } catch (error) {
      const category = input.resume ? recoveryCategory(error) : null
      if (!category) throw error
      if (!this.store.beginRecoveryAttempt(runId, input.resume!.recoveryGeneration)) {
        throw new Error(`checkpoint generation ${input.resume!.recoveryGeneration} 已尝试过重建，拒绝重复执行`)
      }
      if (this.store.hasUnreconciledSideEffects(runId)) {
        throw new Error('checkpoint 恢复被阻止：存在未对账的工具副作用')
      }
      const history = this.store.readExecutionHistory(runId)
      if (history.length === 0) throw new Error('checkpoint 恢复被阻止：ExecutionHistory 为空')
      const { resume: _resume, ...rebuildInput } = runtimeInput
      const runtime = await port.rebuild(rebuildInput, history, observer)
      this.store.commitRebuild(runId, runtime.ref)
      this.active.set(runId, { ...activeBase, runtime })
      return { runId, source: 'rebuilt' }
    }
  }

  hasActiveRun(runId: string): boolean {
    return this.active.has(runId)
  }

  async dispatch(input: {
    runId: string
    kind: 'prompt' | 'steer' | 'follow-up'
    text: string
    idempotencyKey: string
  }): Promise<{ operationId: string; accepted: boolean; duplicate: boolean }> {
    const active = this.active.get(input.runId)
    if (!active) throw new Error('Agent run 未打开')
    const accepted = this.store.acceptOperation({
      runId: input.runId,
      commandKind: input.kind,
      idempotencyKey: input.idempotencyKey,
      content: input.text
    })
    if (!accepted.created) {
      return {
        operationId: accepted.operation.id,
        accepted: accepted.operation.status === 'accepted' || accepted.operation.status === 'settled',
        duplicate: true
      }
    }
    active.operationTimings.set(accepted.operation.id, {
      startedAt: Date.parse(accepted.operation.createdAt),
      commandKind: input.kind
    })
    let result: { accepted: boolean }
    try {
      result = await active.runtime.dispatch({
        commandId: accepted.operation.id,
        kind: input.kind,
        content: { text: input.text }
      })
    } catch (error) {
      active.operationTimings.delete(accepted.operation.id)
      this.store.rejectOperation(accepted.operation.id, (error as Error).message)
      throw error
    }
    if (!result.accepted) {
      active.operationTimings.delete(accepted.operation.id)
      this.store.rejectOperation(accepted.operation.id, 'runtime rejected command')
    }
    return { operationId: accepted.operation.id, accepted: result.accepted, duplicate: false }
  }

  async requestManualCompaction(input: {
    runId: string
    instructions?: string
    idempotencyKey: string
  }): Promise<{ operationId: string; accepted: boolean }> {
    const active = this.active.get(input.runId)
    if (!active) throw new Error('Agent run 未打开')
    const operation = this.store.acceptOperation({
      runId: input.runId,
      commandKind: 'compact',
      idempotencyKey: input.idempotencyKey,
      content: input.instructions ?? ''
    })
    if (!operation.created) {
      return { operationId: operation.operation.id, accepted: operation.operation.status !== 'rejected' }
    }
    active.operationTimings.set(operation.operation.id, {
      startedAt: Date.parse(operation.operation.createdAt),
      commandKind: 'compact'
    })
    let result: { accepted: boolean }
    try {
      result = await active.runtime.requestManualCompaction(operation.operation.id, input.instructions)
    } catch (error) {
      active.operationTimings.delete(operation.operation.id)
      this.store.rejectOperation(operation.operation.id, (error as Error).message)
      throw error
    }
    if (!result.accepted) {
      active.operationTimings.delete(operation.operation.id)
      this.store.rejectOperation(operation.operation.id, 'runtime rejected compaction')
    }
    return { operationId: operation.operation.id, accepted: result.accepted }
  }

  async abort(runId: string, reason?: string): Promise<void> {
    const active = this.active.get(runId)
    if (!active) return
    const operation = this.store.acceptOperation({
      runId,
      commandKind: 'abort',
      idempotencyKey: `abort:${randomUUID()}`,
      content: reason ?? ''
    })
    const startedAt = Date.parse(operation.operation.createdAt)
    try {
      await active.runtime.abort(reason)
      this.store.settleOperation(operation.operation.id)
    } catch (error) {
      this.store.rejectOperation(operation.operation.id, (error as Error).message)
      throw error
    }
    this.store.appendProductEvent(runId, operation.operation.id, 'agent.aborted', { reason })
    this.store.appendProductEvent(runId, operation.operation.id, 'telemetry.operation', {
      operationId: operation.operation.id,
      commandKind: 'abort',
      firstTokenMs: null,
      settledMs: Math.max(0, Date.now() - startedAt),
      source: 'live'
    })
    this.store.updateProductState(runId, 'cancelled', active.productState)
  }

  async closeRun(runId: string): Promise<void> {
    const active = this.active.get(runId)
    if (!active) return
    await active.runtime.dispose()
    this.active.delete(runId)
    this.store.closeRun(runId)
  }

  async dispose(): Promise<void> {
    const runs = [...this.active.values()]
    await Promise.allSettled(runs.map((active) => active.runtime.dispose()))
    this.active.clear()
  }
}

export const agentExecution = new AgentExecution()
