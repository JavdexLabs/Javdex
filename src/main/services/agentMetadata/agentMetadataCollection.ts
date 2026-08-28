import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { readTestUserDataPath } from '@shared/appIdentity'
import type {
  AgentMetadataApplyInput,
  AgentMetadataApplyOutcome,
  AgentMetadataDiscardInput,
  AgentMetadataPlanInput,
  AgentMetadataReview,
  AgentMetadataSnapshot,
  AgentMetadataSnapshotChangedEvent,
  AgentMetadataSource,
  AgentMetadataStartInput,
  AgentMetadataTarget,
  AgentMetadataResumeInput,
  AgentMetadataPhase,
  AgentMetadataBrowserHandoff
} from '@shared/agentMetadataTypes'
import type { AgentMetadataActivity } from '@shared/agentMetadataTypes'
import { agentConfiguration } from '../../agent-platform/agentConfiguration'
import { agentExecution } from '../../agent-platform/agentExecution'
import { agentRunStore, type AgentRunRecord } from '../../agent-platform/agentRunStore'
import { createCacheAffinityId } from '../../agent-platform/cacheAffinity'
import { modelControlPlane } from '../../agent-platform/modelControlPlane'
import { toolHost } from '../../agent-platform/toolHost'
import type {
  PersistedRunConfigurationSnapshot,
  ResolvedRunConfiguration,
  RuntimeDurableObservation,
  RuntimeObservation
} from '../../agent-platform/types'
import { getActressDetail } from '../../db/actressRepo'
import { getVideoById } from '../../db/videoRepo'
import { agentMetadataBrowser } from './browserAdapter'
import { agentMetadataDraftService } from './draftService'
import { createAgentMetadataToolHandlers } from './toolPack'
import { AgentMetadataActivityTimeline } from './activityTimeline'

interface AgentMetadataProductState extends Record<string, unknown> {
  schemaVersion: 1
  revision: number
  target: AgentMetadataTarget
  phase: AgentMetadataPhase
  summary: string
  source: AgentMetadataSource
  activities?: AgentMetadataActivity[]
  draftId?: string
  handoff?: AgentMetadataBrowserHandoff
  errorCode?: string
}

interface ActiveMetadataRun {
  state: AgentMetadataProductState
  timeline: AgentMetadataActivityTimeline
  liveEmitTimer?: ReturnType<typeof setTimeout>
}

function sessionDirectory(runId: string): string {
  const root = readTestUserDataPath() ?? app.getPath('userData')
  return path.join(root, 'agent-sessions', runId)
}

function agentRunStatus(phase: AgentMetadataPhase): AgentRunRecord['status'] {
  if (phase === 'collecting' || phase === 'preparing' || phase === 'applying') return 'running'
  if (phase === 'waiting_user') return 'waiting_user'
  if (phase === 'failed') return 'failed'
  if (phase === 'cancelled') return 'cancelled'
  return 'settled'
}

function targetPrompt(target: AgentMetadataTarget): string {
  if (target.kind === 'video') {
    const video = getVideoById(target.id)
    if (!video) throw new Error('影片不存在。')
    return `当前目标是影片 #${video.id}，库内番号为「${video.code}」。必须在页面中找到并核对同一番号。`
  }
  const actress = getActressDetail(target.id)
  if (!actress) throw new Error('演员不存在。')
  const names = [...new Set([actress.main_name, ...actress.names.map((item) => item.name)])]
  return `当前目标是演员 #${actress.id}，库内已知名称为：${names.map((name) => `「${name}」`).join('、')}。必须在页面中找到至少一个相同名称。`
}

export class AgentMetadataCollection {
  private readonly active = new Map<string, ActiveMetadataRun>()
  private readonly listeners = new Set<(event: AgentMetadataSnapshotChangedEvent) => void>()

