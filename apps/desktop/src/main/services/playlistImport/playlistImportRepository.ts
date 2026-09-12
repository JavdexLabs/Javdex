import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { PLAYLIST_IMPORT_SESSION_SCHEMA_SQL } from '@library/db/schema'
import type {
  PlaylistImportDestination,
  PlaylistImportOutcome,
  PlaylistImportPhase,
  PlaylistImportPreviewItemState,
  PlaylistImportProgress,
  PlaylistImportSnapshot
} from '@shared/playlistImportTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'
import { normalizeRelatedLinkUrl } from '@shared/relatedLinkUrl'
import { normalizeVideoCode } from '@shared/videoCode'
import { hasSensitiveUrlQuery, isSensitiveUrlQueryKey } from '@shared/urlCredentialPolicy'
import { ensureVideoMembership } from '@library/db/libraryMembershipRepo'

export interface PlaylistImportPageItemInput {
  detailUrl: string
  code?: string
  title?: string
  evidence?: Record<string, unknown>
}

export interface PlaylistImportPageCheckpointInput {
  runId: string
  pageKey: string
  pageOrder: number
  pageUrl: string
  documentRevision: string
  viewRevision: string
  evidenceRef: string
  suggestedPlaylistName?: string
  items: PlaylistImportPageItemInput[]
  nextPageUrls: string[]
  terminal: boolean
  declaredTotalItems?: number
  declaredTotalPages?: number
}

export interface PlaylistImportDetailCheckpointInput {
  runId: string
  itemId: number
  expectedItemRevision: number
  detailCode?: string
  identity: Record<string, unknown>
  evidenceRef: string
}

interface CanonicalDetailIdentity {
  detailUrl: string
  listCode?: string
  detailCode?: string
  codeConflict?: boolean
  publisher?: string
  releaseDate?: string
  source?: string
  externalCode?: string
  sourceUrl?: string
  strongMatchVideoId?: number
  strongSignalConflict: boolean
  strongSignalMismatch: boolean
}

interface GlobalIdentityCandidate {
  videoId: number
  code: string
  libraryIds: number[]
  publisherOrganizationId: number | null
  releaseDate: string | null
  identityRevision: string
}

interface GlobalIdentityVideoRow {
  id: number
  code: string
  publisher_organization_id: number | null
  release_date: string | null
}

export interface PlaylistImportVirtualBatchCheckpointInput {
  runId: string
  pageKey: string
  pageOrder: number
  pageUrl: string
  documentRevision: string
  initialViewRevision: string
  evidenceRef: string
  suggestedPlaylistName?: string
  operationKey: string
  batchOrder: number
  viewRevision: string
  enumerationKind?: 'virtual-scroll' | 'load-more'
  positionMode: 'aria-posinset' | 'attribute' | 'overlap'
  containerFingerprint: string
  scrollState: {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
    atStart: boolean
    atEnd: boolean
    moved: boolean
    settled: boolean
  }
  items: Array<PlaylistImportPageItemInput & {
    occurrenceKey: string
    absolutePosition: number
  }>
  accumulatedSequenceDigest: string
  terminalProbeCount: number
  seal: boolean
  nextPageUrls: string[]
  declaredTotalItems?: number
  declaredTotalPages?: number
  containerContract?: Record<string, unknown>
}

export interface PlaylistImportOpenDynamicPage {
  pageKey: string
  pageOrder: number
  pageUrl: string
  documentRevision: string
  initialViewRevision: string
  evidenceRef: string
  enumerationKind: 'virtual-scroll' | 'load-more'
  containerContract: Record<string, unknown>
  nextBatchOrder: number
  terminalProbeCount: number
  occurrences: Array<{ position: number; key: string }>
  batches: Array<{
    batchOrder: number
    operationKey: string
    containerFingerprint: string
    occurrenceKeys: string[]
    scrollTop: number
    scrollHeight: number
    clientHeight: number
    atEnd: boolean
    accumulatedSequenceDigest: string
  }>
}

export type PlaylistImportBrowserWork =
  | { kind: 'list'; pageOrder: number; url: string }
  | {
      kind: 'detail'
      itemId: number
      itemRevision: number
      url: string
      candidates: Array<{
        videoId: number
        title?: string
        releaseDate?: string
        publisher?: string
        libraryIds: number[]
        relatedUrls: string[]
      }>
    }

interface JobRow {
  run_id: string
  idempotency_key: string
  input_hash: string
  policy_version: 1
  phase: PlaylistImportPhase
  revision: number
  source_url: string
  normalized_source_url: string
  source_host: string
  destination_kind: PlaylistImportDestination['kind']
  requested_playlist_id: number | null
  requested_playlist_name: string | null
  agent_suggested_playlist_name: string | null
  resolved_playlist_id: number | null
  apply_idempotency_key: string | null
  target_library_id: number
  target_library_name_snapshot: string
  auto_create_unmatched_videos: 0 | 1
  save_detail_links: 0 | 1
  save_source_playlist_link: 0 | 1
  outcome_json: string | null
  error_code: string | null
  error_message: string | null
}

interface ApplyItemRow {
  id: number
  revision: number
  normalized_code: string | null
  title: string | null
  detail_url: string
  normalized_detail_url: string
  state: string
  resolution_kind: string | null
  resolved_video_id: number | null
  candidate_snapshot_json: string | null
  detail_identity_json: string | null
  error_code: string | null
}

class ImportPreviewStaleError extends Error {
  constructor() {
    super('IMPORT_PREVIEW_STALE')
    this.name = 'ImportPreviewStaleError'
  }
}

class PlaylistImportTargetError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'PlaylistImportTargetError'
  }
}

const PREVIEW_ITEM_LIMIT = 200
const PLAYLIST_NAME_MAX_LENGTH = 500

function now(): string {
  return new Date().toISOString()
}

function isRetryablePlaylistImportError(code: string): boolean {
  return new Set([
    'TARGET_LIBRARY_ARCHIVED',
    'NETWORK_TIMEOUT',
    'BROWSER_SESSION_LOST',
    'CHALLENGE_REQUIRED',
    'PAGE_CHECKPOINT_REQUIRED',
    'PAGE_CHANGED',
    'PAGINATION_INCOMPLETE',
    'SCROLL_TARGET_INVALID',
    'SCROLL_STALLED',
    'SOURCE_CHANGED',
    'TOTAL_MISMATCH',
    'ITEM_CODE_MISSING',
    'ITEM_IDENTITY_AMBIGUOUS',
    'IDENTITY_REVIEW_STALE',
    'IMPORT_PREVIEW_STALE',
    'APPLY_FAILED'
  ]).has(code)
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function paginationLoopDigest(
  items: Array<{ normalizedDetailUrl: string; normalizedCode: string | null; title?: string }>,
  pageUrl: string,
  nextPageUrls: string[],
  terminal: boolean
): string {
  return hash({
    pageUrl,
    items: items.map((item) => ({
      detailUrl: item.normalizedDetailUrl,
      code: item.normalizedCode,
      title: item.title?.trim() || null
    })),
    advance: terminal ? 'terminal' : 'links',
    nextPageUrls
  })
}

function normalizeSuggestedPlaylistName(raw: string | undefined): string | null {
  if (raw == null || !raw.trim()) return null
  if (/\p{Cc}/u.test(raw)) throw new Error('PLAYLIST_IMPORT_NAME_CONTROL_CHARACTER')
  const value = raw.trim().replace(/\s+/gu, ' ')
  if (value.length > PLAYLIST_NAME_MAX_LENGTH) throw new Error('PLAYLIST_IMPORT_NAME_TOO_LONG')
  return value || null
}

function assertSuggestedPlaylistNamePosition(
  value: string | null,
  pageOrder: number,
  batchOrder = 0
): void {
  if (value && (pageOrder !== 0 || batchOrder !== 0)) {
    throw new Error('PLAYLIST_IMPORT_NAME_ONLY_FIRST_PAGE')
  }
}

export function normalizePlaylistImportUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(normalizeRelatedLinkUrl(raw))
  } catch {
    throw new Error('外部清单链接必须是有效的 HTTP/HTTPS 地址')
  }
  if (hasSensitiveUrlQuery(url)) throw new Error('PLAYLIST_IMPORT_URL_CREDENTIALS')
  return url.toString()
}

function normalizePlaylistImportDetailUrl(raw: string): {
  detailUrl: string
  normalizedDetailUrl: string
  sensitive: boolean
} {
  const trimmed = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('外部清单链接必须是有效的 HTTP/HTTPS 地址')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('外部清单链接必须是有效的 HTTP/HTTPS 地址')
  }
  const sensitive = Boolean(parsed.username || parsed.password || hasSensitiveUrlQuery(parsed))
  if (sensitive) {
    parsed.username = ''
    parsed.password = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveUrlQueryKey(key)) parsed.searchParams.delete(key)
    }
  }
  const safeUrl = sensitive ? parsed.toString() : trimmed
  const normalizedDetailUrl = normalizePlaylistImportUrl(safeUrl)
  return {
    detailUrl: sensitive ? normalizedDetailUrl : safeUrl,
    normalizedDetailUrl,
    sensitive
  }
}

export function normalizePlaylistImportHost(hostname: string): string {
  return hostname.toLocaleLowerCase().replace(/^www\./u, '')
}

function inputHash(input: {
  sourceUrl: string
  targetLibraryId: number
  destination: PlaylistImportDestination
  autoCreateUnmatchedVideos?: boolean
  saveDetailLinks?: boolean
  saveSourcePlaylistLink?: boolean
}): string {
  return hash({
    sourceUrl: normalizePlaylistImportUrl(input.sourceUrl),
    targetLibraryId: input.targetLibraryId,
    autoCreateUnmatchedVideos: input.autoCreateUnmatchedVideos ?? true,
    saveDetailLinks: input.saveDetailLinks ?? true,
    saveSourcePlaylistLink: input.saveSourcePlaylistLink ?? false,
    destination: input.destination.kind === 'create'
      ? { kind: 'create', requestedName: input.destination.requestedName?.trim() || null }
      : input.destination
  })
}

function destinationOf(row: JobRow): PlaylistImportDestination {
  return row.destination_kind === 'append'
    ? { kind: 'append', playlistId: row.requested_playlist_id! }
    : {
        kind: 'create',
        ...(row.requested_playlist_name ? { requestedName: row.requested_playlist_name } : {})
      }
}

function parseOutcome(value: string): PlaylistImportOutcome {
  const outcome = JSON.parse(value) as Partial<PlaylistImportOutcome> & {
    playlistId: number
    totalItems: number
    reusedVideos: number
    createdVideos: number
    addedToPlaylist: number
    alreadyInPlaylist: number
    relatedLinksAdded: number
  }
  return {
    playlistId: outcome.playlistId,
    playlistName: outcome.playlistName ?? `清单 #${outcome.playlistId}`,
    targetLibraryId: outcome.targetLibraryId ?? 0,
    targetLibraryName: outcome.targetLibraryName ?? '未知媒体库',
    pagesRead: outcome.pagesRead ?? 0,
    sourceItems: outcome.sourceItems ?? outcome.totalItems,
    uniqueDetailUrls: outcome.uniqueDetailUrls ?? outcome.totalItems,
    totalItems: outcome.totalItems,
    reusedVideos: outcome.reusedVideos,
    directReuses: outcome.directReuses ?? outcome.reusedVideos,
    detailReuses: outcome.detailReuses ?? 0,
    userSelectedReuses: outcome.userSelectedReuses ?? 0,
    crossLibraryReuses: outcome.crossLibraryReuses ?? 0,
    createdVideos: outcome.createdVideos,
    targetLibraryMembersCreated: outcome.targetLibraryMembersCreated ?? outcome.createdVideos,
    skippedVideos: outcome.skippedVideos ?? 0,
    addedToPlaylist: outcome.addedToPlaylist,
    alreadyInPlaylist: outcome.alreadyInPlaylist,
    relatedLinksAdded: outcome.relatedLinksAdded,
    playlistRelatedLinksAdded: outcome.playlistRelatedLinksAdded ?? 0,
    externalDuplicateItems: outcome.externalDuplicateItems ?? 0,
    convergedExternalItems: outcome.convergedExternalItems ?? 0,
    reuseLibraryDistribution: outcome.reuseLibraryDistribution ?? []
  }
}

function summaryFor(row: JobRow, progress: PlaylistImportProgress): string {
  switch (row.phase) {
    case 'discovering-list':
      return `已读取 ${progress.pagesRead} 页，发现 ${progress.sourceItems} 条，去重后 ${progress.uniqueItems} 部`
    case 'resolving-identities':
      return `直接复用 ${progress.directReuses}，待读详情 ${progress.detailPending}，计划新建 ${progress.plannedCreates}，跳过 ${progress.skippedItems}`
    case 'waiting_user':
      return `有 ${progress.userDecisionsPending} 部影片需要选择身份`
    case 'ready-to-apply':
      return `可写入 ${progress.uniqueItems - progress.skippedItems} 部影片，跳过 ${progress.skippedItems} 部`
    case 'applying':
      return `正在写入 ${progress.uniqueItems} 部影片`
    case 'completed':
      return `已导入 ${progress.appliedItems} 部影片，跳过 ${progress.skippedItems} 部`
    case 'cancelled':
      return '导入已取消，未写入清单或影片'
    case 'failed':
      return row.error_message ?? '外部清单导入失败'
  }
}

export const PLAYLIST_IMPORT_DISCOVERY_LIMITS = {
  maxPages: 5_000,
  maxDynamicBatchesPerPage: 5_000,
  maxCandidatesPerDynamicBatch: 500,
  maxOccurrences: 20_000,
  maxRunDurationMs: 24 * 60 * 60 * 1_000
} as const

class PlaylistImportLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlaylistImportLimitError'
  }
}

class PlaylistImportPaginationLoopError extends Error {
  constructor() {
    super('清单分页没有产生新的可读取页面，检测到分页循环。')
    this.name = 'PlaylistImportPaginationLoopError'
  }
}

class PlaylistImportPageChangedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlaylistImportPageChangedError'
  }
}

class PlaylistImportTotalMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlaylistImportTotalMismatchError'
  }
}

export class PlaylistImportRepository {
  constructor(private readonly database: Database.Database) {
    this.database.exec(PLAYLIST_IMPORT_SESSION_SCHEMA_SQL)
  }

  assertRunWithinBudget(runId: string, observedAt = Date.now()): void {
    const row = this.database.prepare(
      'SELECT created_at FROM playlist_import_jobs WHERE run_id = ?'
    ).get(runId) as { created_at: string } | undefined
    if (!row) throw new Error('PLAYLIST_IMPORT_RUN_NOT_FOUND')
    const createdAt = Date.parse(row.created_at)
    if (!Number.isFinite(createdAt)) throw new Error('PLAYLIST_IMPORT_RUN_TIMESTAMP_INVALID')
    if (observedAt - createdAt > PLAYLIST_IMPORT_DISCOVERY_LIMITS.maxRunDurationMs) {
      throw new PlaylistImportLimitError('LIMIT_REACHED:RUN_DURATION')
    }
  }

  private discoveryCheckpoint(runId: string, action: () => void): PlaylistImportSnapshot {
    try {
      this.assertRunWithinBudget(runId)
      this.database.transaction(action)()
    } catch (error) {
      if (error instanceof PlaylistImportLimitError) {
        return this.fail(runId, 'LIMIT_REACHED', error.message)
      }
      if (error instanceof PlaylistImportPaginationLoopError) {
        this.markCurrentFrontierNoProgress(runId)
        return this.fail(runId, 'PAGINATION_LOOP', error.message)
      }
      if (error instanceof PlaylistImportPageChangedError) {
        this.database.prepare(
          `UPDATE playlist_import_jobs SET error_code = 'PAGE_CHANGED', error_message = ?,
           revision = revision + 1, updated_at = ?
           WHERE run_id = ? AND phase = 'discovering-list'`
        ).run(error.message, now(), runId)
        return this.snapshot(runId)!
      }
      if (error instanceof PlaylistImportTotalMismatchError) {
        this.database.prepare(
          `UPDATE playlist_import_jobs SET error_code = 'TOTAL_MISMATCH', error_message = ?,
           revision = revision + 1, updated_at = ?
           WHERE run_id = ? AND phase = 'discovering-list'`
        ).run(error.message, now(), runId)
        return this.snapshot(runId)!
      }
      throw error
    }
    this.database.prepare(
      `UPDATE playlist_import_jobs SET error_code = NULL, error_message = NULL,
       revision = revision + 1, updated_at = ?
       WHERE run_id = ? AND error_code IN ('PAGE_CHANGED', 'TOTAL_MISMATCH')`
    ).run(now(), runId)
    return this.snapshot(runId)!
  }

