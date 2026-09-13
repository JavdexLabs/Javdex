import path from 'node:path'
import type Database from 'better-sqlite3'
import type { RootMapping } from '@shared/protocol/migration'
import { structuredError } from '@shared/protocol/errors'
import { resolveMediaLibraryRootIdentity } from '@library/mediaLibraryRootPath'
import { buildVideoResourceSourceIdentity } from '@library/videoResourceIdentity'
import { validateMappings } from './catalogMigrationPreview'

const PRIMARY_KIND_ORDER: Record<string, number> = {
  local: 0,
  direct: 1,
  magnet: 2,
  ed2k: 3,
  web: 4
}

const EXPORT_DELETE_TABLES = [
  'catalog_one_time_tokens',
  'catalog_writer_credentials',
  'catalog_writer_claims',
  'pending_video_scrape_resources',
  'pending_video_scrape_candidates',
  'pending_video_scrape_sources',
  'pending_video_scrapes',
  'pending_actress_scrape_resources',
  'pending_actress_scrape_conflicts',
  'pending_actress_scrapes',
  'pending_actress_name_claims',
  'pending_scan_resources',
  'pending_scan_groups',
  'pending_resource_identities',
  'pending_local_file_deletions',
  'library_unrecognized_files',
  'library_scan_runs',
  'catalog_image_file_jobs',
  'catalog_image_uploads',
  'catalog_root_markers',
  'catalog_maintenance_plans',
  'catalog_operation_receipts',
  'library_root_cleanup_jobs',
  'agent_metadata_draft_resources',
  'agent_metadata_drafts',
  'agent_approvals',
  'agent_artifacts',
  'agent_tool_ledger',
  'agent_execution_history',
  'agent_product_journal',
  'agent_operations',
  'agent_resource_cleanup',
  'agent_runs'
]

const SETTINGS_DELETE_PREFIXES = ['play-grant:', 'play-token:', 'migration-']

export function stripExportSecrets(database: Database.Database): void {
  for (const table of EXPORT_DELETE_TABLES) {
    const exists = database
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) as { ok: number } | undefined
    if (!exists) continue
    database.exec(`DELETE FROM "${table}"`)
  }
  const rows = database.prepare('SELECT key FROM catalog_settings').all() as Array<{ key: string }>
  const del = database.prepare('DELETE FROM catalog_settings WHERE key = ?')
  for (const row of rows) {
    if (SETTINGS_DELETE_PREFIXES.some((prefix) => row.key.startsWith(prefix))) {
      del.run(row.key)
    }
  }
}

function sourcePathApi(platform: string): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

function relativizeLocator(locator: string, rootPath: string, platform: string): string | null {
  const api = sourcePathApi(platform)
  const relative = api.relative(api.normalize(rootPath), api.normalize(locator))
  if (!relative || relative.startsWith('..') || api.isAbsolute(relative)) return null
  return relative
}

function joinOnTarget(rootPath: string, relative: string, sourcePlatform: string): string {
  const api = sourcePathApi(sourcePlatform)
  const parts = relative.split(api.sep).filter((part) => part.length > 0 && part !== '.')
  if (parts.some((part) => part === '..')) {
    throw structuredError('INVALID_INPUT', '映射根下的本地资源无法按源平台重写路径')
  }
  return path.join(rootPath, ...parts)
}

function promotePrimary(database: Database.Database, libraryId: number, videoId: number): void {
  database
    .prepare('UPDATE video_resources SET is_primary = 0 WHERE library_id = ? AND video_id = ?')
    .run(libraryId, videoId)
  const remaining = database
    .prepare(
      `SELECT id, kind, add_time FROM video_resources
        WHERE library_id = ? AND video_id = ?`
    )
    .all(libraryId, videoId) as Array<{ id: number; kind: string; add_time: string }>
  remaining.sort((left, right) => {
    const kindDelta =
      (PRIMARY_KIND_ORDER[left.kind] ?? 9) - (PRIMARY_KIND_ORDER[right.kind] ?? 9)
    if (kindDelta !== 0) return kindDelta
    if (left.add_time !== right.add_time) return left.add_time < right.add_time ? -1 : 1
    return left.id - right.id
  })
  const next = remaining[0]
  if (next) {
    database.prepare('UPDATE video_resources SET is_primary = 1 WHERE id = ?').run(next.id)
  }
}

