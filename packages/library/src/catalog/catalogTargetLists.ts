import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { structuredError } from '@shared/protocol/errors'
import type { TargetListCreateInput, TargetListEntry, TargetListPage } from '@shared/protocol/tasks'
import type { ActressScrapeField } from '@shared/actressScrapeTypes'
import type { VideoScrapeField } from '@shared/videoScrapeTypes'
import { getDb } from '@library/db/database'
import { listVideosForBatchScrape } from '@library/db/videoRepo'
import { listActressesForBatchScrape } from '@library/db/actressRepo'
import { readCatalogSetting, writeCatalogSetting } from '@library/catalog/catalogSettings'

const LIST_KEY_PREFIX = 'target-list:'

export interface StoredTargetList {
  id: string
  kind: string
  filterDigest: string
  ids: number[]
  revisions: number[]
  labels: Array<string | null>
  createdAt: string
}

type VideoFilter = NonNullable<TargetListCreateInput['videoFilter']>
type ActressFilter = NonNullable<TargetListCreateInput['actressFilter']>

function settingKey(targetListId: string): string {
  return `${LIST_KEY_PREFIX}${targetListId}`
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function digestIds(kind: string, ids: number[]): string {
  return digestJson({ kind, ids })
}

export function compactTargetVideoFilter(filter: VideoFilter): VideoFilter {
  return {
    ...(filter.libraryId != null ? { libraryId: filter.libraryId } : {}),
    ...(filter.status !== undefined ? { status: filter.status } : {}),
    ...(filter.missingFields?.length
      ? { missingFields: filter.missingFields as VideoScrapeField[] }
      : {}),
    ...(filter.sourceName ? { sourceName: filter.sourceName } : {}),
    ...(filter.ratingSourceName ? { ratingSourceName: filter.ratingSourceName } : {})
  }
}

export function compactTargetActressFilter(filter: ActressFilter): ActressFilter {
  return {
    ...(filter.scope ? { scope: filter.scope } : {}),
    ...(filter.scrapeStatus ? { scrapeStatus: filter.scrapeStatus } : {}),
    ...(filter.missingFields?.length ? { missingFields: filter.missingFields } : {})
  }
}

export function targetListRequestDigest(
  input: Pick<TargetListCreateInput, 'kind' | 'ids' | 'videoFilter' | 'actressFilter'>
): string {
  const selectors = [input.ids, input.videoFilter, input.actressFilter].filter((value) => value != null)
  if (selectors.length > 1) {
    throw structuredError(
      'INVALID_INPUT',
      '目标列表不能同时使用 ids、videoFilter 和 actressFilter',
      { field: 'filterDigest' }
    )
  }
  if (input.ids) return digestIds(input.kind, input.ids)
  if (input.videoFilter) {
    return digestJson({ kind: input.kind, videoFilter: compactTargetVideoFilter(input.videoFilter) })
  }
  if (input.actressFilter) {
    return digestJson({
      kind: input.kind,
      actressFilter: compactTargetActressFilter(input.actressFilter)
    })
  }
  throw structuredError(
    'INVALID_INPUT',
    '命名 kind 的 digest 需按当前筛选结果计算',
    { field: 'filterDigest' }
  )
}

function evaluateKind(kind: string, _database: Database.Database): number[] {
  const videoLibrary = /^videos\.library:(\d+)\.status:(all|0|1|2)$/.exec(kind)
  if (videoLibrary) {
    const libraryId = Number(videoLibrary[1])
    const status = videoLibrary[2] === 'all' ? 'all' : Number(videoLibrary[2])
    return listVideosForBatchScrape({
      libraryId,
      status: status as 0 | 1 | 2 | 'all'
    }).map((row) => row.id)
  }
  const videoStatus = /^videos\.status:(all|0|1|2)$/.exec(kind)
  if (videoStatus) {
    const status = videoStatus[1] === 'all' ? 'all' : Number(videoStatus[1])
    return listVideosForBatchScrape({ status: status as 0 | 1 | 2 | 'all' }).map((row) => row.id)
  }
  const actressStatus = /^actresses\.status:(all|unscraped|success|failed)$/.exec(kind)
  if (actressStatus) {
    return listActressesForBatchScrape({
      scope: 'all',
      scrapeStatus: actressStatus[1] as 'all' | 'unscraped' | 'success' | 'failed'
    }).map((row) => row.id)
  }
  throw structuredError(
    'INVALID_INPUT',
    '不支持的目标列表 kind；请使用命名查询，或提供 ids / videoFilter / actressFilter',
    { field: 'kind' }
  )
}

function evaluateVideoFilter(filter: VideoFilter): number[] {
  return listVideosForBatchScrape({
    libraryId: filter.libraryId,
    status: (filter.status ?? 'all') as 0 | 1 | 2 | 'all',
    missingFields: filter.missingFields as VideoScrapeField[] | undefined,
    sourceName: filter.sourceName,
    ratingSourceName: filter.ratingSourceName
  }).map((row) => row.id)
}

function evaluateActressFilter(filter: ActressFilter): number[] {
  return listActressesForBatchScrape({
    scope: filter.scope ?? 'all',
    scrapeStatus: filter.scrapeStatus ?? 'all',
    missingFields: filter.missingFields as ActressScrapeField[] | undefined
  }).map((row) => row.id)
}

function isActressKind(kind: string): boolean {
  return kind.startsWith('actresses')
}

function capturedRevisions(kind: string, ids: number[], database: Database.Database): number[] {
  const stmt = isActressKind(kind)
    ? database.prepare('SELECT revision FROM actresses WHERE id = ?')
    : database.prepare('SELECT revision FROM videos WHERE id = ?')
  return ids.map((id) => {
    const row = stmt.get(id) as { revision: number } | undefined
    return row?.revision ?? 1
  })
}

function capturedLabels(kind: string, ids: number[], database: Database.Database): Array<string | null> {
  const stmt = isActressKind(kind)
    ? database.prepare('SELECT main_name AS label FROM actresses WHERE id = ?')
    : database.prepare('SELECT code AS label FROM videos WHERE id = ?')
  return ids.map((id) => {
    const row = stmt.get(id) as { label: string } | undefined
    return row?.label ?? null
  })
}

function liveEntry(
  kind: string,
  id: number,
  database: Database.Database
): { label: string; revision: number } | null {
  const row = isActressKind(kind)
    ? (database
        .prepare('SELECT main_name AS label, revision FROM actresses WHERE id = ?')
        .get(id) as { label: string; revision: number } | undefined)
    : (database
        .prepare('SELECT code AS label, revision FROM videos WHERE id = ?')
        .get(id) as { label: string; revision: number } | undefined)
  return row ?? null
}

function selectorCount(input: TargetListCreateInput): number {
  return [input.ids, input.videoFilter, input.actressFilter].filter((value) => value != null).length
}

export function createCatalogTargetList(
  input: TargetListCreateInput,
  database: Database.Database = getDb()
): { targetListId: string; count: number } {
  if (selectorCount(input) > 1) {
    throw structuredError(
      'INVALID_INPUT',
      '目标列表不能同时使用 ids、videoFilter 和 actressFilter',
      { field: 'ids' }
    )
  }
  if (input.videoFilter && !input.kind.startsWith('videos')) {
    throw structuredError('INVALID_INPUT', 'videoFilter 只能用于 videos kind', { field: 'kind' })
  }
  if (input.actressFilter && !input.kind.startsWith('actresses')) {
    throw structuredError('INVALID_INPUT', 'actressFilter 只能用于 actresses kind', { field: 'kind' })
  }

  let ids: number[]
  let digest: string
  if (input.ids) {
    ids = input.ids
    digest = digestIds(input.kind, ids)
  } else if (input.videoFilter) {
    const videoFilter = compactTargetVideoFilter(input.videoFilter)
    ids = evaluateVideoFilter(videoFilter)
    digest = digestJson({ kind: input.kind, videoFilter })
  } else if (input.actressFilter) {
    const actressFilter = compactTargetActressFilter(input.actressFilter)
    ids = evaluateActressFilter(actressFilter)
    digest = digestJson({ kind: input.kind, actressFilter })
  } else {
    ids = evaluateKind(input.kind, database)
    digest = digestIds(input.kind, ids)
  }

  if (digest !== input.filterDigest) {
    throw structuredError(
      'VERSION_CONFLICT',
      '目标筛选结果已变化，请刷新后重新冻结',
      { field: 'filterDigest' }
    )
  }

  const id = randomUUID()
  const stored: StoredTargetList = {
    id,
    kind: input.kind,
    filterDigest: digest,
    ids,
    revisions: capturedRevisions(input.kind, ids, database),
    labels: capturedLabels(input.kind, ids, database),
    createdAt: new Date().toISOString()
  }
  writeCatalogSetting(settingKey(id), stored, database)
  return { targetListId: id, count: ids.length }
}

export function targetListFilterDigest(kind: string, database: Database.Database = getDb()): string {
  return digestIds(kind, evaluateKind(kind, database))
}

export function pageCatalogTargetList(
  input: { targetListId: string; limit?: number; offset?: number },
  database: Database.Database = getDb()
): TargetListPage {
  const stored = readCatalogSetting<StoredTargetList | null>(settingKey(input.targetListId), null, database)
  if (!stored) throw structuredError('INVALID_INPUT', '目标列表不存在', { field: 'targetListId' })
  const offset = input.offset ?? 0
  const limit = Math.min(input.limit ?? 50, 200)
  const ids = stored.ids.slice(offset, offset + limit)
  const entries: TargetListEntry[] = ids.map((id, index) => {
    const storedIndex = offset + index
    const live = liveEntry(stored.kind, id, database)
    return {
      id,
      present: live != null,
      label: live?.label ?? stored.labels?.[storedIndex] ?? null,
      revision: live?.revision ?? stored.revisions[storedIndex] ?? null
    }
  })
  return {
    targetListId: stored.id,
    ids,
    offset,
    hasMore: offset + ids.length < stored.ids.length,
    entries
  }
}