  private markCurrentFrontierNoProgress(runId: string): void {
    this.database.prepare(
      `UPDATE playlist_import_frontier SET status = 'no-progress', updated_at = ?
       WHERE id = (
         SELECT id FROM playlist_import_frontier
         WHERE run_id = ? AND status IN ('in-flight', 'pending')
         ORDER BY CASE status WHEN 'in-flight' THEN 0 ELSE 1 END, order_hint, id
         LIMIT 1
       )`
    ).run(now(), runId)
  }

  failPaginationNoProgress(
    runId: string,
    code: 'PAGINATION_LOOP' | 'SCROLL_LOOP' | 'SCROLL_STALLED',
    message: string
  ): PlaylistImportSnapshot {
    this.markCurrentFrontierNoProgress(runId)
    return this.fail(runId, code, message)
  }

  checkpointScrollStall(runId: string, message: string): PlaylistImportSnapshot {
    const job = this.requireJob(runId, 'discovering-list')
    if (job.error_code === 'SCROLL_STALLED') {
      return this.failPaginationNoProgress(
        runId,
        'SCROLL_LOOP',
        '虚拟列表连续两次未到底且没有产生新窗口，已停止重复滚动。'
      )
    }
    this.database.prepare(
      `UPDATE playlist_import_jobs SET error_code = 'SCROLL_STALLED', error_message = ?,
       revision = revision + 1, updated_at = ? WHERE run_id = ?`
    ).run(message, now(), runId)
    return this.snapshot(runId)!
  }

  markRecoverableError(
    runId: string,
    code: 'NETWORK_TIMEOUT' | 'BROWSER_SESSION_LOST' | 'PAGE_CHECKPOINT_REQUIRED' | 'SOURCE_CHANGED',
    message: string
  ): PlaylistImportSnapshot {
    const job = this.requireJob(runId)
    if (!['discovering-list', 'resolving-identities'].includes(job.phase)) {
      throw new Error('PLAYLIST_IMPORT_RECOVERABLE_ERROR_PHASE_INVALID')
    }
    this.database.prepare(
      `UPDATE playlist_import_jobs SET error_code = ?, error_message = ?,
       revision = revision + 1, updated_at = ? WHERE run_id = ?`
    ).run(code, message, now(), runId)
    return this.snapshot(runId)!
  }

  beginSessionRetry(runId: string): PlaylistImportSnapshot {
    const job = this.requireJob(runId)
    if (!['discovering-list', 'resolving-identities'].includes(job.phase)) {
      throw new Error('PLAYLIST_IMPORT_RECOVERY_PHASE_INVALID')
    }
    this.database.prepare(
      `UPDATE playlist_import_jobs SET error_code = NULL, error_message = NULL,
       revision = revision + 1, updated_at = ?
       WHERE run_id = ? AND error_code IN (
         'NETWORK_TIMEOUT', 'BROWSER_SESSION_LOST', 'PAGE_CHECKPOINT_REQUIRED', 'SOURCE_CHANGED'
       )`
    ).run(now(), runId)
    return this.snapshot(runId)!
  }

  findByIdempotencyKey(key: string): { runId: string; inputHash: string } | null {
    const row = this.database.prepare(
      'SELECT run_id, input_hash FROM playlist_import_jobs WHERE idempotency_key = ?'
    ).get(key) as { run_id: string; input_hash: string } | undefined
    return row ? { runId: row.run_id, inputHash: row.input_hash } : null
  }

  latestRunId(): string | null {
    const row = this.database.prepare(
      `SELECT run_id FROM playlist_import_jobs
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`
    ).get() as { run_id: string } | undefined
    return row?.run_id ?? null
  }

  activeRunId(): string | null {
    const row = this.database.prepare(
      `SELECT run_id FROM playlist_import_jobs
       WHERE phase NOT IN ('completed', 'failed', 'cancelled')
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`
    ).get() as { run_id: string } | undefined
    return row?.run_id ?? null
  }

  replayableStaticPageOrder(runId: string, pageUrl: string): number | null {
    const normalizedPageUrl = normalizePlaylistImportUrl(pageUrl)
    const row = this.database.prepare(
      `SELECT page_order FROM playlist_import_pages
       WHERE run_id = ? AND normalized_page_url = ? AND enumeration_kind = 'static-dom'
       ORDER BY page_order DESC LIMIT 1`
    ).get(runId, normalizedPageUrl) as { page_order: number } | undefined
    return row?.page_order ?? null
  }

  expectedInputHash(input: {
    sourceUrl: string
    targetLibraryId: number
    destination: PlaylistImportDestination
    autoCreateUnmatchedVideos?: boolean
    saveDetailLinks?: boolean
    saveSourcePlaylistLink?: boolean
  }): string {
    return inputHash(input)
  }

  nextBrowserWork(runId: string): PlaylistImportBrowserWork | null {
    const job = this.requireJob(runId)
    if (job.phase === 'discovering-list') {
      const row = this.database.prepare(
        `SELECT target_json, order_hint FROM playlist_import_frontier
         WHERE run_id = ? AND status IN ('pending', 'in-flight')
         ORDER BY CASE status WHEN 'in-flight' THEN 0 ELSE 1 END, order_hint, id LIMIT 1`
      ).get(runId) as { target_json: string; order_hint: number } | undefined
      if (!row) return null
      const target = JSON.parse(row.target_json) as { url?: unknown }
      if (typeof target.url !== 'string') throw new Error('PLAYLIST_IMPORT_FRONTIER_CORRUPT')
      return { kind: 'list' as const, pageOrder: row.order_hint, url: target.url }
    }
    if (job.phase === 'resolving-identities') {
      const row = this.database.prepare(
        `SELECT id, revision, detail_url, candidate_snapshot_json FROM playlist_import_items
         WHERE run_id = ? AND state = 'needs-detail'
         ORDER BY source_position LIMIT 1`
      ).get(runId) as {
        id: number
        revision: number
        detail_url: string
        candidate_snapshot_json: string | null
      } | undefined
      if (!row) return null
      const candidates = (JSON.parse(row.candidate_snapshot_json ?? '[]') as Array<{
        videoId: number
        libraryIds: number[]
      }>).map((candidate) => {
        const video = this.database.prepare(
          `SELECT video.title, video.release_date, publisher.main_name AS publisher
           FROM videos video
           LEFT JOIN organizations publisher ON publisher.id = video.publisher_organization_id
           WHERE video.id = ?`
        ).get(candidate.videoId) as {
          title: string | null
          release_date: string | null
          publisher: string | null
        } | undefined
        const links = this.database.prepare(
          'SELECT url FROM video_links WHERE video_id = ? ORDER BY position, id'
        ).all(candidate.videoId) as Array<{ url: string }>
        return {
          videoId: candidate.videoId,
          ...(video?.title ? { title: video.title } : {}),
          ...(video?.release_date ? { releaseDate: video.release_date } : {}),
          ...(video?.publisher ? { publisher: video.publisher } : {}),
          libraryIds: candidate.libraryIds,
          relatedUrls: links.map((link) => link.url)
        }
      })
      return {
        kind: 'detail',
        itemId: row.id,
        itemRevision: row.revision,
        url: row.detail_url,
        candidates
      }
    }
    return null
  }

  inFlightListBrowserWork(runId: string): Extract<PlaylistImportBrowserWork, { kind: 'list' }> | null {
    const job = this.requireJob(runId)
    if (job.phase !== 'discovering-list') return null
    const row = this.database.prepare(
      `SELECT target_json, order_hint FROM playlist_import_frontier
       WHERE run_id = ? AND status = 'in-flight'
       ORDER BY order_hint, id LIMIT 1`
    ).get(runId) as { target_json: string; order_hint: number } | undefined
    if (!row) return null
    const target = JSON.parse(row.target_json) as { url?: unknown }
    if (typeof target.url !== 'string') throw new Error('PLAYLIST_IMPORT_FRONTIER_CORRUPT')
    return { kind: 'list' as const, pageOrder: row.order_hint, url: target.url }
  }

  claimNextListBrowserWork(runId: string): Extract<PlaylistImportBrowserWork, { kind: 'list' }> {
    return this.database.transaction(() => {
      this.requireJob(runId, 'discovering-list')
      const row = this.database.prepare(
        `SELECT id, target_json, order_hint, status FROM playlist_import_frontier
         WHERE run_id = ? AND status IN ('pending', 'in-flight')
         ORDER BY CASE status WHEN 'in-flight' THEN 0 ELSE 1 END, order_hint, id LIMIT 1`
      ).get(runId) as {
        id: number
        target_json: string
        order_hint: number
        status: 'pending' | 'in-flight'
      } | undefined
      if (!row) throw new Error('PLAYLIST_IMPORT_BROWSER_WORK_MISSING')
      if (row.status === 'pending') {
        const claimed = this.database.prepare(
          `UPDATE playlist_import_frontier SET status = 'in-flight', updated_at = ?
           WHERE id = ? AND run_id = ? AND status = 'pending'`
        ).run(now(), row.id, runId)
        if (claimed.changes !== 1) throw new Error('PLAYLIST_IMPORT_FRONTIER_STALE')
      }
      const target = JSON.parse(row.target_json) as { url?: unknown }
      if (typeof target.url !== 'string') throw new Error('PLAYLIST_IMPORT_FRONTIER_CORRUPT')
      return { kind: 'list' as const, pageOrder: row.order_hint, url: target.url }
    })()
  }

  openDynamicPage(runId: string): PlaylistImportOpenDynamicPage | null {
    const page = this.database.prepare(
      `SELECT id, page_key, page_order, page_url, document_revision,
        initial_view_revision, evidence_ref, enumeration_kind, container_contract_json
       FROM playlist_import_pages
       WHERE run_id = ? AND enumeration_kind IN ('virtual-scroll', 'load-more')
         AND enumeration_status = 'open'
       ORDER BY page_order LIMIT 1`
    ).get(runId) as {
      id: number
      page_key: string
      page_order: number
      page_url: string
      document_revision: string
      initial_view_revision: string
      evidence_ref: string
      enumeration_kind: 'virtual-scroll' | 'load-more'
      container_contract_json: string | null
    } | undefined
    if (!page?.container_contract_json) return null
    const checkpointedBatches = this.database.prepare(
      `SELECT batch_order, operation_key, terminal_probe_count, container_fingerprint,
        ordered_occurrence_keys_json, scroll_top, scroll_height, client_height,
        at_end, accumulated_sequence_digest
       FROM playlist_import_scroll_batches WHERE page_id = ?
       ORDER BY batch_order`
    ).all(page.id) as Array<{
      batch_order: number
      operation_key: string
      terminal_probe_count: number
      container_fingerprint: string
      ordered_occurrence_keys_json: string
      scroll_top: number
      scroll_height: number
      client_height: number
      at_end: 0 | 1
      accumulated_sequence_digest: string
    }>
    const batches = checkpointedBatches.map((batch) => ({
      batchOrder: batch.batch_order,
      operationKey: batch.operation_key,
      containerFingerprint: batch.container_fingerprint,
      occurrenceKeys: JSON.parse(batch.ordered_occurrence_keys_json) as string[],
      scrollTop: batch.scroll_top,
      scrollHeight: batch.scroll_height,
      clientHeight: batch.client_height,
      atEnd: batch.at_end === 1,
      accumulatedSequenceDigest: batch.accumulated_sequence_digest
    }))
    const occurrences = (this.database.prepare(
      `SELECT page_position, source_occurrence_key FROM playlist_import_page_items
       WHERE page_id = ? ORDER BY page_position`
    ).all(page.id) as Array<{ page_position: number; source_occurrence_key: string }>)
      .map((row) => ({ position: row.page_position, key: row.source_occurrence_key }))
    const latest = checkpointedBatches.at(-1)
    return {
      pageKey: page.page_key,
      pageOrder: page.page_order,
      pageUrl: page.page_url,
      documentRevision: page.document_revision,
      initialViewRevision: page.initial_view_revision,
      evidenceRef: page.evidence_ref,
      enumerationKind: page.enumeration_kind,
      containerContract: JSON.parse(page.container_contract_json) as Record<string, unknown>,
      nextBatchOrder: (latest?.batch_order ?? -1) + 1,
      terminalProbeCount: latest?.terminal_probe_count ?? 0,
      occurrences,
      batches
    }
  }

  createJob(input: {
    runId: string
    idempotencyKey: string
    sourceUrl: string
    targetLibraryId: number
    destination: PlaylistImportDestination
    autoCreateUnmatchedVideos?: boolean
    saveDetailLinks?: boolean
    saveSourcePlaylistLink?: boolean
  }): PlaylistImportSnapshot {
    const normalizedSourceUrl = normalizePlaylistImportUrl(input.sourceUrl)
    const url = new URL(normalizedSourceUrl)
    const library = this.validateStartTargets(input)
    const at = now()
    this.database.transaction(() => {
      this.database.prepare(
        `INSERT INTO playlist_import_jobs (
          run_id, idempotency_key, input_hash, phase, source_url,
          normalized_source_url, source_host, destination_kind,
          requested_playlist_id, requested_playlist_name, target_library_id,
          target_library_name_snapshot, auto_create_unmatched_videos,
          save_detail_links, save_source_playlist_link, created_at, updated_at
        ) VALUES (
          @runId, @idempotencyKey, @inputHash, 'discovering-list', @sourceUrl,
          @normalizedSourceUrl, @sourceHost, @destinationKind,
          @requestedPlaylistId, @requestedPlaylistName, @targetLibraryId,
          @targetLibraryName, @autoCreateUnmatchedVideos, @saveDetailLinks,
          @saveSourcePlaylistLink, @at, @at
        )`
      ).run({
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
        inputHash: inputHash(input),
        sourceUrl: input.sourceUrl.trim(),
        normalizedSourceUrl,
        sourceHost: normalizePlaylistImportHost(url.hostname),
        destinationKind: input.destination.kind,
        requestedPlaylistId: input.destination.kind === 'append' ? input.destination.playlistId : null,
        requestedPlaylistName: input.destination.kind === 'create'
          ? input.destination.requestedName?.trim() || null
          : null,
        targetLibraryId: library.id,
        targetLibraryName: library.name,
        autoCreateUnmatchedVideos: input.autoCreateUnmatchedVideos === false ? 0 : 1,
        saveDetailLinks: input.saveDetailLinks === false ? 0 : 1,
        saveSourcePlaylistLink: input.saveSourcePlaylistLink === true ? 1 : 0,
        at
      })
      this.database.prepare(
        `INSERT INTO playlist_import_frontier (
          run_id, kind, target_json, canonical_key, order_hint, status, created_at, updated_at
        ) VALUES (?, 'url', ?, ?, 0, 'pending', ?, ?)`
      ).run(
        input.runId,
        JSON.stringify({ url: normalizedSourceUrl }),
        `url:${normalizedSourceUrl}`,
        at,
        at
      )
    })()
    return this.snapshot(input.runId)!
  }

  validateStartTargets(input: {
    targetLibraryId: number
    destination: PlaylistImportDestination
  }): { id: number; name: string } {
    const library = this.database.prepare(
      'SELECT id, name, status FROM media_libraries WHERE id = ?'
    ).get(input.targetLibraryId) as { id: number; name: string; status: string } | undefined
    if (!library) {
      throw new PlaylistImportTargetError('TARGET_LIBRARY_NOT_FOUND', '目标媒体库不存在。')
    }
    if (library.status !== 'active') {
      throw new PlaylistImportTargetError('TARGET_LIBRARY_ARCHIVED', '目标媒体库已归档。')
    }
    if (input.destination.kind === 'append') {
      const playlist = this.database.prepare('SELECT name FROM playlists WHERE id = ?')
        .get(input.destination.playlistId) as { name: string } | undefined
      if (!playlist) {
        throw new PlaylistImportTargetError('TARGET_PLAYLIST_NOT_FOUND', '追加目标清单不存在。')
      }
    }
    return { id: library.id, name: library.name }
  }

