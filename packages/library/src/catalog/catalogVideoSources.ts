import type Database from 'better-sqlite3'
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '@shared/protocol/limits'
import { structuredError } from '@shared/protocol/errors'
import { normalizeVideoCode } from '@shared/videoCode'
import { normalizeRelatedLinkUrl } from '@shared/relatedLinkUrl'
import { getDb } from '@library/db/database'

export interface CatalogVideoSourceQuery {
  source?: string
  externalCode?: string
  url?: string
  videoIds?: number[]
  codes?: string[]
  limit?: number
  offset?: number
}

export interface CatalogVideoSourceEntry {
  source: string
  externalCode: string | null
  url: string | null
}

export interface CatalogVideoSourceItem {
  videoId: number
  code: string
  sources: CatalogVideoSourceEntry[]
}

export interface CatalogVideoSourcePage {
  items: CatalogVideoSourceItem[]
  total: number
  limit: number
  offset: number
}

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids)].sort((left, right) => left - right)
}

function pageBounds(query: CatalogVideoSourceQuery): { limit: number; offset: number } {
  const limit = query.limit ?? PAGE_SIZE_DEFAULT
  const offset = query.offset ?? 0
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > PAGE_SIZE_MAX ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw structuredError('INVALID_INPUT', '来源分页参数无效')
  }
  return { limit, offset }
}

function loadSources(
  database: Database.Database,
  videoIds: number[]
): Map<number, CatalogVideoSourceEntry[]> {
  const sources = new Map<number, CatalogVideoSourceEntry[]>()
  if (videoIds.length === 0) return sources
  const rows = database
    .prepare(
      `SELECT video_id, source, external_code, url
         FROM video_sources
        WHERE video_id IN (${videoIds.map(() => '?').join(',')})
        ORDER BY video_id, source, external_code, url`
    )
    .all(...videoIds) as Array<{
    video_id: number
    source: string
    external_code: string | null
    url: string | null
  }>
  for (const row of rows) {
    const list = sources.get(row.video_id) ?? []
    list.push({
      source: row.source,
      externalCode: row.external_code,
      url: row.url
    })
    sources.set(row.video_id, list)
  }
  return sources
}

function matchingVideoIds(query: CatalogVideoSourceQuery, database: Database.Database): number[] {
  if (query.videoIds?.length) {
    const ids = uniqueIds(query.videoIds)
    return (
      database
        .prepare(`SELECT id FROM videos WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
        .all(...ids) as Array<{ id: number }>
    ).map((row) => row.id)
  }
  if (query.codes?.length) {
    const wanted = new Set(
      [...new Set(query.codes.map((code) => normalizeVideoCode(code)))]
    )
    const rows = database
      .prepare(
        `SELECT id, code FROM videos
          WHERE upper(trim(code)) IN (${[...wanted].map(() => '?').join(',')})
          ORDER BY id`
      )
      .all(...wanted) as Array<{ id: number; code: string }>
    return rows
      .filter((row) => {
        try {
          return wanted.has(normalizeVideoCode(row.code))
        } catch {
          return false
        }
      })
      .map((row) => row.id)
  }
  const source = query.source?.trim()
  if (!source) {
    throw structuredError(
      'INVALID_INPUT',
      'videos.sources requires codes, videoIds, or source plus externalCode/url'
    )
  }
  if (query.externalCode?.trim()) {
    return (
      database
        .prepare(
          `SELECT DISTINCT video_id FROM video_sources
            WHERE lower(trim(source)) = lower(trim(?))
              AND upper(trim(external_code)) = upper(trim(?))
            ORDER BY video_id`
        )
        .all(source, query.externalCode) as Array<{ video_id: number }>
    ).map((row) => row.video_id)
  }
  if (query.url?.trim()) {
    let normalized: string
    try {
      normalized = normalizeRelatedLinkUrl(query.url)
    } catch {
      throw structuredError('INVALID_INPUT', '来源 URL 无效')
    }
    return (
      database
        .prepare(
          `SELECT video_id, url FROM video_sources
            WHERE lower(trim(source)) = lower(trim(?)) AND url IS NOT NULL
            ORDER BY video_id`
        )
        .all(source) as Array<{ video_id: number; url: string }>
    )
      .filter((row) => {
        try {
          return normalizeRelatedLinkUrl(row.url) === normalized
        } catch {
          return false
        }
      })
      .map((row) => row.video_id)
  }
  throw structuredError(
    'INVALID_INPUT',
    'videos.sources requires codes, videoIds, or source plus externalCode/url'
  )
}

/** Restricted unique-video lookup of video_sources. Empty items mean no match, not a query failure. */
export function listCatalogVideoSources(
  query: CatalogVideoSourceQuery,
  database: Database.Database = getDb()
): CatalogVideoSourcePage {
  const { limit, offset } = pageBounds(query)
  const ids = matchingVideoIds(query, database)
  const total = ids.length
  const pageIds = ids.slice(offset, offset + limit)
  if (pageIds.length === 0) {
    return { items: [], total, limit, offset }
  }
  const codes = new Map(
    (
      database
        .prepare(
          `SELECT id, code FROM videos WHERE id IN (${pageIds.map(() => '?').join(',')})`
        )
        .all(...pageIds) as Array<{ id: number; code: string }>
    ).map((row) => [row.id, row.code])
  )
  const sources = loadSources(database, pageIds)
  return {
    items: pageIds.map((videoId) => ({
      videoId,
      code: codes.get(videoId) ?? '',
      sources: sources.get(videoId) ?? []
    })),
    total,
    limit,
    offset
  }
}