  subscribe(listener: (event: AgentMetadataSnapshotChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(runId: string, revision: number): void {
    const event = { runId, revision }
    for (const listener of this.listeners) listener(event)
  }

  private persist(runId: string, active: ActiveMetadataRun, eventType: string): void {
    active.state.activities = active.timeline.snapshot()
    active.state.revision += 1
    agentRunStore.appendProductEvent(
      runId,
      agentRunStore.getRun(runId)?.activeOperationId,
      eventType,
      { phase: active.state.phase, revision: active.state.revision }
    )
    agentRunStore.updateProductState(runId, agentRunStatus(active.state.phase), active.state)
    this.emit(runId, active.state.revision)
  }

  private registerTools(runId: string, profile: PersistedRunConfigurationSnapshot['profile']) {
    return toolHost.registerRun({
      runId,
      profile,
      status: () => agentRunStore.getRun(runId)?.status ?? 'closed',
      operationId: () => agentRunStore.getRun(runId)?.activeOperationId,
      handlers: createAgentMetadataToolHandlers({
        browser: (args, signal, callId) => {
          const active = this.requireActive(runId)
          if (active.timeline.describeTool(callId, 'browser', args)) {
            this.emit(runId, active.state.revision)
          }
          return agentMetadataBrowser.execute({
            runId,
            args,
            signal,
            onHandoff: (handoff) => {
              const current = this.requireActive(runId)
              current.state.phase = 'waiting_user'
              current.state.summary = '等待用户完成浏览器操作'
              current.state.handoff = handoff
              this.persist(runId, current, 'metadata.browser-handoff')
            }
          })
        },
        submit: async (args, signal, callId) => {
          const active = this.requireActive(runId)
          if (active.timeline.describeTool(callId, 'submit_metadata_candidate', args)) {
            this.emit(runId, active.state.revision)
          }
          if (active.state.draftId) throw new Error('本次 Agent 运行已经提交过候选。')
          active.state.phase = 'preparing'
          active.state.summary = '正在验证候选并暂存图片'
          delete active.state.handoff
          this.persist(runId, active, 'metadata.preparing')
          const payload = await agentMetadataDraftService.prepare({
            runId,
            target: active.state.target,
            args,
            signal
          })
          const draft = agentMetadataDraftService.findReadyForTarget(active.state.target)
          if (!draft || draft.runId !== runId) throw new Error('元数据候选保存后无法读取。')
          active.state.phase = 'ready'
          active.state.summary = '候选已就绪，请预览并选择应用方式'
          active.state.draftId = draft.id
          active.state.source = draft.source
          this.persist(runId, active, 'metadata.ready')
          await agentMetadataBrowser.release(runId, 'Metadata candidate submitted')
          return payload
        }
      })
    })
  }

  private resolveConfiguration(runId: string): ResolvedRunConfiguration {
    const { revision, profile, definition, workload } = agentConfiguration.getProfile(
      'profile:metadata-collector:default'
    )
    const primary = modelControlPlane.resolveWorkloadModel('library-curator')
    const tools = this.registerTools(runId, profile)
    return {
      revision,
      definitionId: definition.id,
      profile,
      model: primary,
      cache: {
        primaryAffinityId: createCacheAffinityId(runId, 'primary', primary.routeRevision),
        verifierAffinityId: createCacheAffinityId(runId, 'verifier', 'disabled'),
        summarizerAffinityId: createCacheAffinityId(runId, 'summarizer', primary.routeRevision),
        retention: {
          primary: primary.preset.cacheRetention,
          verifier: 'none',
          summarizer: primary.preset.cacheRetention
        }
      },
      systemPrompt: {
        text: definition.systemPrompt,
        sha256: createHash('sha256').update(definition.systemPrompt).digest('hex')
      },
      tools,
      settings: {
        compaction: profile.compaction,
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000 },
        maxTurns: workload.limits.maxTurns
      },
      sessionDirectory: sessionDirectory(runId)
    }
  }

  private project(
    runId: string,
    active: ActiveMetadataRun,
    event: RuntimeDurableObservation
  ): { state: AgentMetadataProductState; status: AgentRunRecord['status'] } {
    let changed = active.timeline.observe(event)
    if (changed) active.state.activities = active.timeline.snapshot()
    if (event.type === 'runtime.fault') {
      active.state.phase = 'failed'
      active.state.summary = event.message
      active.state.errorCode = 'RUNTIME_FAULT'
      changed = true
      void agentMetadataBrowser.release(runId, 'Metadata Agent runtime fault')
    }
    if (event.type === 'limit.reached' && active.state.phase === 'collecting') {
      active.state.phase = 'failed'
      active.state.summary = 'Agent 达到模型轮次上限，未能提交候选。'
      active.state.errorCode = 'TURN_LIMIT_REACHED'
      changed = true
      void agentMetadataBrowser.release(runId, 'Metadata Agent turn limit')
    }
    if (event.type === 'agent.settled') {
      if (active.state.phase === 'collecting' || active.state.phase === 'preparing') {
        active.state.phase = 'failed'
        active.state.summary = 'Agent 已结束，但没有提交可预览的元数据候选。'
        active.state.errorCode = 'RESULT_NOT_SUBMITTED'
        void agentMetadataBrowser.release(runId, 'Metadata Agent settled without result')
      }
      changed = true
      if (active.state.phase === 'ready') {
        toolHost.disposeRun(runId)
        void agentExecution.releaseRun(runId)
      }
    }
    if (changed) {
      active.state.revision += 1
      this.emit(runId, active.state.revision)
    }
    return {
      state: structuredClone(active.state),
      status: agentRunStatus(active.state.phase)
    }
  }

  private notify(runId: string, active: ActiveMetadataRun, event: RuntimeObservation): void {
    if (event.type !== 'reasoning.delta' && event.type !== 'tool.progress') return
    if (!active.timeline.observe(event) || active.liveEmitTimer) return
    active.liveEmitTimer = setTimeout(() => {
      active.liveEmitTimer = undefined
      if (this.active.get(runId) === active) this.emit(runId, active.state.revision)
    }, 60)
  }

  async start(input: AgentMetadataStartInput): Promise<AgentMetadataSnapshot> {
    targetPrompt(input.target)
    if (!input.sourceUrl.trim()) throw new Error('请输入外部详情页 URL。')
    const runId = randomUUID()
    const source: AgentMetadataSource = {
      requestedUrl: input.sourceUrl,
      displayUrl: input.sourceUrl
    }
    const state: AgentMetadataProductState = {
        schemaVersion: 1,
        revision: 1,
        target: structuredClone(input.target),
        phase: 'collecting',
        summary: 'Agent 正在读取外部详情页',
        source,
        activities: []
    }
    const active: ActiveMetadataRun = {
      state,
      timeline: new AgentMetadataActivityTimeline()
    }
    this.active.set(runId, active)
    try {
      await agentMetadataBrowser.openSession({
        runId,
        sourceUrl: input.sourceUrl,
        workspaceDirectory: sessionDirectory(runId)
      })
      active.state.source = agentMetadataBrowser.source(runId)
      const resolved = this.resolveConfiguration(runId)
      await agentExecution.openRun({
        runId,
        useCase: 'metadata-collector',
        resolved,
        productState: active.state,
        notify: (event) => this.notify(runId, active, event),
        project: (event) => this.project(runId, active, event)
      })
      const prompt = [
        targetPrompt(input.target),
        `用户指定详情页：${input.sourceUrl}`,
        '请先用 browser open 打开该 URL，核对身份并采集页面明确提供的信息。完成后只调用一次 submit_metadata_candidate。'
      ].join('\n')
      const dispatched = await agentExecution.dispatch({
        runId,
        kind: 'prompt',
        text: prompt,
        idempotencyKey: input.idempotencyKey
      })
      if (!dispatched.accepted) throw new Error('Agent runtime 拒绝了元数据采集任务。')
      this.emit(runId, active.state.revision)
      return this.snapshot(runId)!
    } catch (error) {
      active.state.phase = 'failed'
      active.state.summary = error instanceof Error ? error.message : String(error)
      active.state.errorCode = 'START_FAILED'
      await agentMetadataBrowser.release(runId, 'Metadata Agent start failed')
      toolHost.disposeRun(runId)
      if (agentRunStore.getRun(runId)) {
        agentRunStore.updateProductState(runId, 'failed', active.state)
      }
      this.emit(runId, active.state.revision)
      throw error
    }
  }

  async resume(input: AgentMetadataResumeInput): Promise<AgentMetadataSnapshot> {
    const active = this.requireActive(input.runId)
    if (active.state.phase !== 'waiting_user' || active.state.handoff?.requestId !== input.requestId) {
      throw new Error('浏览器交接请求已失效。')
    }
    active.state.phase = 'collecting'
    active.state.summary = 'Agent 正在继续读取详情页'
    delete active.state.handoff
    this.persist(input.runId, active, 'metadata.resumed')
    const dispatched = await agentExecution.dispatch({
      runId: input.runId,
      kind: 'prompt',
      text: '用户已经完成浏览器中的必要操作。请调用 browser status 或 snapshot 重新确认当前页面，然后继续采集并提交候选。',
      idempotencyKey: input.idempotencyKey
    })
    if (!dispatched.accepted) throw new Error('Agent runtime 拒绝继续任务。')
    return this.snapshot(input.runId)!
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId)
    if (!active || ['applied', 'discarded', 'cancelled'].includes(active.state.phase)) return
    active.state.phase = 'cancelled'
    active.state.summary = '用户已终止元数据采集'
    this.persist(runId, active, 'metadata.cancelled')
    await Promise.allSettled([
      agentExecution.abort(runId, active.state.summary),
      agentMetadataBrowser.release(runId, active.state.summary)
    ])
    toolHost.disposeRun(runId)
  }

