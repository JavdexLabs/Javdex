import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { readTestUserDataPath } from '@shared/appIdentity'
import type {
  LibraryCuratorMessageInput,
  LibraryCuratorResult,
  LibraryCuratorSnapshot,
  LibraryCuratorStartInput
} from '@shared/libraryCuratorTypes'
import { getLibraryOverviewStats } from '../../db/overviewRepo'
import { agentConfiguration } from '../../agent-platform/agentConfiguration'
import { agentExecution } from '../../agent-platform/agentExecution'
import { agentRunStore, type AgentRunRecord } from '../../agent-platform/agentRunStore'
import { createCacheAffinityId } from '../../agent-platform/cacheAffinity'
import { createLibraryCuratorToolHandlers } from '../../agent-platform/libraryCuratorToolPack'
import { modelControlPlane } from '../../agent-platform/modelControlPlane'
import { toolHost } from '../../agent-platform/toolHost'
import type {
  PersistedRunConfigurationSnapshot,
  ResolvedRunConfiguration,
  RuntimeDurableObservation,
  RuntimeObservation
} from '../../agent-platform/types'

interface LibraryCuratorProductState extends Record<string, unknown> {
  schemaVersion: 1
  status: LibraryCuratorResult['status']
  summary: string
  totalTokens: number
  recoveryBlocked?: boolean
}

interface ActiveCuratorRun {
  state: LibraryCuratorProductState
  assistantText: string
  lastAssistantStopReason?: string
  waiter?: (result: LibraryCuratorResult) => void
}

function sessionDirectory(runId: string): string {
  const root = readTestUserDataPath() ?? app.getPath('userData')
  return path.join(root, 'agent-sessions', runId)
}

function result(runId: string, active: ActiveCuratorRun): LibraryCuratorResult {
  return {
    runId,
    status: active.state.status,
    summary: active.state.summary,
    totalTokens: active.state.totalTokens
  }
}

function runStatus(status: LibraryCuratorResult['status']): AgentRunRecord['status'] {
  if (status === 'completed') return 'settled'
  return status
}

export class LibraryCurator {
  private readonly active = new Map<string, ActiveCuratorRun>()

  private registerTools(runId: string, profile: PersistedRunConfigurationSnapshot['profile']) {
    return toolHost.registerRun({
      runId,
      profile,
      status: () => agentRunStore.getRun(runId)?.status ?? 'closed',
      operationId: () => agentRunStore.getRun(runId)?.activeOperationId,
      handlers: createLibraryCuratorToolHandlers(async () => (
        structuredClone(getLibraryOverviewStats()) as unknown as Record<string, unknown>
      ))
    })
  }

  private resolveConfiguration(runId: string): ResolvedRunConfiguration {
    const { revision, profile, definition, workload } = agentConfiguration.getProfile(
      'profile:library-curator:default'
    )
    const primary = modelControlPlane.resolveWorkloadModel('library-curator')
    const summarizer = primary
    const tools = this.registerTools(runId, profile)
    const systemText = definition.systemPrompt
    return {
      revision,
      definitionId: definition.id,
      profile,
      model: primary,
      cache: {
        primaryAffinityId: createCacheAffinityId(runId, 'primary', primary.routeRevision),
        verifierAffinityId: createCacheAffinityId(runId, 'verifier', 'disabled'),
        summarizerAffinityId: createCacheAffinityId(runId, 'summarizer', summarizer.routeRevision),
        retention: {
          primary: primary.preset.cacheRetention,
          verifier: 'none',
          summarizer: summarizer.preset.cacheRetention
        }
      },
      systemPrompt: {
        text: systemText,
        sha256: createHash('sha256').update(systemText).digest('hex')
      },
      tools,
      settings: {
        compaction: profile.compaction,
        retry: { enabled: true, maxRetries: 3, baseDelayMs: 1_000 },
        maxTurns: workload.limits.maxTurns
      },
      sessionDirectory: sessionDirectory(runId)
    }
  }

