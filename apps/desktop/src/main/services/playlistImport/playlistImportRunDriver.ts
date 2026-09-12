import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { readTestUserDataPath } from '@shared/appIdentity'
import type {
  PlaylistImportActivity,
  PlaylistImportSnapshot,
  PlaylistImportStartInput
} from '@shared/playlistImportTypes'
import type { AgentMetadataBrowserHandoff } from '@shared/agentMetadataTypes'
import { agentConfiguration } from '../../agent-platform/agentConfiguration'
import { createCacheAffinityId } from '../../agent-platform/cacheAffinity'
import { agentExecution } from '../../agent-platform/agentExecution'
import { modelControlPlane } from '../../agent-platform/modelControlPlane'
import { agentRunStore } from '../../agent-platform/agentRunStore'
import { toolHost, type ToolHandler } from '../../agent-platform/toolHost'
import type {
  PersistedRunConfigurationSnapshot,
  ResolvedRunConfiguration,
  RuntimeDurableObservation,
  RuntimeObservation,
  HostedToolResult
} from '../../agent-platform/types'
import { getDb } from '@library/db/database'
import {
  isScrapeBrowserChallengeError,
  type ScrapeBrowserListExtractionPlan
} from '../../scrapers/scrapeBrowserTypes'
import {
  AgentMetadataBrowserAdapter,
  sanitizeAgentMetadataUrl
} from '../agentMetadata/browserAdapter'
import { AgentMetadataActivityTimeline } from '../agentMetadata/activityTimeline'
import type { PlaylistImportRunDriver } from './playlistImportModule'
import {
  normalizePlaylistImportUrl,
  PlaylistImportRepository,
  type PlaylistImportBrowserWork
} from './playlistImportRepository'
import {
  assertPlaylistImportFinalAdvance,
  assertPlaylistImportTerminalVerified,
  assertPlaylistImportVirtualStart,
  isPlaylistImportBrowserSessionLostMessage,
  observePlaylistImportDynamicStability,
  playlistImportFailureCode,
  playlistImportVirtualAdvanceDecision,
  playlistImportTerminalProof,
  shouldValidatePlaylistImportAdvanceAtCheckpoint
} from './playlistImportBrowserNavigation'
import { createPlaylistImporterToolHandlers } from './toolPack'

function sessionDirectory(runId: string): string {
  const root = readTestUserDataPath() ?? app.getPath('userData')
  return path.join(root, 'agent-sessions', runId)
}

function stringArg(args: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = typeof args[key] === 'string' ? args[key].trim() : ''
  if (required && !value) throw new Error(`PLAYLIST_IMPORT_ARGUMENT_REQUIRED:${key}`)
  return value || undefined
}

function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`PLAYLIST_IMPORT_ARGUMENT_INVALID:${key}`)
  }
  return value
}

function objectArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PLAYLIST_IMPORT_ARGUMENT_INVALID:${key}`)
  }
  return value as Record<string, unknown>
}

function withoutCheckpointEvidenceForStatus(result: HostedToolResult): HostedToolResult {
  if (!result.ok) return result
  let content: Record<string, unknown>
  try {
    const parsed = JSON.parse(result.content) as unknown
    content = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { action: 'status' }
  } catch {
    content = { action: 'status' }
  }
  delete content.artifactRef
  return {
    ...result,
    content: JSON.stringify({
      ...content,
      checkpointEvidenceEligible: false,
      checkpointEvidenceHint: 'status 只用于检查浏览器状态；提交页面检查点前请使用 snapshot、find、html 或 evaluate 获取 evidenceRef。'
    }, null, 2)
  }
}

function extractionPlan(args: Record<string, unknown>): ScrapeBrowserListExtractionPlan {
  const extraction = objectArg(args, 'extraction')
  const plan: ScrapeBrowserListExtractionPlan = {
    candidateSelector: stringArg(extraction, 'candidateSelector')!,
    detailLinkSelector: stringArg(extraction, 'detailLinkSelector')!,
    ...(stringArg(extraction, 'detailLinkAttribute', false)
      ? { detailLinkAttribute: stringArg(extraction, 'detailLinkAttribute', false) }
      : {}),
    ...(stringArg(extraction, 'codeSelector', false)
      ? { codeSelector: stringArg(extraction, 'codeSelector', false) }
      : {}),
    ...(stringArg(extraction, 'codeAttribute', false)
      ? { codeAttribute: stringArg(extraction, 'codeAttribute', false) }
      : {}),
    ...(stringArg(extraction, 'codePattern', false)
      ? { codePattern: stringArg(extraction, 'codePattern', false) }
      : {}),
    ...(stringArg(extraction, 'titleSelector', false)
      ? { titleSelector: stringArg(extraction, 'titleSelector', false) }
      : {}),
    ...(stringArg(extraction, 'titleAttribute', false)
      ? { titleAttribute: stringArg(extraction, 'titleAttribute', false) }
      : {})
  }
  const advance = objectArg(args, 'advance')
  const terminalProof = playlistImportTerminalProof(advance)
  if (terminalProof) plan.terminalProof = terminalProof
  if (advance.kind === 'load-more') {
    plan.loadMoreSelector = stringArg(advance, 'selector')!
    const afterExhausted = objectArg(advance, 'afterExhausted')
    if (afterExhausted.kind !== 'terminal') {
      plan.nextPageSelector = stringArg(afterExhausted, 'selector')!
    }
  } else if (advance.kind !== 'terminal') {
    plan.nextPageSelector = stringArg(advance, 'selector')!
  }
  if (args.kind === 'virtual-page-start') {
    const enumeration = objectArg(args, 'enumeration')
    if (stringArg(enumeration, 'containerSelector', false)) {
      plan.containerSelector = stringArg(enumeration, 'containerSelector', false)
    }
    if (enumeration.positionKind === 'aria-posinset') {
      plan.position = { kind: 'aria-posinset' }
    } else if (enumeration.positionKind === 'attribute') {
      const base = numberArg(enumeration, 'positionBase')
      if (base !== 0 && base !== 1) {
        throw new Error('PLAYLIST_IMPORT_ARGUMENT_INVALID:positionBase')
      }
      plan.position = {
        kind: 'attribute',
        name: stringArg(enumeration, 'positionAttribute')!,
        base
      }
    } else {
      throw new Error('PLAYLIST_IMPORT_ARGUMENT_INVALID:positionKind')
    }
  }
  return plan
}

function pageKey(pageOrder: number, pageUrl: string): string {
  return `${pageOrder}:${createHash('sha256').update(normalizePlaylistImportUrl(pageUrl)).digest('hex').slice(0, 24)}`
}

function comparableUrl(raw: string): string {
  return normalizePlaylistImportUrl(sanitizeAgentMetadataUrl(raw) || raw)
}

function workPayload(work: PlaylistImportBrowserWork | null): Record<string, unknown> | null {
  return work ? structuredClone(work) : null
}

function playlistNameInstruction(input: PlaylistImportStartInput): string {
  if (input.destination.kind !== 'create') return '本次是追加清单，不提取或提交新清单名称。'
  if (input.destination.requestedName?.trim()) {
    return '用户已填写新清单名称，不提取或提交 suggestedPlaylistName。'
  }
  return '用户未填写新清单名称：在首个清单页从明确页面证据提取 suggestedPlaylistName；没有可靠名称时省略。'
}

type RecoverablePlaylistImportToolFailure = {
  code: 'NETWORK_TIMEOUT' | 'SOURCE_CHANGED'
  message: string
}

type TerminalPlaylistImportToolFailure = {
  code: 'BROWSER_SESSION_LOST' | 'UNSUPPORTED_LIST_STRUCTURE' | 'UNSUPPORTED_PAGINATION'
  message: string
}

function playlistImportTerminalToolFailure(error: unknown): TerminalPlaylistImportToolFailure | null {
  const message = error instanceof Error ? error.message : String(error)
  if (isPlaylistImportBrowserSessionLostMessage(message)) {
    return {
      code: 'BROWSER_SESSION_LOST',
      message: '当前前台浏览器会话已经中断，本次导入无法继续，请重新发起导入。'
    }
  }
  if (/^VIRTUAL_LIST_POSITION_(?:MISSING|INVALID|DUPLICATED)$/u.test(message)) {
    return {
      code: 'UNSUPPORTED_LIST_STRUCTURE',
      message: '当前虚拟列表没有可验证的稳定绝对位置，V1 无法保证完整导入。'
    }
  }
  if (message === 'VIRTUAL_LIST_CONTINUITY_UNPROVEN') {
    return {
      code: 'UNSUPPORTED_PAGINATION',
      message: '当前列表在最小安全滚动步长下仍无法证明窗口连续性，V1 已停止导入。'
    }
  }
  return null
}

function reportedPlaylistImportFailureMessage(code: string, reason: string): string {
  const messages: Record<string, string> = {
    'missing-stable-position': '当前虚拟列表没有稳定的绝对位置标记，V1 无法保证完整导入。',
    'inaccessible-list-structure': '当前清单结构无法通过可见 DOM 和受控选择器完整读取。',
    'cross-origin-frame': '当前清单位于不支持的跨域框架中，V1 无法安全读取。',
    'custom-scroll-without-metrics': '当前清单使用无法测量位置的自定义滚动，V1 无法证明遍历完整。',
    'no-provable-terminal': '当前分页无法提供可验证的终点，V1 已停止导入。',
    'unsupported-cursor-pagination': '当前清单仅提供不支持的游标分页，V1 无法完整遍历。',
    'unbounded-feed': '当前清单是无法证明终点的无限列表，V1 已停止导入。',
    'continuity-unprovable': '当前分页或滚动窗口无法证明连续性，V1 已停止导入。',
    'repeated-scroll-state': '当前滚动状态重复且没有产生新候选，已停止循环。'
  }
  return messages[reason] ?? `${code}: 外部清单无法安全、完整地遍历。`
}

export function playlistImportRecoverableToolFailure(
  error: unknown,
  signal?: AbortSignal
): RecoverablePlaylistImportToolFailure | null {
  const errorMessage = error instanceof Error ? error.message : String(error)
  const signalMessage = signal?.aborted
    ? signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? '')
    : ''
  if (/^SOURCE_CHANGED(?:\b|:)/u.test(errorMessage)) {
    return { code: 'SOURCE_CHANGED', message: errorMessage }
  }
  if (isPlaylistImportBrowserSessionLostMessage(errorMessage)) {
    return null
  }
  if (/timeout|timed out|超时/iu.test(`${signalMessage}\n${errorMessage}`)) {
    return { code: 'NETWORK_TIMEOUT', message: '读取外部页面超时，请从当前检查点重试。' }
  }
  return null
}

export class PlaylistImportAgentRunDriver implements PlaylistImportRunDriver {
  private readonly browser = new AgentMetadataBrowserAdapter()
  private readonly listeners = new Set<(snapshot: PlaylistImportSnapshot) => void>()
  private readonly timelines = new Map<string, AgentMetadataActivityTimeline>()
  private readonly liveEmitTimers = new Map<string, ReturnType<typeof setTimeout>>()

  subscribe(listener: (snapshot: PlaylistImportSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private repository(): PlaylistImportRepository {
    return new PlaylistImportRepository(getDb())
  }

  private timeline(runId: string, initial: PlaylistImportActivity[] = []): AgentMetadataActivityTimeline {
    let timeline = this.timelines.get(runId)
    if (!timeline) {
      timeline = new AgentMetadataActivityTimeline(initial)
      this.timelines.set(runId, timeline)
    }
    return timeline
  }

  decorate(snapshot: PlaylistImportSnapshot): PlaylistImportSnapshot {
    const persisted = agentRunStore.getRun(snapshot.runId)?.productState.activities
    const initial = Array.isArray(persisted) ? persisted as PlaylistImportActivity[] : []
    return {
      ...snapshot,
      activities: this.timeline(snapshot.runId, initial).snapshot()
    }
  }

  private emit(snapshot: PlaylistImportSnapshot): void {
    const decorated = this.decorate(snapshot)
    for (const listener of this.listeners) listener(decorated)
  }

  private describeTool(
    runId: string,
    callId: string,
    tool: string,
    args: Record<string, unknown>
  ): void {
    if (!this.timeline(runId).describeTool(callId, tool, args)) return
    const snapshot = this.repository().snapshot(runId)
    if (snapshot) this.emit(snapshot)
  }

  private notify(runId: string, event: RuntimeObservation): void {
    if (event.type !== 'reasoning.delta' && event.type !== 'tool.progress') return
    if (!this.timeline(runId).observe(event) || this.liveEmitTimers.has(runId)) return
    const timer = setTimeout(() => {
      this.liveEmitTimers.delete(runId)
      const snapshot = this.repository().snapshot(runId)
      if (snapshot) this.emit(snapshot)
    }, 60)
    this.liveEmitTimers.set(runId, timer)
  }

  private clearLiveEmit(runId: string): void {
    const timer = this.liveEmitTimers.get(runId)
    if (timer) clearTimeout(timer)
    this.liveEmitTimers.delete(runId)
  }

  private recordBrowserHandoff(runId: string, handoff: AgentMetadataBrowserHandoff): void {
    const waiting = this.repository().setBrowserHandoff({
      runId,
      requestId: handoff.requestId,
      reason: handoff.reason,
      prompt: handoff.prompt
    })
    this.emit(waiting)
  }

  private requestBrowserHandoff(
    runId: string,
    reason: AgentMetadataBrowserHandoff['reason'],
    signal: AbortSignal
  ): Promise<HostedToolResult> {
    return this.browser.execute({
      runId,
      args: { action: 'handoff', reason },
      signal,
      onHandoff: (handoff) => this.recordBrowserHandoff(runId, handoff)
    })
  }

  private async waitForLoadMoreExtraction(
    runId: string,
    plan: ScrapeBrowserListExtractionPlan,
    minimumItemCount: number,
    signal: AbortSignal
  ): Promise<Awaited<ReturnType<AgentMetadataBrowserAdapter['extractList']>>> {
    return this.waitForStableListExpansion(
      runId,
      plan,
      (extracted) => extracted.items.length >= minimumItemCount,
      signal
    )
  }

  private async waitForVirtualLoadMoreExpansion(
    runId: string,
    plan: ScrapeBrowserListExtractionPlan,
    before: Awaited<ReturnType<AgentMetadataBrowserAdapter['extractList']>>,
    signal: AbortSignal
  ): Promise<Awaited<ReturnType<AgentMetadataBrowserAdapter['extractList']>>> {
    const beforeHeight = before.scrollState?.after.scrollHeight ?? 0
    const beforeKeys = new Set(before.items.map((item) => (
      `${item.absolutePosition ?? ''}:${normalizePlaylistImportUrl(item.detailUrl)}`
    )))
    return this.waitForStableListExpansion(
      runId,
      plan,
      (extracted) => (
        (extracted.scrollState?.after.scrollHeight ?? 0) > beforeHeight + 0.5 ||
        extracted.items.some((item) => !beforeKeys.has(
          `${item.absolutePosition ?? ''}:${normalizePlaylistImportUrl(item.detailUrl)}`
        ))
      ),
      signal
    )
  }

  private async waitForStableListExpansion(
    runId: string,
    plan: ScrapeBrowserListExtractionPlan,
    hasProgress: (
      extracted: Awaited<ReturnType<AgentMetadataBrowserAdapter['extractList']>>
    ) => boolean,
    signal: AbortSignal
  ): Promise<Awaited<ReturnType<AgentMetadataBrowserAdapter['extractList']>>> {
    const deadline = Date.now() + 10_000
    let stability = { progressObserved: false }
    while (true) {
      signal.throwIfAborted()
      const extracted = await this.browser.extractList({ runId, plan, signal })
      const observedAt = Date.now()
      const signature = createHash('sha256').update(JSON.stringify({
        items: extracted.items.map((item) => ({
          position: item.absolutePosition,
          occurrenceKey: item.occurrenceKey,
          detailUrl: normalizePlaylistImportUrl(item.detailUrl),
          code: item.code,
          title: item.title
        })),
        nextPageUrls: extracted.nextPageUrls,
        terminalVerified: extracted.terminalVerified,
        loadMoreAvailable: extracted.loadMoreAvailable,
        containerFingerprint: extracted.containerFingerprint,
        scrollMetrics: extracted.scrollState?.after
      })).digest('hex')
      const observation = observePlaylistImportDynamicStability({
        state: stability,
        progressed: hasProgress(extracted),
        signature,
        observedAt
      })
      stability = observation.state
      if (observation.settled) return extracted
      if (observedAt >= deadline) {
        const failed = this.repository().failPaginationNoProgress(
          runId,
          'PAGINATION_LOOP',
          '加载更多操作没有产生新的候选或分页状态，已停止重复尝试。'
        )
        this.emit(failed)
        throw new Error('PAGINATION_LOOP')
      }
      await this.browser.hostAction({
        runId,
        command: { action: 'wait', timeoutMs: 250 },
        signal
      })
    }
  }

  private currentUrl(runId: string): string {
    return comparableUrl(this.browser.source(runId).displayUrl)
  }

  private assertCurrentWork(
    runId: string,
    expectedKind: 'list'
  ): Extract<PlaylistImportBrowserWork, { kind: 'list' }>
  private assertCurrentWork(
    runId: string,
    expectedKind: 'detail'
  ): Extract<PlaylistImportBrowserWork, { kind: 'detail' }>
  private assertCurrentWork(
    runId: string,
    expectedKind: PlaylistImportBrowserWork['kind']
  ): PlaylistImportBrowserWork {
    const repository = this.repository()
    const work = expectedKind === 'list'
      ? repository.inFlightListBrowserWork(runId)
      : repository.nextBrowserWork(runId)
    if (!work || (expectedKind && work.kind !== expectedKind)) {
      throw new Error('PLAYLIST_IMPORT_BROWSER_WORK_INVALID')
    }
    if (this.currentUrl(runId) !== comparableUrl(work.url)) {
      throw new Error('PLAYLIST_IMPORT_BROWSER_PAGE_MISMATCH')
    }
    return work
  }

  private assertCurrentObservation(
    runId: string,
    documentRevision: string,
    viewRevision: string
  ): NonNullable<ReturnType<AgentMetadataBrowserAdapter['observation']>> {
    const observation = this.browser.observation(runId)
    if (
      !observation ||
      observation.documentRevision !== documentRevision ||
      observation.viewRevision !== viewRevision
    ) {
      throw new Error('PLAYLIST_IMPORT_BROWSER_EVIDENCE_STALE')
    }
    return observation
  }

  private async captureExtractionEvidence(
    runId: string,
    extracted: Awaited<ReturnType<AgentMetadataBrowserAdapter['extractList']>>,
    signal: AbortSignal
  ): Promise<string> {
    const evidence = await this.browser.captureEvidence({ runId, signal })
    if (
      evidence.documentRevision !== extracted.documentRevision ||
      evidence.viewRevision !== extracted.viewRevision
    ) {
      throw new Error('PLAYLIST_IMPORT_BROWSER_EVIDENCE_STALE')
    }
    return evidence.evidenceRef
  }

  private async scrollVirtualWithContinuity(
    runId: string,
    plan: ScrapeBrowserListExtractionPlan,
    knownPositions: Iterable<number>,
    signal: AbortSignal
  ): Promise<{
    scrolled: Awaited<ReturnType<AgentMetadataBrowserAdapter['hostAction']>>
    extracted: Awaited<ReturnType<AgentMetadataBrowserAdapter['extractList']>>
  }> {
    const known = new Set(knownPositions)
    const anchor = known.size > 0 ? Math.max(...known) : null
    const amounts = ['half-viewport', 'quarter-viewport', 'eighth-viewport'] as const
    for (const [index, amount] of amounts.entries()) {
      const scrolled = await this.browser.hostAction({
        runId,
        command: {
          action: 'scroll',
          ...(plan.containerSelector ? { target: plan.containerSelector } : {}),
          direction: 'down',
          amount
        },
        signal
      })
      const extracted = await this.browser.extractList({ runId, plan, signal })
      const positions = extracted.items.map((item) => item.absolutePosition)
      if (positions.some((position) => position == null || !Number.isInteger(position) || position < 0)) {
        throw new Error('VIRTUAL_LIST_POSITION_MISSING')
      }
      const merged = [...new Set([
        ...known,
        ...(positions as number[])
      ])].sort((left, right) => left - right)
      if (merged.every((position, expected) => position === expected)) {
        return { scrolled, extracted }
      }
      if (index === amounts.length - 1) {
        throw new Error('VIRTUAL_LIST_CONTINUITY_UNPROVEN')
      }
      await this.browser.hostAction({
        runId,
        command: {
          action: 'scroll',
          ...(plan.containerSelector ? { target: plan.containerSelector } : {}),
          direction: 'up',
          amount
        },
        signal
      })
      const anchored = await this.browser.extractList({ runId, plan, signal })
      if (
        anchor != null &&
        !anchored.items.some((item) => item.absolutePosition === anchor)
      ) {
        throw new Error('SOURCE_CHANGED:VIRTUAL_ANCHOR')
      }
    }
    throw new Error('VIRTUAL_LIST_CONTINUITY_UNPROVEN')
  }

  private result(runId: string, snapshot: PlaylistImportSnapshot): HostedToolResult {
    let current = snapshot
    if (current.phase === 'ready-to-apply') {
      try {
        this.repository().apply(runId, `auto-apply:${runId}`)
      } catch (error) {
        current = this.repository().snapshot(runId)!
        if (current.phase !== 'failed' && !(current.phase === 'ready-to-apply' && current.error)) {
          throw error
        }
      }
      current = this.repository().snapshot(runId)!
    }
    this.emit(current)
    const terminal = ['completed', 'waiting_user', 'failed', 'cancelled'].includes(current.phase)
    return {
      ok: current.phase !== 'failed' && !current.error,
      content: JSON.stringify({
        phase: current.phase,
        summary: current.summary,
        progress: current.progress,
        ...(current.error ? { error: current.error } : {}),
        nextWork: workPayload(this.repository().nextBrowserWork(runId))
      }),
      summary: current.summary,
      ...(terminal ? { terminate: true } : {}),
      recovery: { phase: current.phase, revision: current.revision }
    }
  }

  private recoverableToolHandler(runId: string, handler: ToolHandler): ToolHandler {
    return async (context) => {
      try {
        return await handler(context)
      } catch (error) {
        if (isScrapeBrowserChallengeError(error)) {
          return this.requestBrowserHandoff(runId, 'human_verification', context.signal)
        }
        const failure = playlistImportRecoverableToolFailure(error, context.signal)
        if (failure) {
          return this.result(
            runId,
            this.repository().markRecoverableError(runId, failure.code, failure.message)
          )
        }
        const terminal = playlistImportTerminalToolFailure(error)
        if (terminal) {
          return this.result(
            runId,
            this.repository().fail(runId, terminal.code, terminal.message)
          )
        }
        throw error
      }
    }
  }

  createToolHandlers(runId: string) {
    const handlers = createPlaylistImporterToolHandlers({
        browser: async (args, signal, callId) => {
          this.describeTool(runId, callId, 'browser', args)
          const requestedAction = stringArg(args, 'action')!
          const work = this.repository().nextBrowserWork(runId)
          if (!work) throw new Error('PLAYLIST_IMPORT_BROWSER_WORK_MISSING')
          const result = await this.browser.execute({
            runId,
            args,
            signal,
            onHandoff: (handoff) => this.recordBrowserHandoff(runId, handoff)
          })
          if (!result.ok) {
            const failure = playlistImportRecoverableToolFailure(
              new Error(result.content || result.summary),
              signal
            )
            if (failure) {
              return this.result(
                runId,
                this.repository().markRecoverableError(runId, failure.code, failure.message)
              )
            }
          }
          return requestedAction === 'status'
            ? withoutCheckpointEvidenceForStatus(result)
            : result
        },
        checkpointPage: async (args, signal, callId) => {
          this.describeTool(runId, callId, 'checkpoint_playlist_page', args)
          signal.throwIfAborted()
          const repository = this.repository()
          const currentWork = repository.inFlightListBrowserWork(runId)
          const currentPageUrl = this.currentUrl(runId)
          const pageOrder = currentWork?.kind === 'list' &&
            currentPageUrl === comparableUrl(currentWork.url)
            ? currentWork.pageOrder
            : args.kind === 'static-page'
              ? repository.replayableStaticPageOrder(runId, currentPageUrl)
              : null
          if (pageOrder == null) throw new Error('PLAYLIST_IMPORT_BROWSER_WORK_INVALID')
          let evidenceRef = stringArg(args, 'evidenceRef')!
          const plan = extractionPlan(args)
          if (args.kind === 'virtual-page-start') {
            const reset = await this.browser.hostAction({
              runId,
              command: {
                action: 'scroll',
                ...(plan.containerSelector ? { target: plan.containerSelector } : {}),
                direction: 'start'
              },
              signal
            })
            assertPlaylistImportVirtualStart(reset.scrollState)
          }
          const extracted = await this.browser.extractList({ runId, plan, signal })
          if (args.kind === 'virtual-page-start') {
            assertPlaylistImportVirtualStart(extracted.scrollState)
            evidenceRef = await this.captureExtractionEvidence(runId, extracted, signal)
          } else {
            this.browser.assertCurrentEvidenceRef(runId, evidenceRef, {
              documentRevision: extracted.documentRevision,
              viewRevision: extracted.viewRevision
            })
          }
          if (comparableUrl(extracted.url) !== currentPageUrl) {
            throw new Error('PLAYLIST_IMPORT_CHECKPOINT_PAGE_MISMATCH')
          }
          const advance = objectArg(args, 'advance')
          const isLoadMore = advance.kind === 'load-more'
          const terminal = advance.kind === 'terminal'
          if (shouldValidatePlaylistImportAdvanceAtCheckpoint(String(args.kind), advance)) {
            assertPlaylistImportTerminalVerified({
              advance,
              terminalVerified: extracted.terminalVerified,
              ...(typeof args.declaredTotalItems === 'number'
                ? { declaredTotalItems: numberArg(args, 'declaredTotalItems') }
                : {}),
              ...(typeof args.declaredTotalPages === 'number'
                ? { declaredTotalPages: numberArg(args, 'declaredTotalPages') }
                : {})
            })
            if (isLoadMore && extracted.loadMoreAvailable !== true) {
              throw new Error('PLAYLIST_IMPORT_LOAD_MORE_NOT_FOUND')
            }
            if (!terminal && !isLoadMore && extracted.nextPageUrls.length === 0) {
              throw new Error('PLAYLIST_IMPORT_NEXT_PAGE_NOT_FOUND')
            }
          }
          const common = {
            runId,
            pageKey: pageKey(pageOrder, extracted.url),
            pageOrder,
            pageUrl: extracted.url,
            documentRevision: extracted.documentRevision,
            evidenceRef,
            ...(stringArg(args, 'suggestedPlaylistName', false)
              ? { suggestedPlaylistName: stringArg(args, 'suggestedPlaylistName', false) }
              : {}),
            ...(typeof args.declaredTotalItems === 'number'
              ? { declaredTotalItems: numberArg(args, 'declaredTotalItems') }
              : {}),
            ...(typeof args.declaredTotalPages === 'number'
              ? { declaredTotalPages: numberArg(args, 'declaredTotalPages') }
              : {})
          }
          if (args.kind === 'static-page') {
            if (isLoadMore) throw new Error('PLAYLIST_IMPORT_ARGUMENT_INVALID:kind')
            return this.result(runId, repository.checkpointStaticPage({
              ...common,
              viewRevision: extracted.viewRevision,
              items: extracted.items,
              nextPageUrls: extracted.nextPageUrls,
              terminal
            }))
          }
          if (args.kind === 'load-more-page-start') {
            if (!isLoadMore) throw new Error('PLAYLIST_IMPORT_ARGUMENT_INVALID:advance')
            const positioned = extracted.items.map((item, absolutePosition) => ({
              ...item,
              absolutePosition,
              occurrenceKey: `${absolutePosition}:${normalizePlaylistImportUrl(item.detailUrl)}`
            }))
            return this.result(runId, repository.checkpointVirtualBatch({
              ...common,
              enumerationKind: 'load-more',
              initialViewRevision: extracted.viewRevision,
              operationKey: `load-more:start:${extracted.documentRevision}:${extracted.viewRevision}`,
              batchOrder: 0,
              viewRevision: extracted.viewRevision,
              positionMode: 'overlap',
              containerFingerprint: extracted.containerFingerprint!,
              scrollState: {
                scrollTop: extracted.scrollState?.after.scrollTop ?? 0,
                scrollHeight: extracted.scrollState?.after.scrollHeight ?? 0,
                clientHeight: extracted.scrollState?.after.clientHeight ?? 0,
                atStart: true,
                atEnd: false,
                moved: false,
                settled: true
              },
              items: positioned,
              accumulatedSequenceDigest: createHash('sha256')
                .update(JSON.stringify(positioned
                  .map((item) => [item.absolutePosition, item.occurrenceKey] as const)
                  .sort((left, right) => left[0] - right[0])))
                .digest('hex'),
              terminalProbeCount: 0,
              seal: false,
              nextPageUrls: [],
              containerContract: { plan, advance }
            }))
          }
          if (args.kind !== 'virtual-page-start' || !extracted.scrollState) {
            throw new Error('PLAYLIST_IMPORT_ARGUMENT_INVALID:kind')
          }
          const positioned = extracted.items.map((item) => {
            if (item.absolutePosition == null || !item.occurrenceKey) {
              throw new Error('VIRTUAL_LIST_POSITION_MISSING')
            }
            return {
              ...item,
              absolutePosition: item.absolutePosition,
              occurrenceKey: item.occurrenceKey
            }
          })
          const terminalProbeCount = extracted.scrollState.atEnd ? 1 : 0
          return this.result(runId, repository.checkpointVirtualBatch({
            ...common,
            initialViewRevision: extracted.viewRevision,
            operationKey: `start:${extracted.documentRevision}:${extracted.viewRevision}`,
            batchOrder: 0,
            viewRevision: extracted.viewRevision,
            positionMode: plan.position?.kind === 'aria-posinset' ? 'aria-posinset' : 'attribute',
            containerFingerprint: extracted.containerFingerprint!,
            scrollState: {
              scrollTop: extracted.scrollState.after.scrollTop,
              scrollHeight: extracted.scrollState.after.scrollHeight,
              clientHeight: extracted.scrollState.after.clientHeight,
              atStart: extracted.scrollState.atStart,
              atEnd: extracted.scrollState.atEnd,
              moved: false,
              settled: extracted.scrollState.settled
            },
            items: positioned,
            accumulatedSequenceDigest: createHash('sha256')
              .update(JSON.stringify(positioned
                .map((item) => [item.absolutePosition, item.occurrenceKey] as const)
                .sort((left, right) => left[0] - right[0])))
              .digest('hex'),
            terminalProbeCount,
            seal: false,
            nextPageUrls: extracted.nextPageUrls,
            containerContract: { plan, advance }
          }))
        },
        advancePage: async (args, signal, callId) => {
          this.describeTool(runId, callId, 'advance_playlist_page', args)
          signal.throwIfAborted()
          const repository = this.repository()
          const dynamic = repository.openDynamicPage(runId)
          if (!dynamic) {
            const activeWork = repository.inFlightListBrowserWork(runId)
            if (activeWork && this.currentUrl(runId) === comparableUrl(activeWork.url)) {
              return this.result(runId, repository.markRecoverableError(
                runId,
                'PAGE_CHECKPOINT_REQUIRED',
                '离开当前清单页前必须先固化页面检查点。'
              ))
            }
            const work = activeWork ?? repository.claimNextListBrowserWork(runId)
            if (this.currentUrl(runId) !== comparableUrl(work.url)) {
              await this.browser.hostAction({
                runId,
                command: { action: 'open', url: work.url },
                signal
              })
            }
            return this.result(runId, repository.snapshot(runId)!)
          }
          if (this.currentUrl(runId) !== comparableUrl(dynamic.pageUrl)) {
            throw new Error('PLAYLIST_IMPORT_BROWSER_PAGE_MISMATCH')
          }
          const contract = dynamic.containerContract
          const plan = contract.plan as ScrapeBrowserListExtractionPlan
          const advance = contract.advance as Record<string, unknown>
          if (dynamic.enumerationKind === 'load-more') {
            const selector = stringArg(advance, 'selector')!
            await this.browser.hostAction({
              runId,
              command: { action: 'click', target: selector },
              signal
            })
            const extracted = await this.waitForLoadMoreExtraction(
              runId,
              plan,
              dynamic.occurrences.length + 1,
              signal
            )
            const positioned = extracted.items.map((item, absolutePosition) => ({
              ...item,
              absolutePosition,
              occurrenceKey: `${absolutePosition}:${normalizePlaylistImportUrl(item.detailUrl)}`
            }))
            const seal = extracted.loadMoreAvailable !== true
            const evidenceRef = await this.captureExtractionEvidence(runId, extracted, signal)
            const afterExhausted = objectArg(advance, 'afterExhausted')
            if (
              seal &&
              afterExhausted.kind !== 'terminal' &&
              extracted.nextPageUrls.length === 0
            ) {
              throw new Error('PLAYLIST_IMPORT_NEXT_PAGE_NOT_FOUND')
            }
            return this.result(runId, repository.checkpointVirtualBatch({
              runId,
              pageKey: dynamic.pageKey,
              pageOrder: dynamic.pageOrder,
              pageUrl: dynamic.pageUrl,
              documentRevision: dynamic.documentRevision,
              initialViewRevision: dynamic.initialViewRevision,
              evidenceRef,
              enumerationKind: 'load-more',
              operationKey: `load-more:${dynamic.nextBatchOrder}:${extracted.viewRevision}`,
              batchOrder: dynamic.nextBatchOrder,
              viewRevision: extracted.viewRevision,
              positionMode: 'overlap',
              containerFingerprint: extracted.containerFingerprint!,
              scrollState: {
                scrollTop: extracted.scrollState?.after.scrollTop ?? 0,
                scrollHeight: extracted.scrollState?.after.scrollHeight ?? 0,
                clientHeight: extracted.scrollState?.after.clientHeight ?? 0,
                atStart: false,
                atEnd: seal,
                moved: true,
                settled: true
              },
              items: positioned,
              accumulatedSequenceDigest: createHash('sha256')
                .update(JSON.stringify(positioned.map((item) => item.occurrenceKey)))
                .digest('hex'),
              terminalProbeCount: 0,
              seal,
              nextPageUrls: seal ? extracted.nextPageUrls : []
            }))
          }
          if (advance.kind === 'load-more' && dynamic.terminalProbeCount >= 2) {
            const beforeExpansion = await this.browser.extractList({ runId, plan, signal })
            if (
              beforeExpansion.containerFingerprint !==
              dynamic.batches[0]?.containerFingerprint
            ) {
              throw new Error('SOURCE_CHANGED:CONTAINER')
            }
            const decision = playlistImportVirtualAdvanceDecision({
              terminalProbeCount: dynamic.terminalProbeCount,
              hasLoadMoreContract: true,
              loadMoreAvailable: beforeExpansion.loadMoreAvailable
            })
            if (decision === 'load-more') {
              await this.browser.hostAction({
                runId,
                command: { action: 'click', target: stringArg(advance, 'selector')! },
                signal
              })
              const extracted = await this.waitForVirtualLoadMoreExpansion(
                runId,
                plan,
                beforeExpansion,
                signal
              )
              if (!extracted.scrollState) {
                throw new Error('PLAYLIST_IMPORT_SCROLL_EVIDENCE_MISSING')
              }
              const positioned = extracted.items.map((item) => {
                if (item.absolutePosition == null || !item.occurrenceKey) {
                  throw new Error('VIRTUAL_LIST_POSITION_MISSING')
                }
                return {
                  ...item,
                  absolutePosition: item.absolutePosition,
                  occurrenceKey: item.occurrenceKey
                }
              })
              const mergedKeys = new Map<number, string>()
              for (const occurrence of dynamic.occurrences) {
                mergedKeys.set(occurrence.position, occurrence.key)
              }
              for (const item of positioned) mergedKeys.set(item.absolutePosition, item.occurrenceKey)
              const accumulatedSequenceDigest = createHash('sha256')
                .update(JSON.stringify([...mergedKeys.entries()].sort((a, b) => a[0] - b[0])))
                .digest('hex')
              const terminalProbeCount = extracted.scrollState.atEnd ? 1 : 0
              const evidenceRef = await this.captureExtractionEvidence(runId, extracted, signal)
              return this.result(runId, repository.checkpointVirtualBatch({
                runId,
                pageKey: dynamic.pageKey,
                pageOrder: dynamic.pageOrder,
                pageUrl: dynamic.pageUrl,
                documentRevision: dynamic.documentRevision,
                initialViewRevision: dynamic.initialViewRevision,
                evidenceRef,
                operationKey: `virtual-load-more:${dynamic.nextBatchOrder}:${callId}`,
                batchOrder: dynamic.nextBatchOrder,
                viewRevision: extracted.viewRevision,
                positionMode: plan.position?.kind === 'aria-posinset' ? 'aria-posinset' : 'attribute',
                containerFingerprint: extracted.containerFingerprint!,
                scrollState: {
                  scrollTop: extracted.scrollState.after.scrollTop,
                  scrollHeight: extracted.scrollState.after.scrollHeight,
                  clientHeight: extracted.scrollState.after.clientHeight,
                  atStart: extracted.scrollState.atStart,
                  atEnd: extracted.scrollState.atEnd,
                  moved: false,
                  settled: extracted.scrollState.settled
                },
                items: positioned,
                accumulatedSequenceDigest,
                terminalProbeCount,
                seal: false,
                nextPageUrls: []
              }))
            }
          }
          let advanced: Awaited<ReturnType<
            PlaylistImportAgentRunDriver['scrollVirtualWithContinuity']
          >>
          try {
            advanced = await this.scrollVirtualWithContinuity(
              runId,
              plan,
              dynamic.occurrences.map((occurrence) => occurrence.position),
              signal
            )
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === 'VIRTUAL_LIST_CONTINUITY_UNPROVEN'
            ) {
              return this.result(runId, repository.fail(
                runId,
                'UNSUPPORTED_PAGINATION',
                '虚拟列表无法与最后检查点连续衔接，减小到八分之一视口后仍存在位置缺口。'
              ))
            }
            throw error
          }
          const { scrolled, extracted } = advanced
          if (!scrolled.scrollState) throw new Error('PLAYLIST_IMPORT_SCROLL_EVIDENCE_MISSING')
          const positioned = extracted.items.map((item) => {
            if (item.absolutePosition == null || !item.occurrenceKey) {
              throw new Error('VIRTUAL_LIST_POSITION_MISSING')
            }
            return { ...item, absolutePosition: item.absolutePosition, occurrenceKey: item.occurrenceKey }
          })
          const mergedKeys = new Map<number, string>()
          for (const occurrence of dynamic.occurrences) {
            mergedKeys.set(occurrence.position, occurrence.key)
          }
          for (const item of positioned) mergedKeys.set(item.absolutePosition, item.occurrenceKey)
          const accumulatedSequenceDigest = createHash('sha256')
            .update(JSON.stringify([...mergedKeys.entries()].sort((a, b) => a[0] - b[0])))
            .digest('hex')
          const previousBatch = dynamic.batches.at(-1)
          const closeEnough = (left: number, right: number): boolean => Math.abs(left - right) <= 0.5
          const stableTerminalProbe = Boolean(
            previousBatch?.atEnd &&
            closeEnough(previousBatch.scrollTop, scrolled.scrollState.after.scrollTop) &&
            closeEnough(previousBatch.scrollHeight, scrolled.scrollState.after.scrollHeight) &&
            closeEnough(previousBatch.clientHeight, scrolled.scrollState.after.clientHeight) &&
            previousBatch.accumulatedSequenceDigest === accumulatedSequenceDigest
          )
          const terminalProbeCount = scrolled.scrollState.atEnd && !scrolled.scrollState.moved
            ? (stableTerminalProbe ? dynamic.terminalProbeCount + 1 : 1)
            : 0
          if (
            previousBatch &&
            !scrolled.scrollState.moved &&
            !scrolled.scrollState.atEnd &&
            closeEnough(previousBatch.scrollTop, scrolled.scrollState.after.scrollTop) &&
            closeEnough(previousBatch.scrollHeight, scrolled.scrollState.after.scrollHeight) &&
            closeEnough(previousBatch.clientHeight, scrolled.scrollState.after.clientHeight) &&
            previousBatch.accumulatedSequenceDigest === accumulatedSequenceDigest
          ) {
            return this.result(runId, repository.checkpointScrollStall(
              runId,
              '虚拟列表未到达底部且滚动没有产生新窗口；可从最后检查点重试一次。'
            ))
          }
          const afterExhausted = advance.kind === 'load-more'
            ? objectArg(advance, 'afterExhausted')
            : advance
          const decision = playlistImportVirtualAdvanceDecision({
            terminalProbeCount,
            hasLoadMoreContract: advance.kind === 'load-more',
            loadMoreAvailable: extracted.loadMoreAvailable
          })
          const seal = decision === 'seal'
          if (seal) {
            assertPlaylistImportFinalAdvance({
              advance: afterExhausted,
              terminalVerified: extracted.terminalVerified,
              loadMoreAvailable: extracted.loadMoreAvailable,
              nextPageCount: extracted.nextPageUrls.length
            })
          }
          const evidenceRef = await this.captureExtractionEvidence(runId, extracted, signal)
          return this.result(runId, repository.checkpointVirtualBatch({
            runId,
            pageKey: dynamic.pageKey,
            pageOrder: dynamic.pageOrder,
            pageUrl: dynamic.pageUrl,
            documentRevision: dynamic.documentRevision,
            initialViewRevision: dynamic.initialViewRevision,
            evidenceRef,
            operationKey: `scroll:${dynamic.nextBatchOrder}:${scrolled.viewRevision}`,
            batchOrder: dynamic.nextBatchOrder,
            viewRevision: extracted.viewRevision,
            positionMode: plan.position?.kind === 'aria-posinset' ? 'aria-posinset' : 'attribute',
            containerFingerprint: scrolled.scrollState.containerFingerprint,
            scrollState: {
              scrollTop: scrolled.scrollState.after.scrollTop,
              scrollHeight: scrolled.scrollState.after.scrollHeight,
              clientHeight: scrolled.scrollState.after.clientHeight,
              atStart: scrolled.scrollState.atStart,
              atEnd: scrolled.scrollState.atEnd,
              moved: scrolled.scrollState.moved,
              settled: scrolled.scrollState.settled
            },
            items: positioned,
            accumulatedSequenceDigest,
            terminalProbeCount,
            seal,
            nextPageUrls: seal ? extracted.nextPageUrls : []
          }))
        },
        reportFailure: async (args, signal, callId) => {
          this.describeTool(runId, callId, 'report_playlist_import_failure', args)
          signal.throwIfAborted()
          this.assertCurrentWork(runId, 'list')
          const documentRevision = stringArg(args, 'documentRevision')!
          const viewRevision = stringArg(args, 'viewRevision')!
          const evidenceRef = stringArg(args, 'evidenceRef')!
          this.assertCurrentObservation(runId, documentRevision, viewRevision)
          this.browser.assertCurrentEvidenceRef(runId, evidenceRef, {
            documentRevision,
            viewRevision
          })
          const code = stringArg(args, 'code')!
          if (!['UNSUPPORTED_LIST_STRUCTURE', 'UNSUPPORTED_PAGINATION', 'SCROLL_LOOP'].includes(code)) {
            throw new Error('PLAYLIST_IMPORT_ARGUMENT_INVALID:code')
          }
          const reason = stringArg(args, 'reason')!
          return this.result(runId, this.repository().fail(
            runId,
            code,
            reportedPlaylistImportFailureMessage(code, reason)
          ))
        },
        openItemDetail: async (args, signal, callId) => {
          this.describeTool(runId, callId, 'open_playlist_item_detail', args)
          const work = this.repository().nextBrowserWork(runId)
          if (!work || work.kind !== 'detail') throw new Error('PLAYLIST_IMPORT_BROWSER_WORK_INVALID')
          await this.browser.hostAction({
            runId,
            command: { action: 'open', url: work.url },
            signal
          })
          return this.result(runId, this.repository().snapshot(runId)!)
        },
        checkpointDetail: async (args, signal, callId) => {
          this.describeTool(runId, callId, 'checkpoint_playlist_detail', args)
          signal.throwIfAborted()
          const repository = this.repository()
          const itemId = numberArg(args, 'itemId')
          const expectedItemRevision = numberArg(args, 'expectedItemRevision')
          const evidenceRef = stringArg(args, 'evidenceRef')!
          const documentRevision = stringArg(args, 'documentRevision')!
          const viewRevision = stringArg(args, 'viewRevision')!
          const checkpoint = {
            runId,
            itemId,
            expectedItemRevision,
            ...(stringArg(args, 'detailCode', false)
              ? { detailCode: stringArg(args, 'detailCode', false) }
              : {}),
            identity: args.identity && typeof args.identity === 'object' && !Array.isArray(args.identity)
              ? args.identity as Record<string, unknown>
              : {},
            evidenceRef
          }
          const work = repository.nextBrowserWork(runId)
          const expectedUrl = work?.kind === 'detail' &&
            itemId === work.itemId && expectedItemRevision === work.itemRevision
            ? work.url
            : repository.replayableDetailCheckpointUrl(checkpoint)
          if (!expectedUrl || this.currentUrl(runId) !== comparableUrl(expectedUrl)) {
            throw new Error('PLAYLIST_IMPORT_DETAIL_WORK_MISMATCH')
          }
          this.assertCurrentObservation(runId, documentRevision, viewRevision)
          this.browser.assertCurrentEvidenceRef(runId, evidenceRef, {
            documentRevision,
            viewRevision
          })
          return this.result(runId, repository.checkpointDetailIdentity(checkpoint))
        }
      })
    return new Map(
      [...handlers].map(([name, handler]) => [name, this.recoverableToolHandler(runId, handler)])
    )
  }

  private registerTools(
    runId: string,
    profile: PersistedRunConfigurationSnapshot['profile']
  ) {
    return toolHost.registerRun({
      runId,
      profile,
      status: () => agentRunStore.getRun(runId)?.status ?? 'closed',
      operationId: () => agentRunStore.getRun(runId)?.activeOperationId,
      handlers: this.createToolHandlers(runId)
    })
  }

  private resolveConfiguration(runId: string): ResolvedRunConfiguration {
    const { revision, profile, definition, workload } = agentConfiguration.getProfile(
      'profile:playlist-importer:default'
    )
    const primary = modelControlPlane.resolveWorkloadModel('library-curator')
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
      tools: this.registerTools(runId, profile),
      settings: {
        compaction: profile.compaction,
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000 },
        maxTurns: workload.limits.maxTurns
      },
      sessionDirectory: sessionDirectory(runId)
    }
  }

  private project(runId: string, event: RuntimeDurableObservation): {
    state: Record<string, unknown>
    status: 'running' | 'waiting_user' | 'settled' | 'failed' | 'cancelled'
  } {
    this.timeline(runId).observe(event)
    let snapshot = this.repository().snapshot(runId)!
    if (event.type === 'runtime.fault') {
      snapshot = this.repository().fail(runId, 'RUNTIME_FAULT', event.message)
    } else if (event.type === 'limit.reached') {
      snapshot = this.repository().fail(
        runId,
        'TURN_LIMIT_REACHED',
        '外部清单 Agent 达到模型轮次上限，未能完成导入。'
      )
    } else if (
      event.type === 'agent.settled' &&
      !['completed', 'waiting_user', 'failed', 'cancelled'].includes(snapshot.phase) &&
      !snapshot.error?.retryable
    ) {
      snapshot = this.repository().fail(
        runId,
        'RESULT_NOT_SUBMITTED',
        '外部清单 Agent 已结束，但没有完成当前页面检查点。'
      )
    }
    this.emit(snapshot)
    if (event.type === 'agent.settled') {
      this.clearLiveEmit(runId)
      const terminal = ['completed', 'failed', 'cancelled'].includes(snapshot.phase)
      if (terminal) {
        toolHost.disposeRun(runId)
        void Promise.allSettled([
          this.browser.release(runId, 'Playlist import Agent settled'),
          agentExecution.closeRun(runId)
        ])
      }
    }
    const status = snapshot.error?.retryable && snapshot.error.code !== 'PAGE_CHECKPOINT_REQUIRED'
      ? 'waiting_user'
      : snapshot.phase === 'waiting_user'
      ? 'waiting_user'
      : snapshot.phase === 'failed'
        ? 'failed'
        : snapshot.phase === 'cancelled'
          ? 'cancelled'
          : snapshot.phase === 'completed'
            ? 'settled'
            : 'running'
    return {
      state: structuredClone(this.decorate(snapshot)) as unknown as Record<string, unknown>,
      status
    }
  }

  async create(
    runId: string,
    initialState: PlaylistImportSnapshot,
    onRunPersisted: () => void
  ): Promise<void> {
    this.timeline(runId, initialState.activities ?? [])
    await this.browser.openSession({
      runId,
      sourceUrl: initialState.frozenInput.sourceUrl,
      workspaceDirectory: sessionDirectory(runId)
    })
    const resolved = this.resolveConfiguration(runId)
    await agentExecution.openRun({
      runId,
      useCase: 'playlist-importer',
      resolved,
      productState: structuredClone(this.decorate(initialState)) as unknown as Record<string, unknown>,
      notify: (event) => this.notify(runId, event),
      project: (event) => this.project(runId, event),
      afterPersist: onRunPersisted
    })
  }

  async start(runId: string, input: PlaylistImportStartInput): Promise<void> {
    const work = this.repository().claimNextListBrowserWork(runId)
    const dispatched = await agentExecution.dispatch({
      runId,
      kind: 'prompt',
      idempotencyKey: input.idempotencyKey,
      text: [
        `用户已冻结外部清单：${input.sourceUrl}`,
        playlistNameInstruction(input),
        `当前唯一允许的工作项：${JSON.stringify(workPayload(work))}`,
        '请先用 browser open 打开上述唯一工作项，再根据页面事实决定导航、交互或 handoff；确认进入目标清单页后，离开前必须提交 selector 页面检查点。'
      ].join('\n')
    })
    if (!dispatched.accepted) throw new Error('PLAYLIST_IMPORT_RUNTIME_REJECTED')
  }

  async resume(
    runId: string,
    requestId: string,
    idempotencyKey: string
  ): Promise<PlaylistImportSnapshot> {
    const repository = this.repository()
    try {
      repository.assertRunWithinBudget(runId)
    } catch (error) {
      const code = playlistImportFailureCode(error)
      if (code !== 'LIMIT_REACHED') throw error
      const failed = repository.fail(
        runId,
        code,
        error instanceof Error ? error.message : String(error)
      )
      this.emit(failed)
      this.clearLiveEmit(runId)
      toolHost.disposeRun(runId)
      await Promise.allSettled([
        this.browser.release(runId, 'Playlist import run duration exceeded'),
        agentExecution.closeRun(runId)
      ])
      return failed
    }
    const before = repository.snapshot(runId)
    const handoff = before?.attention?.kind === 'browser-handoff' ? before.attention : null
    if (handoff && handoff.requestId !== requestId) throw new Error('BROWSER_HANDOFF_STALE')
    if (handoff && (!agentExecution.hasActiveRun(runId) || !this.browser.hasSession(runId))) {
      const expired = repository.fail(
        runId,
        'PLAYLIST_IMPORT_SESSION_EXPIRED',
        '当前前台导入会话已经结束，请重新发起导入。'
      )
      this.emit(expired)
      await this.finish(runId)
      return expired
    }
    const snapshot = repository.resumeBrowser(runId, requestId, idempotencyKey)
    this.emit(snapshot)
    if (!handoff && ['completed', 'failed', 'cancelled', 'waiting_user'].includes(snapshot.phase)) {
      return snapshot
    }
    try {
      const work = repository.nextBrowserWork(runId)
      const dispatched = await agentExecution.dispatch({
        runId,
        kind: 'follow-up',
        idempotencyKey,
        text: [
          '用户已经完成浏览器中的必要操作。',
          `当前唯一允许的工作项：${JSON.stringify(workPayload(work))}`,
          '当前前台浏览器会话仍保持在用户操作后的页面；先检查当前位置，由你根据当前页面事实决定下一步。需要再次登录、验证或其他用户操作时立即 handoff；可以自行使用 browser 返回上述工作项。'
        ].join('\n')
      })
      if (!dispatched.accepted) throw new Error('PLAYLIST_IMPORT_RUNTIME_REJECTED')
      return snapshot
    } catch (error) {
      if (!handoff) throw error
      const restored = repository.setBrowserHandoff({
        runId,
        requestId: randomUUID(),
        reason: handoff.reason,
        prompt: handoff.prompt
      })
      this.emit(restored)
      throw error
    }
  }

  async retry(runId: string, retryOperationKey: string): Promise<void> {
    const repository = this.repository()
    const snapshot = repository.snapshot(runId)
    if (!snapshot || !['discovering-list', 'resolving-identities'].includes(snapshot.phase)) {
      throw new Error('PLAYLIST_IMPORT_RETRY_PHASE_INVALID')
    }
    if (!snapshot.error?.retryable) throw new Error('PLAYLIST_IMPORT_RETRY_NOT_AVAILABLE')
    if (!agentExecution.hasActiveRun(runId) || !this.browser.hasSession(runId)) {
      const expired = repository.fail(
        runId,
        'PLAYLIST_IMPORT_SESSION_EXPIRED',
        '当前前台导入会话已经结束，请重新发起导入。'
      )
      this.emit(expired)
      await this.finish(runId)
      return
    }
    try {
      repository.assertRunWithinBudget(runId)
      const dynamic = repository.openDynamicPage(runId)
      if (snapshot.error.code === 'TOTAL_MISMATCH') {
        repository.resetDiscoveryForTotalMismatch(runId)
      } else if (dynamic) {
        repository.resetDynamicPageForRetry(runId, dynamic.pageKey)
      }
      repository.beginSessionRetry(runId)
      const work = repository.nextBrowserWork(runId)
      if (work) {
        const signal = new AbortController().signal
        try {
          await this.browser.hostAction({
            runId,
            command: { action: 'open', url: work.url },
            signal
          })
        } catch (error) {
          if (!isScrapeBrowserChallengeError(error)) throw error
          await this.requestBrowserHandoff(runId, 'human_verification', signal)
          return
        }
      }
      const dispatched = await agentExecution.dispatch({
        runId,
        kind: 'follow-up',
        idempotencyKey: `playlist-import-session-retry:${createHash('sha256').update(retryOperationKey).digest('hex')}`,
        text: [
          '用户要求在当前前台会话内重试。',
          `当前唯一允许的工作项：${JSON.stringify(workPayload(work))}`,
          '宿主已从当前未完成页面的起点重新打开工作项；重新读取并提交页面检查点，不要假设此前未封存的滚动窗口仍然有效。'
        ].join('\n')
      })
      if (!dispatched.accepted) throw new Error('PLAYLIST_IMPORT_RUNTIME_REJECTED')
    } catch (error) {
      const failed = repository.fail(
        runId,
        'PLAYLIST_IMPORT_RETRY_FAILED',
        error instanceof Error ? error.message : String(error)
      )
      this.emit(failed)
      await this.finish(runId)
    }
  }

  async finish(runId: string): Promise<void> {
    this.clearLiveEmit(runId)
    toolHost.disposeRun(runId)
    await Promise.allSettled([
      this.browser.release(runId, 'Playlist import foreground session finished'),
      agentExecution.closeRun(runId)
    ])
  }

  async cancel(runId: string): Promise<void> {
    this.clearLiveEmit(runId)
    await Promise.allSettled([
      agentExecution.abort(runId, '用户取消外部清单导入'),
      this.browser.release(runId, 'Playlist import cancelled')
    ])
    toolHost.disposeRun(runId)
    await agentExecution.closeRun(runId)
  }

  async discard(runId: string): Promise<void> {
    this.clearLiveEmit(runId)
    toolHost.disposeRun(runId)
    await Promise.allSettled([
      this.browser.release(runId, 'Playlist import start rolled back'),
      agentExecution.closeRun(runId)
    ])
  }
}

export const playlistImportRunDriver = new PlaylistImportAgentRunDriver()