  plan(input: AgentMetadataPlanInput): AgentMetadataReview {
    const review = agentMetadataDraftService.plan(input)
    this.syncDraftState(review.draftId, 'ready', '已更新字段影响预览')
    return review
  }

  apply(input: AgentMetadataApplyInput): AgentMetadataApplyOutcome {
    const draft = agentMetadataDraftService.getDraft(input.draftId)
    if (!draft) throw new Error('元数据草稿不存在。')
    this.syncDraftState(input.draftId, 'applying', '正在应用元数据')
    try {
      const outcome = agentMetadataDraftService.apply(input)
      this.syncDraftState(
        input.draftId,
        outcome.status === 'preview_stale'
          ? 'ready'
          : outcome.status === 'routed_to_pending'
            ? 'routed_to_pending'
            : 'applied',
        outcome.status === 'preview_stale'
          ? '媒体库内容已变化，请重新检查预览'
          : outcome.status === 'no_op'
            ? '没有需要写入的变化'
            : '元数据已应用'
      )
      return outcome
    } catch (error) {
      this.syncDraftState(input.draftId, 'ready', '应用失败，草稿仍可重新检查')
      throw error
    }
  }

  discard(input: AgentMetadataDiscardInput): void {
    agentMetadataDraftService.discard(input)
    this.syncDraftState(input.draftId, 'discarded', '元数据草稿已丢弃')
  }

