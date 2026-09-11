import type Database from 'better-sqlite3'
import type {
  GlobalSearchInput,
  GlobalSearchResult,
  HomeDiscoveryInput,
  HomeMediaLibraryStatus,
  HomeMediaLibraryScanStatus,
  HomeSnapshot
} from '@shared/catalogTypes'
import type { MediaLibrarySummary } from '@shared/mediaLibraryTypes'
import { getDb } from './database'
import { createRevisionReadCache, type ReadCacheMemo } from './revisionReadCache'
import { listMediaLibraries } from './mediaLibraryRepo'
import {
  createScopedVideoCatalogRepo,
  type ScopedVideoCatalogRepo
} from './scopedVideoCatalogRepo'

export interface HomeDiscoveryRepo {
  load(input: HomeDiscoveryInput): HomeSnapshot
  search(input: GlobalSearchInput): GlobalSearchResult
}

interface HomeDiscoveryDependencies {
  database: Database.Database
  catalog: ScopedVideoCatalogRepo
  listLibraries: () => MediaLibrarySummary[]
}

interface HomeMediaLibraryStatusRow {
  library_id: number
  membership_count: number
  resource_count: number
  pending_scan_group_count: number
  pending_scan_resource_count: number
  unrecognized_file_count: number
  last_scan_status: HomeMediaLibraryScanStatus | null
  last_scan_started_at: string | null
  last_scan_finished_at: string | null
  last_successful_scan_at: string | null
  last_scan_summary_json: string | null
}

function normalizedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(60, Math.trunc(value)))
}

function normalizedFilterIds(values: number[] | undefined): number[] {
  if (!values || values.length === 0) return []
  const ids = Array.from(new Set(values))
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('媒体库 ID 必须是正整数')
  }
  return ids.sort((left, right) => left - right)
}

function offlineRootCountFromLatestScan(
  libraryId: number,
  summaryJson: string | null | undefined
): number | null {
  if (!summaryJson) return null
  try {
    const summary = JSON.parse(summaryJson) as unknown
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null
    const candidate = summary as Record<string, unknown>
    if (candidate.libraryId !== libraryId || !Array.isArray(candidate.offlineFolders)) return null
    return new Set(
      candidate.offlineFolders.filter((folder): folder is string => typeof folder === 'string')
    ).size
  } catch {
    return null
  }
}

function enrichLibraryStatuses(
  database: Database.Database,
  libraries: MediaLibrarySummary[]
): HomeMediaLibraryStatus[] {
  if (libraries.length === 0) return []
  const libraryIds = libraries.map((library) => library.id)
  const ids = libraryIds.join(',')
  const rows = database
    .prepare(
      `WITH membership_counts AS (
         SELECT library_id, COUNT(*) AS membership_count
         FROM library_video_memberships
         WHERE library_id IN (${ids})
         GROUP BY library_id
       ), resource_counts AS (
         SELECT library_id, COUNT(*) AS resource_count
         FROM video_resources
         WHERE library_id IN (${ids})
         GROUP BY library_id
       ), pending_group_counts AS (
         SELECT library_id, COUNT(*) AS pending_scan_group_count FROM (
           SELECT library_id FROM pending_scan_groups WHERE library_id IN (${ids})
           UNION ALL
           SELECT library_id FROM pending_resource_identities WHERE library_id IN (${ids})
         )
         GROUP BY library_id
       ), pending_resource_counts AS (
         SELECT library_id, COUNT(*) AS pending_scan_resource_count FROM (
           SELECT library_id FROM pending_scan_resources WHERE library_id IN (${ids})
           UNION ALL
           SELECT library_id FROM pending_resource_identities WHERE library_id IN (${ids})
         )
         GROUP BY library_id
       ), unrecognized_counts AS (
         SELECT library_id, COUNT(*) AS unrecognized_file_count
         FROM library_unrecognized_files
         WHERE library_id IN (${ids})
         GROUP BY library_id
       )
       SELECT
         library.id AS library_id,
         COALESCE(membership.membership_count, 0) AS membership_count,
         COALESCE(resource.resource_count, 0) AS resource_count,
         COALESCE(pending_group.pending_scan_group_count, 0) AS pending_scan_group_count,
         COALESCE(pending_resource.pending_scan_resource_count, 0)
           AS pending_scan_resource_count,
         COALESCE(unrecognized.unrecognized_file_count, 0) AS unrecognized_file_count,
         scan_state.last_status AS last_scan_status,
         scan_state.last_started_at AS last_scan_started_at,
         scan_state.last_finished_at AS last_scan_finished_at,
         scan_state.last_successful_at AS last_successful_scan_at,
         scan_state.last_summary_json AS last_scan_summary_json
       FROM media_libraries library
       LEFT JOIN membership_counts membership ON membership.library_id = library.id
       LEFT JOIN resource_counts resource ON resource.library_id = library.id
       LEFT JOIN pending_group_counts pending_group ON pending_group.library_id = library.id
       LEFT JOIN pending_resource_counts pending_resource
         ON pending_resource.library_id = library.id
       LEFT JOIN unrecognized_counts unrecognized ON unrecognized.library_id = library.id
       LEFT JOIN media_library_scan_state scan_state ON scan_state.library_id = library.id
       WHERE library.id IN (${ids})`
    )
    .all() as HomeMediaLibraryStatusRow[]
  const statusByLibraryId = new Map(rows.map((row) => [row.library_id, row]))

  return libraries.map((library) => {
    const status = statusByLibraryId.get(library.id)
    return {
      ...library,
      membershipCount: status?.membership_count ?? 0,
      resourceCount: status?.resource_count ?? 0,
      pendingScanGroupCount: status?.pending_scan_group_count ?? 0,
      pendingScanResourceCount: status?.pending_scan_resource_count ?? 0,
      unrecognizedFileCount: status?.unrecognized_file_count ?? 0,
      lastScanStatus: status?.last_scan_status ?? null,
      lastScanStartedAt: status?.last_scan_started_at ?? null,
      lastScanFinishedAt: status?.last_scan_finished_at ?? null,
      lastSuccessfulScanAt: status?.last_successful_scan_at ?? null,
      lastScanOfflineRootCount: offlineRootCountFromLatestScan(
        library.id,
        status?.last_scan_summary_json
      )
    }
  })
}

