import type Database from 'better-sqlite3'
import type { TagLabel, TagListItem, TagOptionsPage, TagFilterOptionsPage, TagOptionsQuery } from '@shared/commonTypes'
import { getDatabaseReadRevision, getDb } from '@library/db/database'
import { getTagLabels, listTagFilterOptions, normalizeTagOptionsQuery, listManualTagOptions, listManualTags, listTags } from '@library/db/tagRepo'

export interface TagQueryService {
  list(): TagListItem[]
  listManual(): TagListItem[]
  labels(ids: number[]): TagLabel[]
  filterOptions(query: TagOptionsQuery): TagFilterOptionsPage
  manualOptions(query: TagOptionsQuery): TagOptionsPage
}

/** A private cache bound to the supplied connection provider; safe for independent workers. */
export function createTagFilterOptionsReader(getConnection: () => Database.Database = getDb): (query: TagOptionsQuery) => TagFilterOptionsPage {
  // Keep at most eight pages and 512KiB of UTF-8 serialized keys/results.
  // JS strings may use more heap than their UTF-8 encoding; this is not a total RSS budget.
  const pageCache = new Map<string, { json: string; bytes: number }>()
  let cachedBytes = 0
  let revision: (ReturnType<typeof getDatabaseReadRevision> & { schemaVersion: number }) | undefined
  function readRevision(connection: Database.Database) {
    return { ...getDatabaseReadRevision(connection), schemaVersion: connection.pragma('schema_version', { simple: true }) as number }
  }
  function sameRevision(a: typeof revision, b: NonNullable<typeof revision>): boolean {
    return a?.connection === b.connection && a.changes === b.changes
      && a.dataVersion === b.dataVersion && a.schemaVersion === b.schemaVersion
  }
  return function filterOptions(query: TagOptionsQuery): TagFilterOptionsPage {
    const normalized = normalizeTagOptionsQuery(query)
    const connection = getConnection()
    // Reads inside another transaction must use its snapshot and must never
    // publish uncommitted data (including reads followed by rollback).
    if (connection.inTransaction) return listTagFilterOptions(query, connection)
    const before = readRevision(connection)
    if (!sameRevision(revision, before)) {
      pageCache.clear(); cachedBytes = 0; revision = before
    }
    const key = JSON.stringify(normalized)
    const cached = pageCache.get(key)
    if (cached) {
      pageCache.delete(key); pageCache.set(key, cached)
      return JSON.parse(cached.json) as TagFilterOptionsPage
    }
    const result = listTagFilterOptions(query, connection)
    if (!sameRevision(before, readRevision(connection))) return result
    // Store a serialization rather than caller-owned mutable arrays/objects.
    const json = JSON.stringify(result)
    const bytes = Buffer.byteLength(json) + Buffer.byteLength(key)
    if (bytes > 512 * 1024) return result
    while (pageCache.size >= 8 || cachedBytes + bytes > 512 * 1024) {
      const oldest = pageCache.keys().next().value as string
      cachedBytes -= pageCache.get(oldest)!.bytes
      pageCache.delete(oldest)
    }
    pageCache.set(key, { json, bytes }); cachedBytes += bytes
    return result
  }

}

export const tagQueryService: TagQueryService = {
  list: listTags,
  listManual: listManualTags,
  labels: getTagLabels,
  filterOptions: createTagFilterOptionsReader(),
  manualOptions: listManualTagOptions
}