  snapshot(runId: string): PlaylistImportSnapshot | null {
    const row = this.database.prepare('SELECT * FROM playlist_import_jobs WHERE run_id = ?')
      .get(runId) as JobRow | undefined
    if (!row) return null
    const counts = this.database.prepare(
      `SELECT
        (SELECT COUNT(*) FROM playlist_import_pages WHERE run_id = @runId AND enumeration_status = 'sealed') AS pages_read,
        (SELECT COUNT(*) FROM playlist_import_scroll_batches batch
          JOIN playlist_import_pages page ON page.id = batch.page_id
          WHERE page.run_id = @runId AND page.enumeration_kind = 'virtual-scroll') AS scroll_windows,
        (SELECT COUNT(*) FROM playlist_import_page_items occurrence
          JOIN playlist_import_pages page ON page.id = occurrence.page_id WHERE page.run_id = @runId) AS source_items,
        COUNT(*) AS unique_items,
        COALESCE(SUM(state = 'planned-reuse'), 0) AS direct_reuses,
        COALESCE(SUM(state = 'needs-detail'), 0) AS detail_pending,
        COALESCE(SUM(state = 'needs-user'), 0) AS user_pending,
        COALESCE(SUM(state = 'planned-create'), 0) AS planned_creates,
        COALESCE(SUM(state = 'failed' AND error_code = 'AUTO_CREATE_DISABLED'), 0) AS skipped_items,
        COALESCE(SUM(state = 'applied'), 0) AS applied_items
       FROM playlist_import_items WHERE run_id = @runId`
    ).get({ runId }) as {
      pages_read: number
      scroll_windows: number
      source_items: number
      unique_items: number
      direct_reuses: number
      detail_pending: number
      user_pending: number
      planned_creates: number
      skipped_items: number
      applied_items: number
    }
    const known = this.database.prepare(
      `SELECT MAX(declared_total_pages) AS total
       FROM playlist_import_pages WHERE run_id = ?`
    ).get(runId) as { total: number | null }
    const progress: PlaylistImportProgress = {
      pagesRead: counts.pages_read,
      scrollWindowsRead: counts.scroll_windows,
      ...(known.total == null ? {} : { knownPageTotal: known.total }),
      sourceItems: counts.source_items,
      uniqueItems: counts.unique_items,
      directReuses: counts.direct_reuses,
      detailPending: counts.detail_pending,
      userDecisionsPending: counts.user_pending,
      plannedCreates: counts.planned_creates,
      skippedItems: counts.skipped_items,
      appliedItems: counts.applied_items
    }
    const previewRows = this.database.prepare(
      `SELECT item.id, item.source_position, item.raw_code, item.normalized_code,
        item.title, item.detail_url, item.state, item.error_code, item.resolution_kind,
        video.id AS video_id, video.code AS video_code, video.title AS video_title
       FROM playlist_import_items item
       LEFT JOIN videos video ON video.id = item.resolved_video_id
       WHERE item.run_id = ?
       ORDER BY item.source_position
       LIMIT ?`
    ).all(runId, PREVIEW_ITEM_LIMIT) as Array<{
      id: number
      source_position: number
      raw_code: string | null
      normalized_code: string | null
      title: string | null
      detail_url: string
      state: PlaylistImportPreviewItemState
      error_code: string | null
      resolution_kind: string | null
      video_id: number | null
      video_code: string | null
      video_title: string | null
    }>
    const preview = {
      items: previewRows.map((item) => ({
        itemId: item.id,
        sourcePosition: item.source_position,
        ...(item.normalized_code ?? item.raw_code
          ? { code: (item.normalized_code ?? item.raw_code)! }
          : {}),
        ...(item.title ? { title: item.title } : {}),
        detailUrl: item.detail_url,
        state: item.state,
        ...(item.error_code ? { errorCode: item.error_code } : {}),
        ...(item.resolution_kind ? { resolutionKind: item.resolution_kind } : {}),
        ...(item.video_id && item.video_code
          ? {
              resolvedVideo: {
                id: item.video_id,
                code: item.video_code,
                ...(item.video_title ? { title: item.video_title } : {})
              }
            }
          : {})
      })),
      totalItems: counts.unique_items,
      truncated: counts.unique_items > previewRows.length
    }
    const outcome = row.outcome_json
      ? parseOutcome(row.outcome_json)
      : undefined
    const handoff = row.phase === 'waiting_user' ? this.pendingBrowserHandoff(runId) : null
    const attention = handoff ?? (row.phase === 'waiting_user'
      ? { kind: 'identity-review' as const, items: this.identityReviewItems(row) }
      : undefined)
    return {
      runId: row.run_id,
      revision: row.revision,
      cursor: row.revision,
      phase: row.phase,
      summary: summaryFor(row, progress),
      frozenInput: {
        sourceUrl: row.source_url,
        displayUrl: row.normalized_source_url,
        sourceHost: row.source_host,
        targetLibraryId: row.target_library_id,
        targetLibraryNameAtStart: row.target_library_name_snapshot,
        destination: destinationOf(row),
        autoCreateUnmatchedVideos: row.auto_create_unmatched_videos === 1,
        saveDetailLinks: row.save_detail_links === 1,
        saveSourcePlaylistLink: row.save_source_playlist_link === 1,
        ...(playlistNameForSnapshot(this.database, row) ? {
          destinationPlaylistNameAtStart: playlistNameForSnapshot(this.database, row)!
        } : {}),
        policyVersion: 1
      },
      progress,
      preview,
      ...(attention ? { attention } : {}),
      ...(outcome ? { outcome } : {}),
      ...(row.error_code ? {
        error: {
          code: row.error_code,
          message: row.error_message ?? row.error_code,
          retryable: row.phase !== 'failed' && isRetryablePlaylistImportError(row.error_code)
        }
      } : {})
    }
  }

  private detailCheckpointReplay(input: PlaylistImportDetailCheckpointInput): {
    operationKey: string
    commandHash: string
    detailUrl: string
  } | null {
    const commandHash = hash({
      itemId: input.itemId,
      expectedItemRevision: input.expectedItemRevision,
      detailCode: input.detailCode?.trim() || null,
      identity: input.identity,
      evidenceRef: input.evidenceRef
    })
    const operationKey = `${input.itemId}:${input.expectedItemRevision}`
    const replay = (this.database.prepare(
      `SELECT payload_json FROM playlist_import_session_events
       WHERE run_id = ? AND event_type = 'playlist-import.detail-checkpoint'
       ORDER BY seq`
    ).all(input.runId) as Array<{ payload_json: string }>).map((row) => (
      JSON.parse(row.payload_json) as {
        operationKey: string
        commandHash: string
        detailUrl: string
      }
    )).find((entry) => entry.operationKey === operationKey)
    if (!replay) return null
    if (replay.commandHash !== commandHash) throw new Error('IDEMPOTENCY_KEY_REUSED')
    return replay
  }

  replayableDetailCheckpointUrl(input: PlaylistImportDetailCheckpointInput): string | null {
    return this.detailCheckpointReplay(input)?.detailUrl ?? null
  }

  checkpointDetailIdentity(input: PlaylistImportDetailCheckpointInput): PlaylistImportSnapshot {
    if (this.detailCheckpointReplay(input)) return this.snapshot(input.runId)!
    const commandHash = hash({
      itemId: input.itemId,
      expectedItemRevision: input.expectedItemRevision,
      detailCode: input.detailCode?.trim() || null,
      identity: input.identity,
      evidenceRef: input.evidenceRef
    })
    const operationKey = `${input.itemId}:${input.expectedItemRevision}`
    return this.discoveryCheckpoint(input.runId, () => {
      const job = this.requireJob(input.runId, 'resolving-identities')
      const item = this.database.prepare(
        `SELECT id, revision, normalized_code, state
         FROM playlist_import_items WHERE id = ? AND run_id = ?`
      ).get(input.itemId, input.runId) as {
        id: number
        revision: number
        normalized_code: string | null
        state: string
      } | undefined
      if (!item || item.state !== 'needs-detail') throw new Error('DETAIL_WORK_ITEM_INVALID')
      if (item.revision !== input.expectedItemRevision) throw new Error('ITEM_REVISION_STALE')
      const detailCode = input.detailCode?.trim() ? normalizeVideoCode(input.detailCode) : null
      const codeConflict = Boolean(
        item.normalized_code && detailCode && item.normalized_code !== detailCode
      )
      const code = item.normalized_code ?? detailCode
      const detailUrl = (this.database.prepare(
        'SELECT normalized_detail_url FROM playlist_import_items WHERE id = ?'
      ).get(item.id) as { normalized_detail_url: string }).normalized_detail_url
      const candidates = this.mergeGlobalIdentityCandidates(
        this.globalCodeCandidatesForCodes(
          codeConflict ? [item.normalized_code, detailCode] : [code]
        ),
        this.globalDetailUrlCandidates(detailUrl),
        this.globalSourceIdentityCandidates({
          ...(typeof input.identity.source === 'string'
            ? { source: input.identity.source }
            : {}),
          ...(typeof input.identity.externalCode === 'string'
            ? { externalCode: input.identity.externalCode }
            : {}),
          ...(typeof input.identity.sourceUrl === 'string'
            ? { sourceUrl: input.identity.sourceUrl }
            : {})
        })
      )
      const identity = this.canonicalDetailIdentity({
        code,
        detailUrl,
        identity: input.identity,
        candidates
      })
      if (codeConflict) {
        identity.listCode = item.normalized_code!
        identity.detailCode = detailCode!
        identity.codeConflict = true
        identity.strongSignalConflict = true
      }
      const strongMatches = identity.strongMatchVideoId == null
        ? []
        : [identity.strongMatchVideoId]
      let state: 'planned-reuse' | 'planned-create' | 'needs-user' | 'failed'
      let resolutionKind: string | null
      let errorCode: string | null = null
      let videoId: number | null = null
      if (codeConflict) {
        state = 'needs-user'
        resolutionKind = 'user-existing'
      } else if (candidates.length === 0 && code) {
        if (job.auto_create_unmatched_videos === 1) {
          state = 'planned-create'
          resolutionKind = 'create-no-match'
        } else {
          state = 'failed'
          resolutionKind = null
          errorCode = 'AUTO_CREATE_DISABLED'
        }
      } else if (
        !identity.strongSignalConflict &&
        !identity.strongSignalMismatch &&
        strongMatches.length === 1
      ) {
        state = 'planned-reuse'
        resolutionKind = 'business-identity'
        videoId = strongMatches[0]
      } else if (
        !identity.strongSignalConflict &&
        !identity.strongSignalMismatch &&
        candidates.length === 1
      ) {
        state = 'planned-reuse'
        resolutionKind = 'direct-code'
        videoId = candidates[0].videoId
      } else {
        const reasonableIds = candidates.map((candidate) => candidate.videoId)
        const targetMatches = reasonableIds.filter((candidateId) => (
          candidates.find((candidate) => candidate.videoId === candidateId)
            ?.libraryIds.includes(job.target_library_id)
        ))
        if (
          !identity.strongSignalConflict &&
          !identity.strongSignalMismatch &&
          reasonableIds.length > 1 &&
          targetMatches.length === 1
        ) {
          state = 'planned-reuse'
          resolutionKind = 'target-library-tiebreak'
          videoId = targetMatches[0]
        } else {
          state = 'needs-user'
          resolutionKind = 'user-existing'
        }
      }
      const at = now()
      this.database.prepare(
        `UPDATE playlist_import_items SET normalized_code = COALESCE(normalized_code, ?),
         state = ?, resolution_kind = ?, resolved_video_id = ?,
         candidate_snapshot_json = ?, detail_identity_json = ?, detail_evidence_ref = ?,
         error_code = ?, revision = revision + 1, updated_at = ? WHERE id = ?`
      ).run(
        code,
        state,
        resolutionKind,
        videoId,
        JSON.stringify(candidates),
        JSON.stringify(identity),
        input.evidenceRef,
        errorCode,
        at,
        item.id
      )
      this.updateResolutionPhase(input.runId, at)
      this.database.prepare(
        `INSERT INTO playlist_import_session_events (
          run_id, operation_id, event_type, payload_json, created_at
        ) VALUES (?, NULL, 'playlist-import.detail-checkpoint', ?, ?)`
      ).run(input.runId, JSON.stringify({
        operationKey,
        commandHash,
        detailUrl
      }), at)
    })
  }

