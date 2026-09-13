import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { listVideosForBatchScrape } from '@library/db/videoRepo'
import { listActressesForBatchScrape } from '@library/db/actressRepo'
import { readCatalogSetting, writeCatalogSetting } from '@library/catalog/catalogSettings'
import type { TargetListPage } from '@shared/protocol/tasks'

const LIST_KEY_PREFIX = 'target-list:'

export interface StoredTargetList {
  id: string
  kind: string
  filterDigest: string
  ids: number[]
  revisions: number[]
  createdAt: string
}

function settingKey(targetListId: string): string {
  return `${LIST_KEY_PREFIX}${targetListId}`
}

function digestIds(kind: string, ids: number[]): string {
  return createHash('sha256').update(JSON.stringify({ kind, ids })).digest('hex')
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
    '不支持的目标列表 kind；冻结 create 不含筛选参数，仅接受命名查询',
    { field: 'kind' }
  )
}

function capturedRevisions(kind: string, ids: number[], database: Database.Database): number[] {
  if (kind.startsWith('actresses.')) {
    const stmt = database.prepare('SELECT revision FROM actresses WHERE id = ?')
    return ids.map((id) => {
      const row = stmt.get(id) as { revision: number } | undefined
      return row?.revision ?? 1
    })
  }
  const stmt = database.prepare('SELECT revision FROM videos WHERE id = ?')
  return ids.map((id) => {
    const row = stmt.get(id) as { revision: number } | undefined
    return row?.revision ?? 1
  })
}

export function createCatalogTargetList(
  input: { kind: string; filterDigest: string },
  database: Database.Database = getDb()
): { targetListId: string; count: number } {
  const ids = evaluateKind(input.kind, database)
  const digest = digestIds(input.kind, ids)
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
  return {
    targetListId: stored.id,
    ids,
    offset,
    hasMore: offset + ids.length < stored.ids.length
  }
}