/** Stable 31-bit FNV-1a cursor; fetching does not mutate the caller's seed. */
export function discoveryCursorForSeed(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 1
}

function eligibleDiscoveryLibraryIds(
  database: Database.Database,
  selectedIds: number[]
): number[] {
  const selected = selectedIds.length > 0 ? ` AND library.id IN (${selectedIds.join(',')})` : ''
  return (
    database
      .prepare(
        `SELECT library.id
         FROM media_libraries library
         JOIN media_library_configs config ON config.library_id = library.id
         WHERE library.status = 'active'
           AND config.include_in_home_discovery = 1${selected}
         ORDER BY library.position, library.id`
      )
      .all() as Array<{ id: number }>
  ).map((row) => row.id)
}

interface DiscoveryVideoSelection {
  videoId: number
  libraryId: number
  discoveryKey: number
}

function discoveryVideoSelections(
  database: Database.Database,
  libraryIds: number[],
  cursor: number,
  limit: number
): DiscoveryVideoSelection[] {
  if (libraryIds.length === 0 || limit <= 0) return []
  const ids = libraryIds.join(',')
  const eligibleResource = (member: string): string => `EXISTS (
    SELECT 1 FROM video_resources resource
    LEFT JOIN media_library_roots resource_root
      ON resource_root.id = resource.root_id
     AND resource_root.library_id = resource.library_id
    WHERE resource.library_id = ${member}.library_id
      AND resource.video_id = ${member}.video_id
      AND ((resource.root_id IS NULL AND resource.source_identity IS NULL)
        OR (resource.root_id IS NOT NULL AND resource.source_identity IS NOT NULL
          AND resource_root.state = 'active'))
  )`
  const selectRange = (
    operator: '>=' | '<',
    rangeLimit: number
  ): DiscoveryVideoSelection[] => {
    const result: DiscoveryVideoSelection[] = []
    // Each video has one canonical eligible membership. The global first N therefore
    // belongs to the union of each library's first N; no full-catalog ranking is needed.
    // Bound compound SELECT size independently of the number of configured libraries.
    for (let offset = 0; offset < libraryIds.length; offset += 64) {
      const branches = libraryIds.slice(offset, offset + 64).map(libraryId => `
        SELECT * FROM (
          SELECT membership.video_id, membership.library_id, membership.discovery_key
          FROM library_video_memberships membership
          WHERE membership.library_id = ${libraryId} AND membership.is_hidden = 0
            AND membership.discovery_key ${operator} ${cursor}
            AND ${eligibleResource('membership')}
            ${libraryIds.length === 1 ? '' : `AND NOT EXISTS (
              SELECT 1 FROM library_video_memberships better
              WHERE better.video_id = membership.video_id
                AND better.library_id IN (${ids}) AND better.is_hidden = 0
                AND (better.discovery_key < membership.discovery_key
                  OR (better.discovery_key = membership.discovery_key
                    AND better.library_id < membership.library_id))
                AND ${eligibleResource('better')}
            )`}
          ORDER BY membership.discovery_key ASC, membership.video_id ASC
          LIMIT ${rangeLimit}
        )`)
      const rows = database.prepare(`WITH candidate AS (${branches.join(' UNION ALL ')})
        SELECT video_id, library_id, discovery_key FROM candidate
        ORDER BY discovery_key ASC, video_id ASC LIMIT ?`
      ).all(rangeLimit) as Array<{ video_id: number; library_id: number; discovery_key: number }>
      for (const row of rows) result.push({
        videoId: row.video_id, libraryId: row.library_id, discoveryKey: row.discovery_key
      })
      result.sort((left, right) => left.discoveryKey - right.discoveryKey || left.videoId - right.videoId)
      if (result.length > rangeLimit) result.length = rangeLimit
    }
    return result
  }

  const first = selectRange('>=', limit)
  if (first.length >= limit) return first
  return [...first, ...selectRange('<', limit - first.length)]
}