  resolveIdentityDecisions(input: {
    runId: string
    expectedRevision: number
    idempotencyKey: string
    decisions: Array<{
      itemId: number
      choice: { kind: 'existing'; videoId: number } | { kind: 'create' }
    }>
  }): PlaylistImportSnapshot {
    try {
      this.assertRunWithinBudget(input.runId)
    } catch (error) {
      if (error instanceof PlaylistImportLimitError) {
        return this.fail(input.runId, 'LIMIT_REACHED', error.message)
      }
      throw error
    }
    const commandHash = hash({
      expectedRevision: input.expectedRevision,
      decisions: input.decisions
    })
    const replay = (this.database.prepare(
      `SELECT payload_json FROM playlist_import_session_events
       WHERE run_id = ? AND event_type = 'playlist-import.identity-decisions'
       ORDER BY seq`
    ).all(input.runId) as Array<{ payload_json: string }>).map((row) => (
      JSON.parse(row.payload_json) as { idempotencyKey: string; commandHash: string }
    )).find((entry) => entry.idempotencyKey === input.idempotencyKey)
    if (replay) {
      if (replay.commandHash !== commandHash) throw new Error('IDEMPOTENCY_KEY_REUSED')
      return this.snapshot(input.runId)!
    }
    this.database.transaction(() => {
      const job = this.requireJob(input.runId, 'waiting_user')
      if (job.revision !== input.expectedRevision) throw new Error('RUN_REVISION_STALE')
      const at = now()
      for (const decision of input.decisions) {
        const item = this.database.prepare(
          `SELECT id, revision, state, candidate_snapshot_json
           FROM playlist_import_items WHERE id = ? AND run_id = ?`
        ).get(decision.itemId, input.runId) as {
          id: number
          revision: number
          state: string
          candidate_snapshot_json: string | null
        } | undefined
        if (!item || item.state !== 'needs-user') throw new Error('IDENTITY_DECISION_ITEM_INVALID')
        if (decision.choice.kind === 'existing') {
          const candidateIds = new Set(
            (JSON.parse(item.candidate_snapshot_json ?? '[]') as Array<{ videoId: number }>)
              .map((candidate) => candidate.videoId)
          )
          if (!candidateIds.has(decision.choice.videoId)) throw new Error('IDENTITY_CHOICE_INVALID')
        }
        this.database.prepare(
          `INSERT INTO playlist_import_decisions (
            item_id, expected_item_revision, choice_kind, chosen_video_id, decided_at
          ) VALUES (?, ?, ?, ?, ?)`
        ).run(
          item.id,
          item.revision,
          decision.choice.kind,
          decision.choice.kind === 'existing' ? decision.choice.videoId : null,
          at
        )
        this.database.prepare(
          `UPDATE playlist_import_items SET state = ?, resolution_kind = ?, resolved_video_id = ?,
           error_code = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`
        ).run(
          decision.choice.kind === 'existing' ? 'planned-reuse' : 'planned-create',
          decision.choice.kind === 'existing' ? 'user-existing' : 'user-create',
          decision.choice.kind === 'existing' ? decision.choice.videoId : null,
          at,
          item.id
        )
      }
      this.updateResolutionPhase(input.runId, at)
      this.database.prepare(
        `INSERT INTO playlist_import_session_events (
          run_id, operation_id, event_type, payload_json, created_at
        ) VALUES (?, NULL, 'playlist-import.identity-decisions', ?, ?)`
      ).run(input.runId, JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        commandHash
      }), at)
    })()
    return this.snapshot(input.runId)!
  }

  checkpointStaticPage(input: PlaylistImportPageCheckpointInput): PlaylistImportSnapshot {
    const normalizedPageUrl = normalizePlaylistImportUrl(input.pageUrl)
    const suggestedPlaylistName = normalizeSuggestedPlaylistName(input.suggestedPlaylistName)
    assertSuggestedPlaylistNamePosition(suggestedPlaylistName, input.pageOrder)
    const normalizedItems = input.items.map((item) => ({
      ...item,
      ...normalizePlaylistImportDetailUrl(item.detailUrl),
      normalizedCode: item.code?.trim() ? normalizeVideoCode(item.code) : null
    }))
    const normalizedNextPages = input.nextPageUrls.map(normalizePlaylistImportUrl)
    const loopDigest = paginationLoopDigest(
      normalizedItems,
      normalizedPageUrl,
      normalizedNextPages,
      input.terminal
    )
    const contentHash = hash({
      pageKey: input.pageKey,
      normalizedPageUrl,
      items: normalizedItems,
      nextPages: normalizedNextPages,
      terminal: input.terminal,
      declaredTotalItems: input.declaredTotalItems,
      declaredTotalPages: input.declaredTotalPages,
      suggestedPlaylistName
    })
    return this.discoveryCheckpoint(input.runId, () => {
      const existing = this.database.prepare(
        `SELECT id, page_order, normalized_page_url, content_hash
         FROM playlist_import_pages WHERE run_id = ? AND page_key = ?`
      ).get(input.runId, input.pageKey) as {
        id: number
        page_order: number
        normalized_page_url: string
        content_hash: string | null
      } | undefined
      if (existing?.content_hash === contentHash) return
      const job = this.requireJob(input.runId, 'discovering-list')
      if (normalizePlaylistImportHost(new URL(normalizedPageUrl).hostname) !== job.source_host) {
        throw new Error('清单分页只能留在用户授权的来源站点')
      }
      for (const item of normalizedItems) {
        if (
          normalizePlaylistImportHost(new URL(item.normalizedDetailUrl).hostname) !== job.source_host
        ) {
          throw new Error('影片详情链接必须属于用户授权的来源站点')
        }
      }
      for (const nextPage of normalizedNextPages) {
        if (normalizePlaylistImportHost(new URL(nextPage).hostname) !== job.source_host) {
          throw new Error('清单分页只能留在用户授权的来源站点')
        }
      }
      if (existing) {
        if (existing.content_hash !== contentHash) {
          if (job.error_code !== 'PAGE_CHANGED') {
            throw new PlaylistImportPageChangedError(
              'PAGE_CHANGED: 当前清单页与本次 Session 检查点不一致，请重新读取当前页后重试。'
            )
          }
          this.resetStaticPageCheckpoint(job, existing)
        }
      }
      const repeatedPage = this.database.prepare(
        `SELECT 1 FROM playlist_import_pages
         WHERE run_id = ? AND enumeration_status = 'sealed' AND sequence_digest = ?
         LIMIT 1`
      ).get(input.runId, loopDigest)
      if (repeatedPage) throw new PlaylistImportPaginationLoopError()
      if (
        (input.declaredTotalPages ?? 0) > PLAYLIST_IMPORT_DISCOVERY_LIMITS.maxPages ||
        (input.declaredTotalItems ?? 0) > PLAYLIST_IMPORT_DISCOVERY_LIMITS.maxOccurrences
      ) {
        throw new PlaylistImportLimitError('外部清单声明的页数或影片数超过导入安全上限。')
      }
      this.assertDeclaredTotalsCompatible(
        input.runId,
        input.declaredTotalItems,
        input.declaredTotalPages
      )
      const usage = this.database.prepare(
        `SELECT
          (SELECT COUNT(*) FROM playlist_import_pages WHERE run_id = @runId) AS pages,
          (SELECT COUNT(*) FROM playlist_import_page_items occurrence
           JOIN playlist_import_pages page ON page.id = occurrence.page_id
           WHERE page.run_id = @runId) AS occurrences`
      ).get({ runId: input.runId }) as { pages: number; occurrences: number }
      if (usage.pages >= PLAYLIST_IMPORT_DISCOVERY_LIMITS.maxPages) {
        throw new PlaylistImportLimitError('外部清单页数超过导入安全上限。')
      }
      if (
        usage.occurrences + normalizedItems.length >
        PLAYLIST_IMPORT_DISCOVERY_LIMITS.maxOccurrences
      ) {
        throw new PlaylistImportLimitError('外部清单影片条目数超过导入安全上限。')
      }
      const at = now()
      const pageId = Number(this.database.prepare(
        `INSERT INTO playlist_import_pages (
          run_id, page_key, page_order, page_url, normalized_page_url,
          document_revision, initial_view_revision, enumeration_kind,
          enumeration_status, sequence_digest, content_hash, evidence_ref, advance_json,
          observed_item_count, declared_total_items, declared_total_pages,
          checkpointed_at, sealed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'static-dom', 'sealed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.runId,
        input.pageKey,
        input.pageOrder,
        input.pageUrl,
        normalizedPageUrl,
        input.documentRevision,
        input.viewRevision,
        loopDigest,
        contentHash,
        input.evidenceRef,
        JSON.stringify({ nextPageUrls: normalizedNextPages, terminal: input.terminal }),
        normalizedItems.length,
        input.declaredTotalItems ?? null,
        input.declaredTotalPages ?? null,
        at,
        at
      ).lastInsertRowid)
      this.captureSuggestedPlaylistName(job, suggestedPlaylistName)
      let nextSourcePosition = (this.database.prepare(
        'SELECT COALESCE(MAX(source_position), -1) + 1 AS value FROM playlist_import_items WHERE run_id = ?'
      ).get(input.runId) as { value: number }).value
      const insertItem = this.database.prepare(
        `INSERT OR IGNORE INTO playlist_import_items (
          run_id, first_page_id, source_position, raw_code, normalized_code,
          title, detail_url, normalized_detail_url, state, error_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)`
      )
      const readItem = this.database.prepare(
        'SELECT id, source_position FROM playlist_import_items WHERE run_id = ? AND normalized_detail_url = ?'
      )
      const insertOccurrence = this.database.prepare(
        `INSERT INTO playlist_import_page_items (
          page_id, item_id, source_occurrence_key, source_position, page_position, raw_evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      let nextOccurrencePosition = (this.database.prepare(
        `SELECT COALESCE(MAX(occurrence.source_position), -1) + 1 AS value
         FROM playlist_import_page_items occurrence
         JOIN playlist_import_pages page ON page.id = occurrence.page_id
         WHERE page.run_id = ?`
      ).get(input.runId) as { value: number }).value
      normalizedItems.forEach((item, pagePosition) => {
        const inserted = insertItem.run(
          input.runId,
          pageId,
          nextSourcePosition,
          item.code?.trim() || null,
          item.normalizedCode,
          item.title?.trim() || null,
          item.detailUrl,
          item.normalizedDetailUrl,
          item.sensitive ? 'SENSITIVE_DETAIL_URL' : null,
          at,
          at
        )
        const saved = readItem.get(input.runId, item.normalizedDetailUrl) as {
          id: number
          source_position: number
        }
        if (inserted.changes > 0) nextSourcePosition += 1
        if (item.sensitive) {
          this.database.prepare(
            `UPDATE playlist_import_items SET error_code = 'SENSITIVE_DETAIL_URL'
             WHERE id = ?`
          ).run(saved.id)
        }
        insertOccurrence.run(
          pageId,
          saved.id,
          `${input.pageKey}:${pagePosition}`,
          nextOccurrencePosition,
          pagePosition,
          JSON.stringify(item.evidence ?? {})
        )
        nextOccurrencePosition += 1
      })
      this.database.prepare(
        `UPDATE playlist_import_frontier SET status = 'checkpointed', updated_at = ?
         WHERE run_id = ? AND canonical_key = ?`
      ).run(at, input.runId, `url:${normalizedPageUrl}`)
      const insertFrontier = this.database.prepare(
        `INSERT OR IGNORE INTO playlist_import_frontier (
          run_id, source_page_id, kind, target_json, canonical_key, order_hint,
          status, created_at, updated_at
        ) VALUES (?, ?, 'url', ?, ?, ?, 'pending', ?, ?)`
      )
      let nextOrderHint = (this.database.prepare(
        `SELECT COALESCE(MAX(order_hint), -1) + 1 AS value
         FROM playlist_import_frontier WHERE run_id = ?`
      ).get(input.runId) as { value: number }).value
      let insertedFrontiers = 0
      normalizedNextPages.forEach((url) => {
        const inserted = insertFrontier.run(
          input.runId,
          pageId,
          JSON.stringify({ url }),
          `url:${url}`,
          nextOrderHint,
          at,
          at
        )
        if (inserted.changes > 0) {
          insertedFrontiers += 1
          nextOrderHint += 1
        }
      })
      if (input.terminal && normalizedNextPages.length === 0) {
        this.resolveDiscoveredIdentities(input.runId)
      } else {
        if (insertedFrontiers === 0 && !this.hasPendingFrontier(input.runId)) {
          throw new PlaylistImportPaginationLoopError()
        }
        this.bumpJob(input.runId, at)
      }
    })
  }

  checkpointVirtualBatch(input: PlaylistImportVirtualBatchCheckpointInput): PlaylistImportSnapshot {
    const enumerationKind = input.enumerationKind ?? 'virtual-scroll'
    const normalizedPageUrl = normalizePlaylistImportUrl(input.pageUrl)
    const suggestedPlaylistName = normalizeSuggestedPlaylistName(input.suggestedPlaylistName)
    assertSuggestedPlaylistNamePosition(
      suggestedPlaylistName,
      input.pageOrder,
      input.batchOrder
    )
    const normalizedNextPages = input.nextPageUrls.map(normalizePlaylistImportUrl)
    const normalizedItems = input.items.map((item) => {
      const detail = normalizePlaylistImportDetailUrl(item.detailUrl)
      return {
        ...item,
        ...detail,
        occurrenceKey: `${item.absolutePosition}:${detail.normalizedDetailUrl}`,
        normalizedCode: item.code?.trim() ? normalizeVideoCode(item.code) : null
      }
    })
    const operationContentHash = hash({
      pageKey: input.pageKey,
      enumerationKind,
      batchOrder: input.batchOrder,
      viewRevision: input.viewRevision,
      positionMode: input.positionMode,
      containerFingerprint: input.containerFingerprint,
      scrollState: input.scrollState,
      items: normalizedItems,
      accumulatedSequenceDigest: input.accumulatedSequenceDigest,
      terminalProbeCount: input.terminalProbeCount,
      seal: input.seal,
      nextPageUrls: normalizedNextPages,
      suggestedPlaylistName
    })
    if (!input.scrollState.settled) throw new Error('DYNAMIC_LIST_NOT_SETTLED')
    if (enumerationKind === 'virtual-scroll' && input.batchOrder === 0 && !input.scrollState.atStart) {
      throw new Error('VIRTUAL_LIST_MUST_START_AT_TOP')
    }
    return this.discoveryCheckpoint(input.runId, () => {
      const job = this.requireJob(input.runId, 'discovering-list')
      if (normalizePlaylistImportHost(new URL(normalizedPageUrl).hostname) !== job.source_host) {
        throw new Error('清单分页只能留在用户授权的来源站点')
      }
      for (const nextPage of normalizedNextPages) {
        if (normalizePlaylistImportHost(new URL(nextPage).hostname) !== job.source_host) {
          throw new Error('清单分页只能留在用户授权的来源站点')
        }
      }
      const existingBatch = this.database.prepare(
        `SELECT batch.id, batch.batch_order, batch.batch_digest,
          page.id AS page_id, page.page_order, page.normalized_page_url
         FROM playlist_import_scroll_batches batch
         JOIN playlist_import_pages page ON page.id = batch.page_id
         WHERE page.run_id = ? AND page.page_key = ? AND batch.operation_key = ?`
      ).get(input.runId, input.pageKey, input.operationKey) as {
        id: number
        batch_order: number
        batch_digest: string
        page_id: number
        page_order: number
        normalized_page_url: string
      } | undefined
      if (existingBatch) {
        if (existingBatch.batch_digest !== operationContentHash) {
          if (job.error_code !== 'PAGE_CHANGED') {
            throw new PlaylistImportPageChangedError(
              'PAGE_CHANGED: 当前动态列表批次与本次 Session 检查点不一致，请重新读取当前窗口后重试。'
            )
          }
          this.resetDynamicBatchCheckpoint(job, existingBatch)
          if (existingBatch.batch_order === 0) {
            this.database.prepare(
              `UPDATE playlist_import_pages SET document_revision = ?, initial_view_revision = ?,
               container_contract_json = ?, position_mode = ?, evidence_ref = ?,
               declared_total_items = ?, declared_total_pages = ?, checkpointed_at = ?
               WHERE id = ?`
            ).run(
              input.documentRevision,
              input.initialViewRevision,
              JSON.stringify(input.containerContract ?? {}),
              input.positionMode,
              input.evidenceRef,
              input.declaredTotalItems ?? null,
              input.declaredTotalPages ?? null,
              now(),
              existingBatch.page_id
            )
          }
        } else {
          return
        }
      }
      if (
        (input.declaredTotalPages ?? 0) > PLAYLIST_IMPORT_DISCOVERY_LIMITS.maxPages ||
        (input.declaredTotalItems ?? 0) > PLAYLIST_IMPORT_DISCOVERY_LIMITS.maxOccurrences ||
        normalizedItems.length > PLAYLIST_IMPORT_DISCOVERY_LIMITS.maxCandidatesPerDynamicBatch
      ) {
        throw new PlaylistImportLimitError('外部清单动态窗口超过导入安全上限。')
      }
      let page = this.database.prepare(
        `SELECT id, enumeration_kind, enumeration_status, position_mode,
          declared_total_items, declared_total_pages
         FROM playlist_import_pages
         WHERE run_id = ? AND page_key = ?`
      ).get(input.runId, input.pageKey) as {
        id: number
        enumeration_kind: 'virtual-scroll' | 'load-more'
        enumeration_status: 'open' | 'sealed'
        position_mode: string | null
        declared_total_items: number | null
        declared_total_pages: number | null
      } | undefined
      const at = now()
      if (!page) {
        if (input.batchOrder !== 0) throw new Error('VIRTUAL_LIST_FIRST_BATCH_REQUIRED')
        const pageCount = (this.database.prepare(
          'SELECT COUNT(*) AS count FROM playlist_import_pages WHERE run_id = ?'
        ).get(input.runId) as { count: number }).count
        if (pageCount >= PLAYLIST_IMPORT_DISCOVERY_LIMITS.maxPages) {
          throw new PlaylistImportLimitError('外部清单页数超过导入安全上限。')
        }
        const pageId = Number(this.database.prepare(
          `INSERT INTO playlist_import_pages (
          run_id, page_key, page_order, page_url, normalized_page_url,
          document_revision, initial_view_revision, enumeration_kind,
            enumeration_status, container_contract_json, position_mode, evidence_ref, observed_item_count,
            declared_total_items, declared_total_pages, checkpointed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 0, ?, ?, ?)`
        ).run(
          input.runId,
          input.pageKey,
          input.pageOrder,
          input.pageUrl,
          normalizedPageUrl,
          input.documentRevision,
          input.initialViewRevision,
          enumerationKind,
          JSON.stringify(input.containerContract ?? {}),
          input.positionMode,
          input.evidenceRef,
          input.declaredTotalItems ?? null,
          input.declaredTotalPages ?? null,
          at
        ).lastInsertRowid)
        page = {
          id: pageId,
          enumeration_kind: enumerationKind,
          enumeration_status: 'open',
          position_mode: input.positionMode,
          declared_total_items: input.declaredTotalItems ?? null,
          declared_total_pages: input.declaredTotalPages ?? null
        }
        this.captureSuggestedPlaylistName(job, suggestedPlaylistName)
      }
      if (page.enumeration_status !== 'open') throw new Error('VIRTUAL_LIST_PAGE_ALREADY_SEALED')
      if (page.enumeration_kind !== enumerationKind) throw new Error('DYNAMIC_LIST_KIND_CHANGED')
      if (page.position_mode !== input.positionMode) throw new Error('VIRTUAL_LIST_POSITION_MODE_CHANGED')
      const expectedBatchOrder = (this.database.prepare(
        `SELECT COALESCE(MAX(batch_order), -1) + 1 AS value
         FROM playlist_import_scroll_batches WHERE page_id = ?`
      ).get(page.id) as { value: number }).value
      if (input.batchOrder !== expectedBatchOrder) throw new Error('VIRTUAL_LIST_BATCH_GAP')
      if (expectedBatchOrder >= PLAYLIST_IMPORT_DISCOVERY_LIMITS.maxDynamicBatchesPerPage) {
        throw new PlaylistImportLimitError('单个清单页的动态窗口数超过导入安全上限。')
      }
      const previousBatch = this.database.prepare(
        `SELECT terminal_probe_count, container_fingerprint, scroll_top,
          scroll_height, client_height, at_end, accumulated_sequence_digest
         FROM playlist_import_scroll_batches
         WHERE page_id = ? ORDER BY batch_order DESC LIMIT 1`
      ).get(page.id) as {
        terminal_probe_count: number
        container_fingerprint: string
        scroll_top: number
        scroll_height: number
        client_height: number
        at_end: 0 | 1
        accumulated_sequence_digest: string
      } | undefined
      if (previousBatch && previousBatch.container_fingerprint !== input.containerFingerprint) {
        throw new Error('DYNAMIC_LIST_CONTAINER_CHANGED')
      }
      const closeEnough = (left: number, right: number): boolean => Math.abs(left - right) <= 0.5
      const stableTerminalProbe = Boolean(
        previousBatch?.at_end === 1 &&
        closeEnough(previousBatch.scroll_top, input.scrollState.scrollTop) &&
        closeEnough(previousBatch.scroll_height, input.scrollState.scrollHeight) &&
        closeEnough(previousBatch.client_height, input.scrollState.clientHeight) &&
        previousBatch.accumulated_sequence_digest === input.accumulatedSequenceDigest
      )
      const expectedTerminalProbeCount = enumerationKind === 'virtual-scroll'
        ? (input.scrollState.atEnd && !input.scrollState.moved
            ? (stableTerminalProbe ? previousBatch!.terminal_probe_count + 1 : 1)
            : 0)
        : 0
      if (input.terminalProbeCount !== expectedTerminalProbeCount) {
        throw new Error('VIRTUAL_LIST_TERMINAL_PROBE_INVALID')
      }
      const positions = normalizedItems.map((item) => item.absolutePosition)
      if (positions.some((position) => !Number.isInteger(position) || position < 0)) {
        throw new Error('VIRTUAL_LIST_POSITION_INVALID')
      }
      if (new Set(positions).size !== positions.length) throw new Error('VIRTUAL_LIST_POSITION_DUPLICATED')
      let nextItemPosition = (this.database.prepare(
        'SELECT COALESCE(MAX(source_position), -1) + 1 AS value FROM playlist_import_items WHERE run_id = ?'
      ).get(input.runId) as { value: number }).value
      let nextOccurrencePosition = (this.database.prepare(
        `SELECT COALESCE(MAX(occurrence.source_position), -1) + 1 AS value
         FROM playlist_import_page_items occurrence
         JOIN playlist_import_pages source_page ON source_page.id = occurrence.page_id
         WHERE source_page.run_id = ?`
      ).get(input.runId) as { value: number }).value
      const occurrenceCountAtStart = nextOccurrencePosition
      let newOccurrences = 0
      const occurrenceKeys: string[] = []
      for (const item of normalizedItems.sort((left, right) => left.absolutePosition - right.absolutePosition)) {
        if (
          normalizePlaylistImportHost(new URL(item.normalizedDetailUrl).hostname) !== job.source_host
        ) {
          throw new Error('影片详情链接必须属于用户授权的来源站点')
        }
        occurrenceKeys.push(item.occurrenceKey)
        const existingAtPosition = this.database.prepare(
          `SELECT source_occurrence_key FROM playlist_import_page_items
           WHERE page_id = ? AND page_position = ?`
        ).get(page.id, item.absolutePosition) as { source_occurrence_key: string } | undefined
        if (existingAtPosition && existingAtPosition.source_occurrence_key !== item.occurrenceKey) {
          throw new Error('VIRTUAL_LIST_POSITION_CONFLICT')
        }
        const existingOccurrence = this.database.prepare(
          `SELECT item.normalized_detail_url
           FROM playlist_import_page_items occurrence
           JOIN playlist_import_items item ON item.id = occurrence.item_id
           WHERE occurrence.page_id = ? AND occurrence.source_occurrence_key = ?`
        ).get(page.id, item.occurrenceKey) as { normalized_detail_url: string } | undefined
        if (existingOccurrence) {
          if (existingOccurrence.normalized_detail_url !== item.normalizedDetailUrl) {
            throw new Error('VIRTUAL_LIST_OCCURRENCE_CHANGED')
          }
          continue
        }
        if (
          occurrenceCountAtStart + newOccurrences >=
          PLAYLIST_IMPORT_DISCOVERY_LIMITS.maxOccurrences
        ) {
          throw new PlaylistImportLimitError('外部清单影片条目数超过导入安全上限。')
        }
        const inserted = this.database.prepare(
          `INSERT OR IGNORE INTO playlist_import_items (
            run_id, first_page_id, source_position, raw_code, normalized_code,
            title, detail_url, normalized_detail_url, state, error_code, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)`
        ).run(
          input.runId,
          page.id,
          nextItemPosition,
          item.code?.trim() || null,
          item.normalizedCode,
          item.title?.trim() || null,
          item.detailUrl,
          item.normalizedDetailUrl,
          item.sensitive ? 'SENSITIVE_DETAIL_URL' : null,
          at,
          at
        )
        const saved = this.database.prepare(
          `SELECT id FROM playlist_import_items WHERE run_id = ? AND normalized_detail_url = ?`
        ).get(input.runId, item.normalizedDetailUrl) as { id: number }
        if (inserted.changes > 0) nextItemPosition += 1
        if (item.sensitive) {
          this.database.prepare(
            `UPDATE playlist_import_items SET error_code = 'SENSITIVE_DETAIL_URL'
             WHERE id = ?`
          ).run(saved.id)
        }
        this.database.prepare(
          `INSERT INTO playlist_import_page_items (
            page_id, item_id, source_occurrence_key, source_position, page_position, raw_evidence_json
          ) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          page.id,
          saved.id,
          item.occurrenceKey,
          nextOccurrencePosition,
          item.absolutePosition,
          JSON.stringify(item.evidence ?? {})
        )
        nextOccurrencePosition += 1
        newOccurrences += 1
      }
      if (enumerationKind === 'load-more' && input.batchOrder > 0 && newOccurrences === 0) {
        throw new PlaylistImportPaginationLoopError()
      }
      const batchDigest = operationContentHash
      this.database.prepare(
        `INSERT INTO playlist_import_scroll_batches (
          page_id, batch_order, operation_key, view_revision, container_fingerprint,
          scroll_top, scroll_height, client_height, ordered_occurrence_keys_json,
          rendered_item_count, new_occurrence_count, batch_digest,
          accumulated_sequence_digest, first_anchor_key, last_anchor_key,
          at_start, at_end, terminal_probe_count, evidence_ref, checkpointed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        page.id,
        input.batchOrder,
        input.operationKey,
        input.viewRevision,
        input.containerFingerprint,
        input.scrollState.scrollTop,
        input.scrollState.scrollHeight,
        input.scrollState.clientHeight,
        JSON.stringify(occurrenceKeys),
        normalizedItems.length,
        newOccurrences,
        batchDigest,
        input.accumulatedSequenceDigest,
        occurrenceKeys[0] ?? null,
        occurrenceKeys.at(-1) ?? null,
        input.scrollState.atStart ? 1 : 0,
        input.scrollState.atEnd ? 1 : 0,
        input.terminalProbeCount,
        input.evidenceRef,
        at
      )
      const observed = (this.database.prepare(
        'SELECT COUNT(*) AS count FROM playlist_import_page_items WHERE page_id = ?'
      ).get(page.id) as { count: number }).count
      if (input.seal) {
        if (enumerationKind === 'virtual-scroll') {
          if (!input.scrollState.atEnd || input.scrollState.moved || input.terminalProbeCount < 2) {
            throw new Error('VIRTUAL_LIST_TERMINAL_UNPROVEN')
          }
        } else if (!input.scrollState.atEnd || input.terminalProbeCount !== 0) {
          throw new Error('LOAD_MORE_TERMINAL_UNPROVEN')
        }
        const range = this.database.prepare(
          `SELECT MIN(page_position) AS first, MAX(page_position) AS last, COUNT(*) AS count
           FROM playlist_import_page_items WHERE page_id = ?`
        ).get(page.id) as { first: number | null; last: number | null; count: number }
        if (
          range.count > 0 &&
          (range.first !== 0 || range.last !== range.count - 1)
        ) {
          throw new Error('VIRTUAL_LIST_CONTINUITY_UNPROVEN')
        }
        if (input.declaredTotalItems != null && observed !== input.declaredTotalItems) {
          throw new PlaylistImportTotalMismatchError(
            '当前页固化的影片数与页面声明总数不一致，请重新核对当前页。'
          )
        }
        this.assertDeclaredTotalsCompatible(
          input.runId,
          page.declared_total_items,
          page.declared_total_pages,
          page.id
        )
        const sealedItems = this.database.prepare(
          `SELECT item.normalized_detail_url, item.normalized_code, item.title
           FROM playlist_import_page_items occurrence
           JOIN playlist_import_items item ON item.id = occurrence.item_id
           WHERE occurrence.page_id = ? ORDER BY occurrence.page_position`
        ).all(page.id) as Array<{
          normalized_detail_url: string
          normalized_code: string | null
          title: string | null
        }>
        const loopDigest = paginationLoopDigest(
          sealedItems.map((item) => ({
            normalizedDetailUrl: item.normalized_detail_url,
            normalizedCode: item.normalized_code,
            ...(item.title ? { title: item.title } : {})
          })),
          normalizedPageUrl,
          normalizedNextPages,
          normalizedNextPages.length === 0
        )
        const repeatedPage = this.database.prepare(
          `SELECT 1 FROM playlist_import_pages
           WHERE run_id = ? AND id != ? AND enumeration_status = 'sealed' AND sequence_digest = ?
           LIMIT 1`
        ).get(input.runId, page.id, loopDigest)
        if (repeatedPage) throw new PlaylistImportPaginationLoopError()
        this.database.prepare(
          `UPDATE playlist_import_pages SET enumeration_status = 'sealed', sequence_digest = ?,
           content_hash = ?, advance_json = ?, observed_item_count = ?, sealed_at = ? WHERE id = ?`
        ).run(
          loopDigest,
          hash({ observed, accumulatedSequenceDigest: input.accumulatedSequenceDigest }),
          JSON.stringify({ nextPageUrls: normalizedNextPages, terminal: normalizedNextPages.length === 0 }),
          observed,
          at,
          page.id
        )
        this.database.prepare(
          `UPDATE playlist_import_frontier SET status = 'checkpointed', updated_at = ?
           WHERE run_id = ? AND canonical_key = ?`
        ).run(at, input.runId, `url:${normalizedPageUrl}`)
        const insertFrontier = this.database.prepare(
          `INSERT OR IGNORE INTO playlist_import_frontier (
            run_id, source_page_id, kind, target_json, canonical_key, order_hint,
            status, created_at, updated_at
          ) VALUES (?, ?, 'url', ?, ?, ?, 'pending', ?, ?)`
        )
        let nextOrderHint = (this.database.prepare(
          `SELECT COALESCE(MAX(order_hint), -1) + 1 AS value
           FROM playlist_import_frontier WHERE run_id = ?`
        ).get(input.runId) as { value: number }).value
        let insertedFrontiers = 0
        normalizedNextPages.forEach((url) => {
          const inserted = insertFrontier.run(
            input.runId,
            page.id,
            JSON.stringify({ url }),
            `url:${url}`,
            nextOrderHint,
            at,
            at
          )
          if (inserted.changes > 0) {
            insertedFrontiers += 1
            nextOrderHint += 1
          }
        })
        if (normalizedNextPages.length === 0) this.resolveDiscoveredIdentities(input.runId)
        else {
          if (insertedFrontiers === 0 && !this.hasPendingFrontier(input.runId)) {
            throw new PlaylistImportPaginationLoopError()
          }
          this.bumpJob(input.runId, at)
        }
      } else {
        this.bumpJob(input.runId, at)
      }
    })
  }

  private hasPendingFrontier(runId: string): boolean {
    return (this.database.prepare(
      `SELECT EXISTS(
         SELECT 1 FROM playlist_import_frontier
         WHERE run_id = ? AND status IN ('pending', 'in-flight')
       ) AS value`
    ).get(runId) as { value: number }).value === 1
  }

  private assertDeclaredTotalsCompatible(
    runId: string,
    declaredTotalItems?: number | null,
    declaredTotalPages?: number | null,
    excludingPageId?: number
  ): void {
    if (declaredTotalItems == null && declaredTotalPages == null) return
    const prior = this.database.prepare(
      `SELECT
         MIN(declared_total_pages) AS min_pages,
         MAX(declared_total_pages) AS max_pages,
         MIN(declared_total_items) AS min_items,
         MAX(declared_total_items) AS max_items
       FROM playlist_import_pages
       WHERE run_id = ? AND enumeration_status = 'sealed'
         AND (? IS NULL OR id != ?)`
    ).get(runId, excludingPageId ?? null, excludingPageId ?? null) as {
      min_pages: number | null
      max_pages: number | null
      min_items: number | null
      max_items: number | null
    }
    const pagesConflict = declaredTotalPages != null && (
      (prior.min_pages != null && prior.min_pages !== declaredTotalPages) ||
      (prior.max_pages != null && prior.max_pages !== declaredTotalPages)
    )
    const itemsConflict = declaredTotalItems != null && (
      (prior.min_items != null && prior.min_items !== declaredTotalItems) ||
      (prior.max_items != null && prior.max_items !== declaredTotalItems)
    )
    if (pagesConflict || itemsConflict) {
      throw new PlaylistImportTotalMismatchError(
        '当前页声明的总页数或总影片数与此前页面不一致，请重新核对当前页。'
      )
    }
  }

  private resolveDiscoveredIdentities(runId: string): void {
    const job = this.requireJob(runId, 'discovering-list')
    if (this.hasPendingFrontier(runId)) {
      this.bumpJob(runId, now())
      return
    }
    const declared = this.database.prepare(
      `SELECT
         MIN(declared_total_pages) AS min_pages,
         MAX(declared_total_pages) AS max_pages,
         MIN(declared_total_items) AS min_items,
         MAX(declared_total_items) AS max_items,
         COUNT(*) AS pages,
         (SELECT COUNT(*) FROM playlist_import_page_items occurrence
          JOIN playlist_import_pages source_page ON source_page.id = occurrence.page_id
          WHERE source_page.run_id = @runId) AS occurrences
       FROM playlist_import_pages WHERE run_id = @runId AND enumeration_status = 'sealed'`
    ).get({ runId }) as {
      min_pages: number | null
      max_pages: number | null
      min_items: number | null
      max_items: number | null
      pages: number
      occurrences: number
    }
    if (declared.min_pages !== declared.max_pages || declared.min_items !== declared.max_items) {
      throw new PlaylistImportTotalMismatchError(
        '不同页面提交的声明总页数或影片数不一致，请重新读取当前页并统一声明。'
      )
    }
    if (declared.max_pages != null && declared.pages !== declared.max_pages) {
      throw new PlaylistImportTotalMismatchError(
        `已固化 ${declared.pages} 页，与页面声明的 ${declared.max_pages} 页不一致，请重新核对来源。`
      )
    }
    if (declared.max_items != null && declared.occurrences !== declared.max_items) {
      throw new PlaylistImportTotalMismatchError(
        `已固化 ${declared.occurrences} 条，与页面声明的 ${declared.max_items} 条不一致，请重新核对来源。`
      )
    }
    const items = this.database.prepare(
      `SELECT id, normalized_code, normalized_detail_url, error_code FROM playlist_import_items
       WHERE run_id = ? ORDER BY source_position`
    ).all(runId) as Array<{
      id: number
      normalized_code: string | null
      normalized_detail_url: string
      error_code: string | null
    }>
    if (items.length === 0) {
      const at = now()
      this.database.prepare(
        `UPDATE playlist_import_jobs SET phase = 'failed', error_code = 'NO_ITEMS_FOUND',
         error_message = '外部清单没有可导入的影片。', revision = revision + 1,
         updated_at = ? WHERE run_id = ?`
      ).run(at, runId)
      return
    }
    const update = this.database.prepare(
      `UPDATE playlist_import_items SET
        state = @state, resolution_kind = @resolutionKind,
        resolved_video_id = @videoId, candidate_snapshot_json = @candidates,
        error_code = @errorCode,
        revision = revision + 1, updated_at = @at
       WHERE id = @id`
    )
    let needsDetail = 0
    let needsUser = 0
    for (const item of items) {
      if (item.error_code === 'SENSITIVE_DETAIL_URL') {
        needsUser += 1
        const candidates = this.mergeGlobalIdentityCandidates(
          item.normalized_code ? this.globalCodeCandidates(item.normalized_code) : [],
          this.globalDetailUrlCandidates(item.normalized_detail_url)
        )
        update.run({
          id: item.id,
          state: 'needs-user',
          resolutionKind: 'user-existing',
          videoId: null,
          candidates: JSON.stringify(candidates),
          errorCode: 'SENSITIVE_DETAIL_URL',
          at: now()
        })
        continue
      }
      if (!item.normalized_code) {
        needsDetail += 1
        update.run({
          id: item.id,
          state: 'needs-detail',
          resolutionKind: null,
          videoId: null,
          candidates: null,
          errorCode: null,
          at: now()
        })
        continue
      }
      const candidates = this.globalCodeCandidates(item.normalized_code)
      if (candidates.length === 0) {
        update.run({
          id: item.id,
          state: job.auto_create_unmatched_videos === 1 ? 'planned-create' : 'failed',
          resolutionKind: job.auto_create_unmatched_videos === 1 ? 'create-no-match' : null,
          videoId: null,
          candidates: '[]',
          errorCode: job.auto_create_unmatched_videos === 1 ? null : 'AUTO_CREATE_DISABLED',
          at: now()
        })
      } else if (candidates.length === 1) {
        update.run({
          id: item.id,
          state: 'planned-reuse',
          resolutionKind: 'direct-code',
          videoId: candidates[0].videoId,
          candidates: JSON.stringify(candidates),
          errorCode: null,
          at: now()
        })
      } else {
        needsDetail += 1
        update.run({
          id: item.id,
          state: 'needs-detail',
          resolutionKind: null,
          videoId: null,
          candidates: JSON.stringify(candidates),
          errorCode: null,
          at: now()
        })
      }
    }
    const at = now()
    this.database.prepare(
      `UPDATE playlist_import_jobs SET phase = ?, revision = revision + 1, updated_at = ? WHERE run_id = ?`
    ).run(
      needsDetail > 0 ? 'resolving-identities' : needsUser > 0 ? 'waiting_user' : 'ready-to-apply',
      at,
      runId
    )
  }

  private globalCodeCandidates(code: string): GlobalIdentityCandidate[] {
    const videos = this.database.prepare(
      `SELECT id, code, publisher_organization_id, release_date
       FROM videos WHERE upper(trim(code)) = ? ORDER BY id`
    ).all(code) as GlobalIdentityVideoRow[]
    return this.hydrateGlobalIdentityCandidates(videos)
  }

  private globalDetailUrlCandidates(normalizedDetailUrl: string): GlobalIdentityCandidate[] {
    const videos = this.database.prepare(
      `SELECT video.id, video.code, video.publisher_organization_id, video.release_date
       FROM video_links link
       JOIN videos video ON video.id = link.video_id
       WHERE link.normalized_url = ?
       ORDER BY video.id`
    ).all(normalizedDetailUrl) as GlobalIdentityVideoRow[]
    return this.hydrateGlobalIdentityCandidates(videos)
  }

  private globalVideoCandidatesByIds(videoIds: number[]): GlobalIdentityCandidate[] {
    const ids = [...new Set(videoIds)].sort((left, right) => left - right)
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const videos = this.database.prepare(
      `SELECT id, code, publisher_organization_id, release_date
       FROM videos WHERE id IN (${placeholders}) ORDER BY id`
    ).all(...ids) as GlobalIdentityVideoRow[]
    return this.hydrateGlobalIdentityCandidates(videos)
  }

  private globalSourceIdentityCandidates(identity: {
    source?: string
    externalCode?: string
    sourceUrl?: string
  }): GlobalIdentityCandidate[] {
    const source = identity.source?.trim()
    if (!source) return []
    const videoIds: number[] = []
    if (identity.externalCode?.trim()) {
      const rows = this.database.prepare(
        `SELECT video_id FROM video_sources
         WHERE lower(trim(source)) = lower(trim(?))
           AND upper(trim(external_code)) = upper(trim(?))
         ORDER BY video_id`
      ).all(source, identity.externalCode.trim()) as Array<{ video_id: number }>
      videoIds.push(...rows.map((row) => row.video_id))
    }
    if (identity.sourceUrl?.trim()) {
      let normalizedSourceUrl: string | null = null
      try {
        normalizedSourceUrl = normalizePlaylistImportUrl(identity.sourceUrl)
      } catch {
        normalizedSourceUrl = null
      }
      if (normalizedSourceUrl) {
        const rows = this.database.prepare(
          `SELECT video_id, url FROM video_sources
           WHERE lower(trim(source)) = lower(trim(?)) AND url IS NOT NULL
           ORDER BY video_id`
        ).all(source) as Array<{ video_id: number; url: string }>
        for (const row of rows) {
          try {
            if (normalizePlaylistImportUrl(row.url) === normalizedSourceUrl) {
              videoIds.push(row.video_id)
            }
          } catch {
            // Ignore malformed legacy source URLs; they cannot establish identity.
          }
        }
      }
    }
    return this.globalVideoCandidatesByIds(videoIds)
  }

  private hydrateGlobalIdentityCandidates(
    videos: GlobalIdentityVideoRow[]
  ): GlobalIdentityCandidate[] {
    const memberships = this.database.prepare(
      `SELECT library_id FROM library_video_memberships WHERE video_id = ? ORDER BY library_id`
    )
    const links = this.database.prepare(
      'SELECT normalized_url FROM video_links WHERE video_id = ? ORDER BY normalized_url'
    )
    const sources = this.database.prepare(
      `SELECT source, external_code, url FROM video_sources
       WHERE video_id = ? ORDER BY source, external_code, url`
    )
    return videos.map((video) => {
      const libraryIds = (memberships.all(video.id) as Array<{ library_id: number }>)
        .map((row) => row.library_id)
      const relatedUrls = (links.all(video.id) as Array<{ normalized_url: string }>)
        .map((row) => row.normalized_url)
      const sourceRows = sources.all(video.id) as Array<{
        source: string
        external_code: string | null
        url: string | null
      }>
      return {
        videoId: video.id,
        code: video.code,
        libraryIds,
        publisherOrganizationId: video.publisher_organization_id,
        releaseDate: video.release_date,
        identityRevision: hash({
          code: normalizeVideoCode(video.code),
          publisherOrganizationId: video.publisher_organization_id,
          releaseDate: video.release_date,
          libraryIds,
          relatedUrls,
          sources: sourceRows
        })
      }
    })
  }

  private globalCodeCandidatesForCodes(
    codes: Array<string | null>
  ): GlobalIdentityCandidate[] {
    const candidates: GlobalIdentityCandidate[] = []
    for (const code of new Set(codes.filter((value): value is string => Boolean(value)))) {
      candidates.push(...this.globalCodeCandidates(code))
    }
    return this.mergeGlobalIdentityCandidates(candidates)
  }

  private mergeGlobalIdentityCandidates(
    ...groups: GlobalIdentityCandidate[][]
  ): GlobalIdentityCandidate[] {
    const byVideoId = new Map<number, GlobalIdentityCandidate>()
    for (const candidate of groups.flat()) byVideoId.set(candidate.videoId, candidate)
    return [...byVideoId.values()].sort((left, right) => left.videoId - right.videoId)
  }

  private canonicalDetailIdentity(input: {
    code: string | null
    detailUrl: string
    identity: Record<string, unknown>
    candidates: ReturnType<PlaylistImportRepository['globalCodeCandidates']>
  }): CanonicalDetailIdentity {
    const text = (key: string): string | undefined => {
      const value = input.identity[key]
      return typeof value === 'string' && value.trim() ? value.trim() : undefined
    }
    const canonical: CanonicalDetailIdentity = {
      detailUrl: normalizePlaylistImportUrl(input.detailUrl),
      ...(text('publisher') ? { publisher: text('publisher') } : {}),
      ...(text('releaseDate') ? { releaseDate: text('releaseDate') } : {}),
      ...(text('source') ? { source: text('source') } : {}),
      ...(text('externalCode') ? { externalCode: text('externalCode') } : {}),
      ...(text('sourceUrl') ? { sourceUrl: normalizePlaylistImportUrl(text('sourceUrl')!) } : {}),
      strongSignalConflict: false,
      strongSignalMismatch: false
    }
    const candidateIds = new Set(input.candidates.map((candidate) => candidate.videoId))
    const signals: number[][] = []
    const detailMatches = (this.database.prepare(
      'SELECT video_id FROM video_links WHERE normalized_url = ? ORDER BY video_id'
    ).all(canonical.detailUrl) as Array<{ video_id: number }>)
      .map((row) => row.video_id)
      .filter((videoId) => candidateIds.has(videoId))
    if (detailMatches.length > 0) {
      signals.push(detailMatches)
      if (input.code && detailMatches.some((videoId) => {
        const candidate = input.candidates.find((entry) => entry.videoId === videoId)
        return candidate != null && normalizeVideoCode(candidate.code) !== input.code
      })) {
        canonical.strongSignalConflict = true
      }
    }

    if (canonical.source && canonical.externalCode) {
      const externalCodeMatches = (this.database.prepare(
        `SELECT video_id FROM video_sources
         WHERE lower(trim(source)) = lower(trim(?))
           AND upper(trim(external_code)) = upper(trim(?))
         ORDER BY video_id`
      ).all(canonical.source, canonical.externalCode) as Array<{ video_id: number }>)
        .map((row) => row.video_id)
        .filter((videoId) => candidateIds.has(videoId))
      if (externalCodeMatches.length > 0) {
        signals.push(externalCodeMatches)
        if (input.code && externalCodeMatches.some((videoId) => {
          const candidate = input.candidates.find((entry) => entry.videoId === videoId)
          return candidate != null && normalizeVideoCode(candidate.code) !== input.code
        })) {
          canonical.strongSignalConflict = true
        }
      }
    }

    if (canonical.source && canonical.sourceUrl) {
      const sourceUrlMatches = (this.database.prepare(
        `SELECT video_id, url FROM video_sources
         WHERE lower(trim(source)) = lower(trim(?)) AND url IS NOT NULL
         ORDER BY video_id`
      ).all(canonical.source) as Array<{ video_id: number; url: string }>)
        .filter((row) => {
          try {
            return normalizePlaylistImportUrl(row.url) === canonical.sourceUrl
          } catch {
            return false
          }
        })
        .map((row) => row.video_id)
        .filter((videoId) => candidateIds.has(videoId))
      if (sourceUrlMatches.length > 0) {
        signals.push(sourceUrlMatches)
        if (input.code && sourceUrlMatches.some((videoId) => {
          const candidate = input.candidates.find((entry) => entry.videoId === videoId)
          return candidate != null && normalizeVideoCode(candidate.code) !== input.code
        })) {
          canonical.strongSignalConflict = true
        }
      }
    }

    if (input.code && canonical.publisher && canonical.releaseDate) {
      let normalizedPublisher: string | null = null
      try {
        normalizedPublisher = normalizeClassificationName(canonical.publisher)
      } catch {
        normalizedPublisher = null
      }
      if (normalizedPublisher) {
        const businessMatches = (this.database.prepare(
          `SELECT video.id AS video_id
           FROM videos video
           JOIN organization_name_ownership owner
             ON owner.organization_id = video.publisher_organization_id
           WHERE owner.normalized_name = ?
             AND upper(trim(video.code)) = ?
             AND video.release_date = ?
           ORDER BY video.id`
        ).all(normalizedPublisher, input.code, canonical.releaseDate) as Array<{ video_id: number }>)
          .map((row) => row.video_id)
          .filter((videoId) => candidateIds.has(videoId))
        if (businessMatches.length > 0) {
          signals.push(businessMatches)
        } else if (input.candidates.some((candidate) => (
          candidate.publisherOrganizationId != null && candidate.releaseDate != null
        ))) {
          canonical.strongSignalMismatch = true
        }
      }
    }

    if (signals.length === 0) return canonical
    const intersection = signals.slice(1).reduce(
      (current, signal) => current.filter((videoId) => signal.includes(videoId)),
      [...new Set(signals[0])]
    )
    const distinctSignalIds = new Set(signals.flat())
    if (intersection.length === 1) canonical.strongMatchVideoId = intersection[0]
    canonical.strongSignalConflict ||= intersection.length === 0 && distinctSignalIds.size > 1
    return canonical
  }

  private currentCandidatesForItem(item: ApplyItemRow): GlobalIdentityCandidate[] {
    const identity = item.detail_identity_json
      ? JSON.parse(item.detail_identity_json) as CanonicalDetailIdentity
      : null
    return this.mergeGlobalIdentityCandidates(
      this.globalCodeCandidatesForCodes([
        item.normalized_code,
        identity?.codeConflict ? identity.detailCode ?? null : null
      ]),
      this.globalDetailUrlCandidates(item.normalized_detail_url),
      identity ? this.globalSourceIdentityCandidates(identity) : []
    )
  }

  private isResolutionCurrent(job: JobRow, item: ApplyItemRow): boolean {
    const candidates = this.currentCandidatesForItem(item)
    const frozenCandidates = item.candidate_snapshot_json ?? '[]'
    if (JSON.stringify(candidates) !== frozenCandidates) return false
    if (item.state === 'planned-create') {
      if (item.resolution_kind === 'create-no-match') return candidates.length === 0
      if (item.resolution_kind === 'user-create') {
        const decision = this.database.prepare(
          `SELECT expected_item_revision, choice_kind FROM playlist_import_decisions
           WHERE item_id = ?`
        ).get(item.id) as {
          expected_item_revision: number
          choice_kind: string
        } | undefined
        return decision?.choice_kind === 'create' && item.revision === decision.expected_item_revision + 1
      }
      return false
    }
    if (item.state !== 'planned-reuse' || item.resolved_video_id == null) return false
    if (!candidates.some((candidate) => candidate.videoId === item.resolved_video_id)) return false
    if (item.resolution_kind === 'direct-code') {
      return candidates.length === 1 && candidates[0].videoId === item.resolved_video_id
    }
    if (item.resolution_kind === 'target-library-tiebreak') {
      const targetMatches = candidates.filter((candidate) => (
        candidate.libraryIds.includes(job.target_library_id)
      ))
      return candidates.length > 1 && targetMatches.length === 1 &&
        targetMatches[0].videoId === item.resolved_video_id
    }
    if (item.resolution_kind === 'user-existing') {
      const decision = this.database.prepare(
        `SELECT expected_item_revision, choice_kind, chosen_video_id
         FROM playlist_import_decisions WHERE item_id = ?`
      ).get(item.id) as {
        expected_item_revision: number
        choice_kind: string
        chosen_video_id: number | null
      } | undefined
      return decision?.choice_kind === 'existing' &&
        decision.chosen_video_id === item.resolved_video_id &&
        item.revision === decision.expected_item_revision + 1
    }
    if (item.resolution_kind === 'business-identity') {
      if (!item.detail_identity_json) return false
      const frozenIdentity = JSON.parse(item.detail_identity_json) as CanonicalDetailIdentity
      const currentIdentity = this.canonicalDetailIdentity({
        code: item.normalized_code,
        detailUrl: item.normalized_detail_url,
        identity: frozenIdentity as unknown as Record<string, unknown>,
        candidates
      })
      return !currentIdentity.strongSignalConflict &&
        !currentIdentity.strongSignalMismatch &&
        currentIdentity.strongMatchVideoId === item.resolved_video_id
    }
    return false
  }

  private reopenStalePreview(runId: string): void {
    this.database.transaction(() => {
      const job = this.requireJob(runId, 'ready-to-apply')
      const items = this.database.prepare(
        'SELECT * FROM playlist_import_items WHERE run_id = ? ORDER BY source_position'
      ).all(runId) as ApplyItemRow[]
      let hasDetail = false
      let hasUser = false
      const at = now()
      for (const item of items) {
        const candidates = this.currentCandidatesForItem(item)
        if (item.state === 'failed' && item.error_code === 'AUTO_CREATE_DISABLED') {
          if (candidates.length === 0) continue
          if (candidates.length === 1) {
            this.database.prepare(
              `UPDATE playlist_import_items SET state = 'planned-reuse',
               resolution_kind = 'direct-code', resolved_video_id = ?,
               candidate_snapshot_json = ?, error_code = NULL,
               revision = revision + 1, updated_at = ? WHERE id = ?`
            ).run(candidates[0].videoId, JSON.stringify(candidates), at, item.id)
            continue
          }
        } else if (this.isResolutionCurrent(job, item)) {
          continue
        }
        const needsUser = item.resolution_kind === 'target-library-tiebreak' ||
          item.resolution_kind === 'user-existing' || item.resolution_kind === 'user-create'
        hasUser ||= needsUser
        hasDetail ||= !needsUser
        this.database.prepare(
          `UPDATE playlist_import_items SET state = ?, resolution_kind = NULL,
           resolved_video_id = NULL, candidate_snapshot_json = ?, error_code = NULL,
           revision = revision + 1, updated_at = ? WHERE id = ?`
        ).run(
          needsUser ? 'needs-user' : 'needs-detail',
          JSON.stringify(candidates),
          at,
          item.id
        )
        this.database.prepare('DELETE FROM playlist_import_decisions WHERE item_id = ?').run(item.id)
      }
      const phase = hasDetail ? 'resolving-identities' : hasUser ? 'waiting_user' : 'ready-to-apply'
      this.database.prepare(
        `UPDATE playlist_import_jobs SET phase = ?, error_code = 'IMPORT_PREVIEW_STALE',
         error_message = '媒体库内容已变化，请重新确认受影响的影片身份。',
         revision = revision + 1, updated_at = ? WHERE run_id = ?`
      ).run(phase, at, runId)
    })()
  }

  private updateResolutionPhase(runId: string, at: string): void {
    const counts = this.database.prepare(
      `SELECT
        COALESCE(SUM(state = 'needs-detail'), 0) AS details,
        COALESCE(SUM(state = 'needs-user'), 0) AS users
       FROM playlist_import_items WHERE run_id = ?`
    ).get(runId) as { details: number; users: number }
    const phase = counts.details > 0
      ? 'resolving-identities'
      : counts.users > 0
        ? 'waiting_user'
        : 'ready-to-apply'
    this.database.prepare(
      `UPDATE playlist_import_jobs SET phase = ?, error_code = NULL, error_message = NULL,
       revision = revision + 1, updated_at = ?
       WHERE run_id = ?`
    ).run(phase, at, runId)
  }

  private identityReviewItems(job: JobRow): NonNullable<
    Extract<PlaylistImportSnapshot['attention'], { kind: 'identity-review' }>
  >['items'] {
    const rows = this.database.prepare(
      `SELECT id, revision, normalized_code, title, detail_url, error_code,
        candidate_snapshot_json, detail_identity_json
       FROM playlist_import_items WHERE run_id = ? AND state = 'needs-user'
       ORDER BY source_position LIMIT 50`
    ).all(job.run_id) as Array<{
      id: number
      revision: number
      normalized_code: string | null
      title: string | null
      detail_url: string
      error_code: string | null
      candidate_snapshot_json: string | null
      detail_identity_json: string | null
    }>
    return rows.map((item) => {
      const identity = item.detail_identity_json
        ? JSON.parse(item.detail_identity_json) as CanonicalDetailIdentity
        : null
      return {
        itemId: item.id,
        itemRevision: item.revision,
        ...(item.normalized_code ? { code: item.normalized_code } : {}),
        ...(item.title ? { title: item.title } : {}),
        detailUrl: item.detail_url,
        ...(identity?.codeConflict && identity.listCode && identity.detailCode
          ? {
              conflict: {
                kind: 'code-mismatch' as const,
                listCode: identity.listCode,
                detailCode: identity.detailCode
              }
            }
          : item.error_code === 'SENSITIVE_DETAIL_URL'
            ? { conflict: { kind: 'sensitive-detail-url' as const } }
            : {}),
        candidates: (JSON.parse(item.candidate_snapshot_json ?? '[]') as Array<{
        videoId: number
        code: string
        libraryIds: number[]
      }>).map((candidate) => {
        const detail = this.database.prepare(
          `SELECT video.title, video.release_date, publisher.main_name AS publisher
           FROM videos video
           LEFT JOIN organizations publisher ON publisher.id = video.publisher_organization_id
           WHERE video.id = ?`
        ).get(candidate.videoId) as {
          title: string | null
          release_date: string | null
          publisher: string | null
        } | undefined
        const resources = this.database.prepare(
          'SELECT DISTINCT kind FROM video_resources WHERE video_id = ? ORDER BY kind'
        ).all(candidate.videoId) as Array<{ kind: string }>
        const libraries = this.database.prepare(
          `SELECT library.name FROM library_video_memberships membership
           JOIN media_libraries library ON library.id = membership.library_id
           WHERE membership.video_id = ? ORDER BY library.position, library.id`
        ).all(candidate.videoId) as Array<{ name: string }>
        const relatedLinks = this.database.prepare(
          'SELECT label, url FROM video_links WHERE video_id = ? ORDER BY position, id'
        ).all(candidate.videoId) as Array<{ label: string; url: string }>
        return {
          videoId: candidate.videoId,
          code: candidate.code,
          ...(detail?.title ? { title: detail.title } : {}),
          ...(detail?.publisher ? { publisher: detail.publisher } : {}),
          ...(detail?.release_date ? { releaseDate: detail.release_date } : {}),
          libraryIds: candidate.libraryIds,
          libraryNames: libraries.map((library) => library.name),
          belongsToTargetLibrary: candidate.libraryIds.includes(job.target_library_id),
          resourceKinds: resources.map((resource) => resource.kind),
          relatedLinks
        }
      })
      }
    })
  }

  cancel(runId: string): PlaylistImportSnapshot {
    const row = this.requireJob(runId)
    if (row.phase === 'completed') return this.snapshot(runId)!
    if (row.phase !== 'cancelled') {
      this.database.prepare(
        `UPDATE playlist_import_jobs SET phase = 'cancelled', revision = revision + 1, updated_at = ?
         WHERE run_id = ? AND phase != 'completed'`
      ).run(now(), runId)
    }
    return this.snapshot(runId)!
  }

  setBrowserHandoff(input: {
    runId: string
    requestId: string
    reason: 'login' | 'human_verification' | 'required_user_action'
    prompt: string
  }): PlaylistImportSnapshot {
    this.database.transaction(() => {
      const job = this.requireJob(input.runId)
      if (!['discovering-list', 'resolving-identities'].includes(job.phase)) {
        throw new Error(`PLAYLIST_IMPORT_PHASE_INVALID:${job.phase}`)
      }
      const at = now()
      this.database.prepare(
        `INSERT INTO playlist_import_session_events (
          run_id, operation_id, event_type, payload_json, created_at
        ) VALUES (?, NULL, 'playlist-import.browser-handoff', ?, ?)`
      ).run(input.runId, JSON.stringify({ ...input, resumePhase: job.phase }), at)
      this.database.prepare(
        `UPDATE playlist_import_jobs SET phase = 'waiting_user',
         revision = revision + 1, updated_at = ? WHERE run_id = ?`
      ).run(at, input.runId)
    })()
    return this.snapshot(input.runId)!
  }

  resumeBrowser(runId: string, requestId: string, idempotencyKey: string): PlaylistImportSnapshot {
    try {
      this.assertRunWithinBudget(runId)
    } catch (error) {
      if (error instanceof PlaylistImportLimitError) {
        return this.fail(runId, 'LIMIT_REACHED', error.message)
      }
      throw error
    }
    const replay = (this.database.prepare(
      `SELECT payload_json FROM playlist_import_session_events
       WHERE run_id = ? AND event_type = 'playlist-import.browser-resumed'
       ORDER BY seq`
    ).all(runId) as Array<{ payload_json: string }>).map((row) => (
      JSON.parse(row.payload_json) as { requestId: string; idempotencyKey: string }
    )).find((entry) => entry.idempotencyKey === idempotencyKey)
    if (replay) {
      if (replay.requestId !== requestId) throw new Error('IDEMPOTENCY_KEY_REUSED')
      return this.snapshot(runId)!
    }
    this.database.transaction(() => {
      this.requireJob(runId, 'waiting_user')
      const handoff = this.pendingBrowserHandoff(runId)
      if (!handoff || handoff.requestId !== requestId) throw new Error('BROWSER_HANDOFF_STALE')
      const latest = this.database.prepare(
        `SELECT payload_json FROM playlist_import_session_events
         WHERE run_id = ? AND event_type = 'playlist-import.browser-handoff'
         ORDER BY seq DESC LIMIT 1`
      ).get(runId) as { payload_json: string }
      const payload = JSON.parse(latest.payload_json) as { resumePhase: PlaylistImportPhase }
      if (!['discovering-list', 'resolving-identities'].includes(payload.resumePhase)) {
        throw new Error('BROWSER_HANDOFF_CORRUPT')
      }
      const at = now()
      this.database.prepare(
        `INSERT INTO playlist_import_session_events (
          run_id, operation_id, event_type, payload_json, created_at
        ) VALUES (?, NULL, 'playlist-import.browser-resumed', ?, ?)`
      ).run(runId, JSON.stringify({ requestId, idempotencyKey }), at)
      this.database.prepare(
        `UPDATE playlist_import_jobs SET phase = ?, revision = revision + 1, updated_at = ?
         WHERE run_id = ?`
      ).run(payload.resumePhase, at, runId)
    })()
    return this.snapshot(runId)!
  }

  fail(runId: string, code: string, message: string): PlaylistImportSnapshot {
    const row = this.requireJob(runId)
    if (['completed', 'cancelled'].includes(row.phase)) return this.snapshot(runId)!
    this.database.prepare(
      `UPDATE playlist_import_jobs SET phase = 'failed', error_code = ?, error_message = ?,
       revision = revision + 1, updated_at = ? WHERE run_id = ?`
    ).run(code, message, now(), runId)
    return this.snapshot(runId)!
  }

  private markReadyToApplyError(runId: string, code: string, message: string): void {
    this.database.prepare(
      `UPDATE playlist_import_jobs SET phase = 'ready-to-apply', error_code = ?, error_message = ?,
       revision = revision + 1, updated_at = ? WHERE run_id = ?`
    ).run(code, message, now(), runId)
  }

  apply(runId: string, applyIdempotencyKey: string): PlaylistImportOutcome {
    try {
      return this.database.transaction(() => {
      const job = this.requireJob(runId)
      if (job.phase === 'completed' && job.outcome_json) {
        if (job.apply_idempotency_key !== applyIdempotencyKey) {
          throw new Error('APPLY_IDEMPOTENCY_KEY_REUSED')
        }
        return parseOutcome(job.outcome_json)
      }
      if (job.phase !== 'ready-to-apply') throw new Error('PLAYLIST_IMPORT_NOT_READY')
      const library = this.database.prepare(
        'SELECT name, status FROM media_libraries WHERE id = ?'
      ).get(job.target_library_id) as { name: string; status: string } | undefined
      if (!library) {
        throw new PlaylistImportTargetError(
          'TARGET_LIBRARY_NOT_FOUND',
          '目标媒体库已不存在，无法完成导入。'
        )
      }
      if (library.status !== 'active') {
        throw new PlaylistImportTargetError(
          'TARGET_LIBRARY_ARCHIVED',
          '目标媒体库已归档，无法完成导入。'
        )
      }
      const items = this.database.prepare(
        `SELECT * FROM playlist_import_items WHERE run_id = ? ORDER BY source_position`
      ).all(runId) as ApplyItemRow[]
      if (items.some((item) => (
        !['planned-reuse', 'planned-create'].includes(item.state) &&
        !(item.state === 'failed' && item.error_code === 'AUTO_CREATE_DISABLED')
      ))) {
        throw new Error('PLAYLIST_IMPORT_ITEMS_NOT_READY')
      }
      if (items.some((item) => (
        item.state === 'failed' && item.error_code === 'AUTO_CREATE_DISABLED'
          ? this.currentCandidatesForItem(item).length > 0
          : !this.isResolutionCurrent(job, item)
      ))) throw new ImportPreviewStaleError()

      let playlistId: number
      if (job.destination_kind === 'append') {
        const playlist = this.database.prepare('SELECT id FROM playlists WHERE id = ?')
          .get(job.requested_playlist_id) as { id: number } | undefined
        if (!playlist) {
          throw new PlaylistImportTargetError(
            'TARGET_PLAYLIST_NOT_FOUND',
            '目标清单已不存在，无法完成导入。'
          )
        }
        playlistId = playlist.id
      } else {
        const fallbackName = `${job.source_host} · ${new Date().toISOString().slice(0, 10)}`
        playlistId = Number(this.database.prepare(
          `INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)`
        ).run(
          job.requested_playlist_name || job.agent_suggested_playlist_name || fallbackName,
          now(),
          now()
        ).lastInsertRowid)
      }
      let playlistRelatedLinksAdded = 0
      if (job.save_source_playlist_link === 1) {
        playlistRelatedLinksAdded = this.database.prepare(
          `INSERT OR IGNORE INTO playlist_links (
            playlist_id, label, url, normalized_url, position
          )
          SELECT ?, ?, ?, ?, COALESCE(MAX(position), -1) + 1
          FROM playlist_links WHERE playlist_id = ?`
        ).run(
          playlistId,
          job.source_host,
          job.normalized_source_url,
          job.normalized_source_url,
          playlistId
        ).changes
      }
      const playlist = this.database.prepare(
        'SELECT name FROM playlists WHERE id = ?'
      ).get(playlistId) as { name: string }
      const pagesRead = (this.database.prepare(
        'SELECT COUNT(*) AS value FROM playlist_import_pages WHERE run_id = ?'
      ).get(runId) as { value: number }).value
      const sourceItems = (this.database.prepare(
        `SELECT COUNT(*) AS value FROM playlist_import_page_items occurrence
         JOIN playlist_import_pages page ON page.id = occurrence.page_id
         WHERE page.run_id = ?`
      ).get(runId) as { value: number }).value
      let reusedVideos = 0
      let directReuses = 0
      let detailReuses = 0
      let userSelectedReuses = 0
      let crossLibraryReuses = 0
      let createdVideos = 0
      let targetLibraryMembersCreated = 0
      let skippedVideos = 0
      let addedToPlaylist = 0
      let alreadyInPlaylist = 0
      let relatedLinksAdded = 0
      const resolvedVideoIds: number[] = []
      const reuseLibraryDistribution = new Map<
        number,
        { libraryId: number; libraryName: string; reusedVideos: number }
      >()
      let nextPosition = (this.database.prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS value FROM playlist_video WHERE playlist_id = ?'
      ).get(playlistId) as { value: number }).value
      const initiallyInPlaylist = new Set((this.database.prepare(
        'SELECT video_id FROM playlist_video WHERE playlist_id = ?'
      ).all(playlistId) as Array<{ video_id: number }>).map((row) => row.video_id))
      const insertLink = this.database.prepare(
        `INSERT OR IGNORE INTO video_links (video_id, label, url, normalized_url, position)
         SELECT ?, ?, ?, ?, COALESCE(MAX(position), -1) + 1 FROM video_links WHERE video_id = ?`
      )
      const insertPlaylistVideo = this.database.prepare(
        `INSERT OR IGNORE INTO playlist_video (playlist_id, video_id, position, added_at)
         VALUES (?, ?, ?, ?)`
      )
      for (const item of items) {
        if (item.state === 'failed' && item.error_code === 'AUTO_CREATE_DISABLED') {
          skippedVideos += 1
          continue
        }
        let videoId: number
        if (item.state === 'planned-reuse') {
          if (item.resolved_video_id == null || !this.database.prepare('SELECT 1 FROM videos WHERE id = ?').get(item.resolved_video_id)) {
            throw new Error('MATCH_SNAPSHOT_STALE')
          }
          videoId = item.resolved_video_id
          reusedVideos += 1
          if (item.resolution_kind === 'user-existing') {
            userSelectedReuses += 1
          } else if (item.detail_identity_json) {
            detailReuses += 1
          } else {
            directReuses += 1
          }
          const memberships = this.database.prepare(
            `SELECT library.id, library.name
             FROM library_video_memberships membership
             JOIN media_libraries library ON library.id = membership.library_id
             WHERE membership.video_id = ?
             ORDER BY library.position, library.id`
          ).all(videoId) as Array<{ id: number; name: string }>
          if (
            memberships.length > 0 &&
            !memberships.some((membership) => membership.id === job.target_library_id)
          ) {
            crossLibraryReuses += 1
          }
          const distributionMemberships = memberships.length > 0
            ? memberships
            : [{ id: 0, name: '未归属媒体库' }]
          for (const membership of distributionMemberships) {
            const current = reuseLibraryDistribution.get(membership.id)
            if (current) {
              current.reusedVideos += 1
            } else {
              reuseLibraryDistribution.set(membership.id, {
                libraryId: membership.id,
                libraryName: membership.name,
                reusedVideos: 1
              })
            }
          }
        } else {
          videoId = Number(this.database.prepare(
            `INSERT INTO videos (code, title, scraped_status) VALUES (?, ?, 0)`
          ).run(item.normalized_code ?? '', item.title).lastInsertRowid)
          if (ensureVideoMembership({
            libraryId: job.target_library_id,
            videoId,
            addedVia: 'manual'
          }, this.database)) targetLibraryMembersCreated += 1
          createdVideos += 1
        }
        resolvedVideoIds.push(videoId)
        if (job.save_detail_links === 1) {
          const link = insertLink.run(
            videoId,
            job.source_host,
            item.detail_url,
            item.normalized_detail_url,
            videoId
          )
          relatedLinksAdded += link.changes
        }
        const membership = insertPlaylistVideo.run(playlistId, videoId, nextPosition, now())
        if (membership.changes > 0) {
          addedToPlaylist += 1
          nextPosition += 1
        } else if (initiallyInPlaylist.has(videoId)) {
          alreadyInPlaylist += 1
        }
        this.database.prepare(
          `UPDATE playlist_import_items SET state = 'applied', resolved_video_id = ?,
           revision = revision + 1, updated_at = ? WHERE id = ?`
        ).run(videoId, now(), item.id)
      }
      const outcome: PlaylistImportOutcome = {
        playlistId,
        playlistName: playlist.name,
        targetLibraryId: job.target_library_id,
        targetLibraryName: library.name,
        pagesRead,
        sourceItems,
        uniqueDetailUrls: items.length,
        totalItems: items.length,
        reusedVideos,
        directReuses,
        detailReuses,
        userSelectedReuses,
        crossLibraryReuses,
        createdVideos,
        targetLibraryMembersCreated,
        skippedVideos,
        addedToPlaylist,
        alreadyInPlaylist,
        relatedLinksAdded,
        playlistRelatedLinksAdded,
        externalDuplicateItems: Math.max(0, sourceItems - items.length),
        convergedExternalItems: resolvedVideoIds.length - new Set(resolvedVideoIds).size,
        reuseLibraryDistribution: [...reuseLibraryDistribution.values()]
      }
      const at = now()
      this.database.prepare(
        `UPDATE playlist_import_jobs SET phase = 'completed', error_code = NULL,
         error_message = NULL, revision = revision + 1,
         resolved_playlist_id = ?, apply_idempotency_key = ?, outcome_json = ?,
         committed_at = ?, updated_at = ? WHERE run_id = ?`
      ).run(playlistId, applyIdempotencyKey, JSON.stringify(outcome), at, at, runId)
      return outcome
      })()
    } catch (error) {
      if (error instanceof ImportPreviewStaleError) {
        this.reopenStalePreview(runId)
        throw new Error('IMPORT_PREVIEW_STALE')
      }
      if (error instanceof PlaylistImportTargetError) {
        if (error.code === 'TARGET_LIBRARY_ARCHIVED') {
          this.markReadyToApplyError(runId, error.code, error.message)
        } else {
          this.fail(runId, error.code, error.message)
        }
        throw new Error(error.code)
      }
      const message = error instanceof Error ? error.message : String(error)
      if (this.snapshot(runId)?.phase !== 'ready-to-apply') throw error
      this.markReadyToApplyError(runId, 'APPLY_FAILED', message)
      throw new Error('APPLY_FAILED')
    }
  }

  private requireJob(runId: string, phase?: PlaylistImportPhase): JobRow {
    const row = this.database.prepare('SELECT * FROM playlist_import_jobs WHERE run_id = ?')
      .get(runId) as JobRow | undefined
    if (!row) throw new Error('PLAYLIST_IMPORT_NOT_FOUND')
    if (phase && row.phase !== phase) throw new Error(`PLAYLIST_IMPORT_PHASE_INVALID:${row.phase}`)
    return row
  }

  private captureSuggestedPlaylistName(job: JobRow, value: string | null): void {
    if (
      !value ||
      job.destination_kind !== 'create' ||
      Boolean(job.requested_playlist_name)
    ) return
    if (
      job.agent_suggested_playlist_name &&
      job.agent_suggested_playlist_name !== value
    ) {
      throw new Error('PLAYLIST_IMPORT_NAME_CONFLICT')
    }
    if (job.agent_suggested_playlist_name) return
    this.database.prepare(
      `UPDATE playlist_import_jobs SET agent_suggested_playlist_name = ? WHERE run_id = ?`
    ).run(value, job.run_id)
    job.agent_suggested_playlist_name = value
  }

  private resetStaticPageCheckpoint(
    job: JobRow,
    page: { page_order: number; normalized_page_url: string }
  ): void {
    this.database.prepare(
      'DELETE FROM playlist_import_pages WHERE run_id = ? AND page_order >= ?'
    ).run(job.run_id, page.page_order)
    this.database.prepare(
      `UPDATE playlist_import_frontier SET status = 'in-flight', updated_at = ?
       WHERE run_id = ? AND canonical_key = ?`
    ).run(now(), job.run_id, `url:${page.normalized_page_url}`)
    if (page.page_order === 0 && job.destination_kind === 'create' && !job.requested_playlist_name) {
      this.database.prepare(
        'UPDATE playlist_import_jobs SET agent_suggested_playlist_name = NULL WHERE run_id = ?'
      ).run(job.run_id)
      job.agent_suggested_playlist_name = null
    }
    this.clearPageChangedError(job)
  }

  private resetDynamicBatchCheckpoint(
    job: JobRow,
    batch: {
      page_id: number
      page_order: number
      batch_order: number
      normalized_page_url: string
    }
  ): void {
    const preservedOccurrenceKeys = (this.database.prepare(
      `SELECT DISTINCT value AS occurrence_key
       FROM playlist_import_scroll_batches saved,
       json_each(saved.ordered_occurrence_keys_json)
       WHERE saved.page_id = ? AND saved.batch_order < ?`
    ).all(batch.page_id, batch.batch_order) as Array<{ occurrence_key: string }>)
      .map((row) => row.occurrence_key)
    this.database.prepare(
      `DELETE FROM playlist_import_frontier
       WHERE source_page_id IN (
         SELECT id FROM playlist_import_pages WHERE run_id = ? AND page_order >= ?
       )`
    ).run(job.run_id, batch.page_order)
    this.database.prepare(
      'DELETE FROM playlist_import_pages WHERE run_id = ? AND page_order > ?'
    ).run(job.run_id, batch.page_order)
    this.database.prepare(
      `DELETE FROM playlist_import_page_items
       WHERE page_id = ? AND source_occurrence_key NOT IN (
         SELECT CAST(value AS TEXT) FROM json_each(?)
       )`
    ).run(batch.page_id, JSON.stringify(preservedOccurrenceKeys))
    this.database.prepare(
      'DELETE FROM playlist_import_scroll_batches WHERE page_id = ? AND batch_order >= ?'
    ).run(batch.page_id, batch.batch_order)
    this.database.prepare(
      `DELETE FROM playlist_import_items
       WHERE run_id = ? AND NOT EXISTS (
         SELECT 1 FROM playlist_import_page_items occurrence
         WHERE occurrence.item_id = playlist_import_items.id
       )`
    ).run(job.run_id)
    const observed = (this.database.prepare(
      'SELECT COUNT(*) AS count FROM playlist_import_page_items WHERE page_id = ?'
    ).get(batch.page_id) as { count: number }).count
    this.database.prepare(
      `UPDATE playlist_import_pages SET enumeration_status = 'open', sequence_digest = NULL,
       content_hash = NULL, advance_json = NULL, observed_item_count = ?, sealed_at = NULL
       WHERE id = ?`
    ).run(observed, batch.page_id)
    this.database.prepare(
      `UPDATE playlist_import_frontier SET status = 'in-flight', updated_at = ?
       WHERE run_id = ? AND canonical_key = ?`
    ).run(now(), job.run_id, `url:${batch.normalized_page_url}`)
    if (
      batch.page_order === 0 && batch.batch_order === 0 &&
      job.destination_kind === 'create' && !job.requested_playlist_name
    ) {
      this.database.prepare(
        'UPDATE playlist_import_jobs SET agent_suggested_playlist_name = NULL WHERE run_id = ?'
      ).run(job.run_id)
      job.agent_suggested_playlist_name = null
    }
    this.clearPageChangedError(job)
  }

  resetDynamicPageForRetry(runId: string, pageKey: string): PlaylistImportSnapshot {
    this.database.transaction(() => {
      const job = this.requireJob(runId, 'discovering-list')
      if (!['PAGE_CHANGED', 'TOTAL_MISMATCH'].includes(job.error_code ?? '')) {
        throw new Error('PLAYLIST_IMPORT_DYNAMIC_RECOVERY_NOT_REQUIRED')
      }
      const page = this.database.prepare(
        `SELECT id, page_order, normalized_page_url FROM playlist_import_pages
         WHERE run_id = ? AND page_key = ? AND enumeration_kind IN ('virtual-scroll', 'load-more')`
      ).get(runId, pageKey) as {
        id: number
        page_order: number
        normalized_page_url: string
      } | undefined
      if (!page) throw new Error('PLAYLIST_IMPORT_DYNAMIC_PAGE_NOT_FOUND')
      this.database.prepare(
        `DELETE FROM playlist_import_frontier
         WHERE source_page_id IN (
           SELECT id FROM playlist_import_pages WHERE run_id = ? AND page_order >= ?
         )`
      ).run(runId, page.page_order)
      this.database.prepare(
        'DELETE FROM playlist_import_pages WHERE run_id = ? AND page_order >= ?'
      ).run(runId, page.page_order)
      this.database.prepare(
        `DELETE FROM playlist_import_items
         WHERE run_id = ? AND NOT EXISTS (
           SELECT 1 FROM playlist_import_page_items occurrence
           WHERE occurrence.item_id = playlist_import_items.id
         )`
      ).run(runId)
      this.database.prepare(
        `UPDATE playlist_import_frontier SET status = 'in-flight', updated_at = ?
         WHERE run_id = ? AND canonical_key = ?`
      ).run(now(), runId, `url:${page.normalized_page_url}`)
      if (page.page_order === 0 && job.destination_kind === 'create' && !job.requested_playlist_name) {
        this.database.prepare(
          'UPDATE playlist_import_jobs SET agent_suggested_playlist_name = NULL WHERE run_id = ?'
        ).run(runId)
      }
      this.clearPageChangedError(job)
      this.bumpJob(runId, now())
    })()
    return this.snapshot(runId)!
  }

  resetDiscoveryForTotalMismatch(runId: string): PlaylistImportSnapshot {
    this.database.transaction(() => {
      const job = this.requireJob(runId, 'discovering-list')
      if (job.error_code !== 'TOTAL_MISMATCH') {
        throw new Error('PLAYLIST_IMPORT_TOTAL_MISMATCH_RECOVERY_NOT_REQUIRED')
      }
      this.database.prepare(
        'DELETE FROM playlist_import_pages WHERE run_id = ?'
      ).run(runId)
      this.database.prepare(
        'DELETE FROM playlist_import_frontier WHERE run_id = ? AND canonical_key != ?'
      ).run(runId, `url:${job.normalized_source_url}`)
      this.database.prepare(
        `UPDATE playlist_import_frontier SET source_page_id = NULL, status = 'in-flight',
         updated_at = ? WHERE run_id = ? AND canonical_key = ?`
      ).run(now(), runId, `url:${job.normalized_source_url}`)
      if (job.destination_kind === 'create' && !job.requested_playlist_name) {
        this.database.prepare(
          'UPDATE playlist_import_jobs SET agent_suggested_playlist_name = NULL WHERE run_id = ?'
        ).run(runId)
      }
      this.bumpJob(runId, now())
    })()
    return this.snapshot(runId)!
  }

  private clearPageChangedError(job: JobRow): void {
    this.database.prepare(
      `UPDATE playlist_import_jobs SET error_code = NULL, error_message = NULL
       WHERE run_id = ? AND error_code = 'PAGE_CHANGED'`
    ).run(job.run_id)
    job.error_code = null
    job.error_message = null
  }

  private pendingBrowserHandoff(runId: string): Extract<
    NonNullable<PlaylistImportSnapshot['attention']>,
    { kind: 'browser-handoff' }
  > | null {
    const latest = this.database.prepare(
      `SELECT event_type, payload_json FROM playlist_import_session_events
       WHERE run_id = ? AND event_type IN (
         'playlist-import.browser-handoff', 'playlist-import.browser-resumed'
       ) ORDER BY seq DESC LIMIT 1`
    ).get(runId) as { event_type: string; payload_json: string } | undefined
    if (!latest || latest.event_type !== 'playlist-import.browser-handoff') return null
    const payload = JSON.parse(latest.payload_json) as {
      requestId: string
      reason: 'login' | 'human_verification' | 'required_user_action'
      prompt: string
    }
    return {
      kind: 'browser-handoff',
      requestId: payload.requestId,
      reason: payload.reason,
      prompt: payload.prompt
    }
  }

  private bumpJob(runId: string, at: string): void {
    this.database.prepare(
      `UPDATE playlist_import_jobs SET
       error_code = CASE WHEN error_code IN (
         'SCROLL_STALLED', 'PAGE_CHANGED', 'PAGE_CHECKPOINT_REQUIRED',
         'NETWORK_TIMEOUT', 'BROWSER_SESSION_LOST', 'SOURCE_CHANGED', 'TOTAL_MISMATCH'
       ) THEN NULL ELSE error_code END,
       error_message = CASE WHEN error_code IN (
         'SCROLL_STALLED', 'PAGE_CHANGED', 'PAGE_CHECKPOINT_REQUIRED',
         'NETWORK_TIMEOUT', 'BROWSER_SESSION_LOST', 'SOURCE_CHANGED', 'TOTAL_MISMATCH'
       ) THEN NULL ELSE error_message END,
       revision = revision + 1, updated_at = ? WHERE run_id = ?`
    ).run(at, runId)
  }
}

function playlistNameForSnapshot(database: Database.Database, row: JobRow): string | null {
  if (row.destination_kind !== 'append' || row.requested_playlist_id == null) return null
  return (database.prepare('SELECT name FROM playlists WHERE id = ?').get(row.requested_playlist_id) as {
    name: string
  } | undefined)?.name ?? null
}