  private restoreConfiguration(
    runId: string,
    snapshot: PersistedRunConfigurationSnapshot
  ): ResolvedRunConfiguration {
    if (snapshot.definitionId !== 'library-curator') {
      throw new Error(`无法用 LibraryCurator 恢复 Definition ${snapshot.definitionId}`)
    }
    const tools = this.registerTools(runId, snapshot.profile)
    const expected = snapshot.tools.map((tool) => `${tool.name}:${tool.schemaHash}`)
    const actual = tools.map((tool) => `${tool.name}:${tool.schemaHash}`)
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      toolHost.disposeRun(runId)
      throw new Error('LibraryCurator ToolPack 已变化，拒绝热恢复')
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
      sessionDirectory: sessionDirectory(runId)
    }
  }

  private notify(active: ActiveCuratorRun, event: RuntimeObservation): void {
    if (event.type === 'assistant.delta') active.assistantText += event.text
  }

  private project(
    runId: string,
    active: ActiveCuratorRun,
    event: RuntimeDurableObservation
  ): { state: LibraryCuratorProductState; status: AgentRunRecord['status'] } {
    if (event.type === 'message.completed' && event.audit.role === 'assistant') {
      active.lastAssistantStopReason = event.audit.stopReason
      active.state.summary = (active.assistantText.trim() || event.audit.textPreview.trim()).slice(-2_000)
      active.assistantText = ''
    }
    if (event.type === 'usage') {
      active.state.totalTokens += Math.max(0, Math.round(event.usage.totalTokens))
    }
    if (event.type === 'runtime.fault') {
      active.state.status = 'failed'
      active.state.summary = event.message
    }
    if (event.type === 'limit.reached' && active.state.status === 'running') {
      active.state.status = 'waiting_user'
      active.state.summary = `Agent 已达到本次模型轮次上限（${event.current}/${event.limit}），可继续当前任务。`
    }
    if (event.type === 'agent.settled') {
      if (active.state.status === 'running') {
        if (active.lastAssistantStopReason === 'length') {
          active.state.status = 'waiting_user'
          active.state.summary = '模型输出达到上限，自动续跑后仍未完成；可继续当前任务。'
        } else {
          active.state.status = 'completed'
        }
      }
      const waiter = active.waiter
      active.waiter = undefined
      waiter?.(result(runId, active))
    }
    return { state: structuredClone(active.state), status: runStatus(active.state.status) }
  }

  private wait(runId: string, active: ActiveCuratorRun): Promise<LibraryCuratorResult> {
    if (active.waiter) throw new Error('LibraryCurator 仍在运行')
    return new Promise((resolve) => { active.waiter = resolve })
  }

  async start(input: LibraryCuratorStartInput = {}): Promise<LibraryCuratorResult> {
    const runId = randomUUID()
    const active: ActiveCuratorRun = {
      state: { schemaVersion: 1, status: 'running', summary: '正在整理媒体库概览', totalTokens: 0 },
      assistantText: ''
    }
    this.active.set(runId, active)
    try {
      const resolved = this.resolveConfiguration(runId)
      await agentExecution.openRun({
        runId,
        useCase: 'library-curator',
        resolved,
        productState: active.state,
        notify: (event) => this.notify(active, event),
        project: (event) => this.project(runId, active, event)
      })
      const settled = this.wait(runId, active)
      const dispatched = await agentExecution.dispatch({
        runId,
        kind: 'prompt',
        text: input.prompt?.trim() || '请读取媒体库概览，并用简洁中文总结当前规模与最值得关注的待处理项。',
        idempotencyKey: `start:${runId}`
      })
      if (!dispatched.accepted) throw new Error('Pi runtime 拒绝了 LibraryCurator prompt')
      return await settled
    } catch (error) {
      active.state.status = 'failed'
      active.state.summary = error instanceof Error ? error.message : String(error)
      active.waiter?.(result(runId, active))
      active.waiter = undefined
      throw error
    }
  }

  async message(input: LibraryCuratorMessageInput): Promise<LibraryCuratorResult> {
    const active = this.active.get(input.runId)
    if (!active) throw new Error('LibraryCurator run 不存在或尚未恢复')
    if (active.state.status === 'running') throw new Error('LibraryCurator 仍在运行')
    active.state.status = 'running'
    const settled = this.wait(input.runId, active)
    try {
      const dispatched = await agentExecution.dispatch({
        runId: input.runId,
        kind: 'prompt',
        text: input.text,
        idempotencyKey: `message:${randomUUID()}`
      })
      if (!dispatched.accepted) throw new Error('Pi runtime 拒绝了 LibraryCurator prompt')
      return await settled
    } catch (error) {
      active.waiter = undefined
      active.state.status = 'failed'
      active.state.summary = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId)
    if (!active) return
    active.state.status = 'cancelled'
    active.state.summary = '用户已终止'
    await agentExecution.abort(runId, active.state.summary)
    const waiter = active.waiter
    active.waiter = undefined
    waiter?.(result(runId, active))
  }

  async restoreRecoverableRuns(): Promise<Array<{ runId: string; error: string }>> {
    const failures: Array<{ runId: string; error: string }> = []
    for (const record of agentRunStore.listRecoverableRuns()) {
      if (record.useCase !== 'library-curator' || this.active.has(record.id)) continue
      try {
        const state = record.productState as LibraryCuratorProductState
        if (state.recoveryBlocked) continue
        if (state.schemaVersion !== 1) throw new Error('LibraryCurator 产品快照版本不兼容')
        const active: ActiveCuratorRun = { state: structuredClone(state), assistantText: '' }
        this.active.set(record.id, active)
        const resolved = this.restoreConfiguration(record.id, record.configSnapshot)
        const opened = await agentExecution.openRun({
          useCase: 'library-curator',
          resolved,
          productState: active.state,
          resume: record,
          notify: (event) => this.notify(active, event),
          project: (event) => this.project(record.id, active, event)
        })
        if (record.status === 'created' || record.status === 'running' || record.status === 'recovering' || opened.source === 'rebuilt') {
          agentRunStore.interruptAcceptedOperations(record.id, 'app-restart')
          active.state.status = 'waiting_user'
          active.state.summary = opened.source === 'rebuilt'
            ? 'checkpoint 已重建，请确认后继续'
            : '应用已恢复会话，请确认后继续'
          agentRunStore.updateProductState(record.id, 'waiting_user', active.state)
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
      }
    }
    return failures
  }

  getSnapshot(runId?: string): LibraryCuratorSnapshot | null {
    const id = runId ?? agentRunStore.findLatestRun<LibraryCuratorProductState>('library-curator')?.id
    const active = id ? this.active.get(id) : undefined
    if (!id || !active) return null
    const journal = agentRunStore.readProductJournal(id)
    return { ...result(id, active), cursor: journal.at(-1)?.seq ?? 0 }
  }

  async dispose(): Promise<void> {
    for (const runId of this.active.keys()) toolHost.disposeRun(runId)
    this.active.clear()
  }
}

export const libraryCurator = new LibraryCurator()