const connectedHomeRepos = new WeakMap<Database.Database, HomeDiscoveryRepo>()

export function createHomeDiscoveryRepo(
  dependencies: Partial<HomeDiscoveryDependencies> = {}
): HomeDiscoveryRepo {
  const database = dependencies.database ?? getDb()
  // Injected non-DB readers may change independently of the connection revision.
  const native = !dependencies.catalog && !dependencies.listLibraries
  const existing = native ? connectedHomeRepos.get(database) : undefined
  if (existing) return existing
  const cache = native ? createRevisionReadCache(database, {
    home: { maxEntries: 2, maxBytes: 1024 * 1024 },
    libraries: { maxEntries: 1, maxBytes: 512 * 1024 }
  }) : undefined
  const catalog = dependencies.catalog ?? createScopedVideoCatalogRepo(database)
  const readLibraries = dependencies.listLibraries ?? (() => listMediaLibraries({}, database))

  const repo: HomeDiscoveryRepo = {
    load(input) {
      const read = (memo: ReadCacheMemo): HomeSnapshot => {
        const seed = input.seed.trim() || 'default'
        const selectedIds = normalizedFilterIds(input.libraryIds)
        const key = JSON.stringify([seed, selectedIds, normalizedLimit(input.recentLimit, 12), normalizedLimit(input.discoveryLimit, 12)])
        return memo.get('home', key, () => {
          const eligibleLibraryIds = eligibleDiscoveryLibraryIds(database, selectedIds)
          const libraries = memo.get('libraries', 'active', () => enrichLibraryStatuses(database, readLibraries()))
          if (eligibleLibraryIds.length === 0) {
            return { seed, recent: [], discovery: [], libraries }
          }

          const scope = { kind: 'all' as const, libraryIds: eligibleLibraryIds }
          const recent = catalog.listPage(scope, {
            sortBy: 'add_time',
            sortDir: 'desc',
            limit: normalizedLimit(input.recentLimit, 12)
          })
          const candidates = discoveryVideoSelections(
            database,
            eligibleLibraryIds,
            discoveryCursorForSeed(seed),
            normalizedLimit(input.discoveryLimit, 12)
          )
          const discovery = catalog.listByLibrarySelections(candidates)
          return { seed, recent, discovery, libraries }
        })
      }
      return cache ? cache.read(read) : read({ get: (_bucket, _key, load) => load() })
    },

    search(input) {
      const { libraryIds, ...query } = input
      return catalog.list(
        { kind: 'all', libraryIds: normalizedFilterIds(libraryIds) },
        query
      )
    }
  }
  if (native) connectedHomeRepos.set(database, repo)
  return repo
}

export const homeDiscoveryRepo: HomeDiscoveryRepo = {
  load: (input) => createHomeDiscoveryRepo().load(input),
  search: (input) => createHomeDiscoveryRepo().search(input)
}