  findReady(target: AgentMetadataTarget) {
    return agentMetadataDraftService.findReadyForTarget(target)
  }

  snapshot(runId: string): AgentMetadataSnapshot | null {
    const active = this.active.get(runId)
    if (!active) return null
    const journal = agentRunStore.readProductJournal(runId)
    const draft = active.state.draftId
      ? agentMetadataDraftService.getDraft(active.state.draftId) ?? undefined
      : undefined
    return {
      runId,
      revision: active.state.revision,
      cursor: journal.at(-1)?.seq ?? 0,
      target: structuredClone(active.state.target),
      phase: active.state.phase,
      summary: active.state.summary,
      source: structuredClone(active.state.source),
      activities: active.timeline.snapshot(),
      ...(draft ? { draft } : {}),
      ...(active.state.handoff ? { handoff: structuredClone(active.state.handoff) } : {}),
      ...(active.state.errorCode ? { errorCode: active.state.errorCode } : {})
    }
  }

  async restoreRecoverableRuns(): Promise<Array<{ runId: string; error: string }>> {
    const failures: Array<{ runId: string; error: string }> = []
    for (const record of agentRunStore.listRecoverableRuns()) {
      if (record.useCase !== 'metadata-collector' || this.active.has(record.id)) continue
      try {
        const state = record.productState as AgentMetadataProductState
        if (state.schemaVersion !== 1) throw new Error('元数据采集产品快照版本不兼容。')
        const active: ActiveMetadataRun = {
          state: structuredClone(state),
          timeline: new AgentMetadataActivityTimeline(state.activities ?? [])
        }
        this.active.set(record.id, active)
        const ownedDraft = state.draftId
          ? agentMetadataDraftService.getDraft(state.draftId)
          : agentMetadataDraftService.findReadyForTarget(state.target)
        if (ownedDraft?.runId === record.id && ownedDraft.status === 'ready') {
          active.state.phase = 'ready'
          active.state.draftId = ownedDraft.id
          active.state.source = ownedDraft.source
          active.state.summary = '已恢复待确认的元数据候选'
          agentRunStore.updateProductState(record.id, 'settled', active.state)
        } else if (ownedDraft?.runId === record.id && ownedDraft.status !== 'failed') {
          active.state.phase = ownedDraft.status
          active.state.draftId = ownedDraft.id
          active.state.source = ownedDraft.source
          active.state.summary = ownedDraft.status === 'applied'
            ? '元数据已应用'
            : ownedDraft.status === 'routed_to_pending'
              ? '元数据已转入待处理中心'
              : '元数据草稿已丢弃'
          agentRunStore.updateProductState(record.id, 'settled', active.state)
        } else if (ownedDraft?.runId === record.id && ownedDraft.status === 'failed') {
          active.state.phase = 'failed'
          active.state.draftId = ownedDraft.id
          active.state.source = ownedDraft.source
          active.state.summary = '元数据草稿处理失败，请重新发起采集。'
          active.state.errorCode = 'DRAFT_FAILED'
          agentRunStore.updateProductState(record.id, 'failed', active.state)
        } else if (['collecting', 'preparing', 'waiting_user', 'applying'].includes(state.phase)) {
          active.state.phase = 'failed'
          active.state.summary = '应用重启后浏览器采集会话已结束，请重新发起采集。'
          active.state.errorCode = 'BROWSER_SESSION_LOST'
          agentRunStore.interruptAcceptedOperations(record.id, 'app-restart')
          agentRunStore.updateProductState(record.id, 'failed', active.state)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push({ runId: record.id, error: message })
        this.active.delete(record.id)
        agentRunStore.updateProductState(record.id, 'failed', {
          ...record.productState,
          recoveryError: message
        })
      }
    }
    return failures
  }

  async dispose(): Promise<void> {
    await agentMetadataBrowser.dispose()
    for (const [runId, active] of this.active) {
      if (active.liveEmitTimer) clearTimeout(active.liveEmitTimer)
      toolHost.disposeRun(runId)
    }
    this.active.clear()
    this.listeners.clear()
  }

  private syncDraftState(
    draftId: string,
    phase: AgentMetadataPhase,
    summary: string
  ): void {
    const draft = agentMetadataDraftService.getDraft(draftId)
    const active = draft?.runId ? this.active.get(draft.runId) : undefined
    if (!draft || !active) return
    active.state.draftId = draft.id
    active.state.source = draft.source
    active.state.phase = phase
    active.state.summary = summary
    this.persist(draft.runId!, active, `metadata.${phase}`)
  }

  private requireActive(runId: string): ActiveMetadataRun {
    const active = this.active.get(runId)
    if (!active) throw new Error('元数据采集任务不存在或尚未恢复。')
    return active
  }
}

export const agentMetadataCollection = new AgentMetadataCollection()