export function applyMigrationTransforms(
  database: Database.Database,
  mappings: RootMapping[],
  mounts: Readonly<Record<string, string>>,
  sourcePlatform: string,
  autoCleanupDisabledLibraryIds: number[]
): void {
  const roots = database
    .prepare(
      `SELECT r.id, r.library_id, r.path, l.name
         FROM media_library_roots r
         JOIN media_libraries l ON l.id = r.library_id`
    )
    .all() as Array<{ id: number; library_id: number; path: string; name: string }>
  const { mapped, errors } = validateMappings(mappings, roots)
  if (errors.length > 0) {
    throw structuredError('INVALID_INPUT', '根映射无效，不能降级为不映射', { field: 'mappings' })
  }
  for (const mapping of mappings) {
    if (!mounts[mapping.targetMountSelectionId]) {
      throw structuredError('INVALID_INPUT', '目标挂载不存在，不能降级为不映射', {
        field: 'targetMountSelectionId'
      })
    }
  }
  const omittedIds = roots.filter((root) => !mapped.has(root.id)).map((root) => root.id)
  const omitted = new Set(omittedIds)

  const resources = database
    .prepare(
      `SELECT id, library_id, video_id, root_id, kind, locator, strm_source_path
         FROM video_resources`
    )
    .all() as Array<{
    id: number
    library_id: number
    video_id: number
    root_id: number | null
    kind: string
    locator: string
    strm_source_path: string | null
  }>

  const touched = new Set<string>()
  const convert = database.prepare(
    `UPDATE video_resources
        SET strm_source_path = NULL, source_identity = NULL, root_id = NULL
      WHERE id = ?`
  )
  const detachRoot = database.prepare('UPDATE video_resources SET root_id = NULL WHERE id = ?')
  const removeLocal = database.prepare('DELETE FROM video_resources WHERE id = ? AND kind = ?')

  for (const resource of resources) {
    const unmapped = resource.root_id == null || omitted.has(resource.root_id)
    if (!unmapped) continue
    const member = `${resource.library_id}:${resource.video_id}`
    if (resource.kind === 'local') {
      removeLocal.run(resource.id, 'local')
      touched.add(member)
      continue
    }
    if (resource.strm_source_path) {
      convert.run(resource.id)
      touched.add(member)
      continue
    }
    if (resource.root_id != null) detachRoot.run(resource.id)
  }

  for (const member of touched) {
    const [libraryId, videoId] = member.split(':').map(Number)
    promotePrimary(database, libraryId, videoId)
  }

  for (const root of roots) {
    if (!omitted.has(root.id)) continue
    database.prepare('DELETE FROM media_library_roots WHERE id = ?').run(root.id)
  }

  const usedNormalized = new Set<string>()
  for (const root of roots) {
    const mountId = mapped.get(root.id)
    if (!mountId) continue
    const mountPath = mounts[mountId]
    const identity = resolveMediaLibraryRootIdentity(mountPath)
    if (!identity.normalizedPath || usedNormalized.has(identity.normalizedPath)) {
      throw structuredError('IDENTITY_CONFLICT', '目标挂载路径大小写或别名冲突')
    }
    usedNormalized.add(identity.normalizedPath)
    const locals = database
      .prepare(
        `SELECT id, locator FROM video_resources WHERE root_id = ? AND kind = 'local'`
      )
      .all(root.id) as Array<{ id: number; locator: string }>
    for (const local of locals) {
      const relative = relativizeLocator(local.locator, root.path, sourcePlatform)
      if (relative == null) {
        throw structuredError('INVALID_INPUT', '映射根下的本地资源无法按源平台重写路径')
      }
      const nextLocator = joinOnTarget(identity.path, relative, sourcePlatform)
      const sourceIdentity = buildVideoResourceSourceIdentity({
        kind: 'local',
        locator: nextLocator
      })
      database
        .prepare(
          'UPDATE video_resources SET locator = ?, source_identity = ?, resource_key = ? WHERE id = ?'
        )
        .run(nextLocator, sourceIdentity, sourceIdentity, local.id)
    }
    const strms = database
      .prepare(
        `SELECT id, strm_source_path FROM video_resources
          WHERE root_id = ? AND strm_source_path IS NOT NULL`
      )
      .all(root.id) as Array<{ id: number; strm_source_path: string }>
    for (const strm of strms) {
      const relative = relativizeLocator(strm.strm_source_path, root.path, sourcePlatform)
      if (relative == null) {
        throw structuredError('INVALID_INPUT', '映射根下的 STRM 源路径无法按源平台重写')
      }
      const nextPath = joinOnTarget(identity.path, relative, sourcePlatform)
      const sourceIdentity = buildVideoResourceSourceIdentity({
        kind: 'direct',
        locator: nextPath,
        strmSourcePath: nextPath
      })
      database
        .prepare(
          `UPDATE video_resources
              SET strm_source_path = ?, source_identity = ?, resource_key = ?
            WHERE id = ?`
        )
        .run(nextPath, sourceIdentity, sourceIdentity, strm.id)
    }
    database
      .prepare(
        `UPDATE media_library_roots
            SET path = ?, normalized_path = ?, real_path = ?, normalized_real_path = ?,
                device_id = ?, inode = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(
        identity.path,
        identity.normalizedPath,
        identity.realPath,
        identity.normalizedRealPath,
        identity.deviceId,
        identity.inode,
        new Date().toISOString(),
        root.id
      )
  }

  const disable = database.prepare(
    `UPDATE media_library_configs
        SET remove_resource_less_memberships = 0, revision = revision + 1
      WHERE library_id = ? AND remove_resource_less_memberships = 1`
  )
  for (const libraryId of autoCleanupDisabledLibraryIds) disable.run(libraryId)
}
