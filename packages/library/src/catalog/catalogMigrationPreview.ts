import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { MigrationPreview, RootMapping } from '@shared/protocol/migration'
import { CURRENT_SCHEMA_VERSION } from '@library/db/migrations'
import { MANAGE_PROTOCOL_VERSION } from '@shared/protocol/identity'
import { structuredError } from '@shared/protocol/errors'
import { digestRequest } from './catalogSecrets'
import { readCatalogIdentity } from './catalogIdentity'
import { countPendingBlockers } from './catalogMigrationState'

interface ResourceRow {
  id: number
  library_id: number
  video_id: number
  root_id: number | null
  kind: 'local' | 'direct' | 'web' | 'magnet' | 'ed2k'
  locator: string
  strm_source_path: string | null
}

interface RootRow {
  id: number
  library_id: number
  name: string
  path: string
}

export interface MigrationPreviewOptions {
  appVersion: string
  encryptedAssetCount?: number
  migrationId?: string
}

export function validateMappings(
  mappings: RootMapping[],
  roots: RootRow[]
): { mapped: Map<number, string>; errors: string[] } {
  const mapped = new Map<number, string>()
  const errors: string[] = []
  const rootIds = new Set(roots.map((root) => root.id))
  const usedTargets = new Set<string>()
  for (const mapping of mappings) {
    if (!rootIds.has(mapping.sourceRootId)) {
      errors.push(`unknown-root:${mapping.sourceRootId}`)
      continue
    }
    if (mapped.has(mapping.sourceRootId)) {
      errors.push(`duplicate-source-root:${mapping.sourceRootId}`)
      continue
    }
    if (usedTargets.has(mapping.targetMountSelectionId)) {
      errors.push(`duplicate-target-mount:${mapping.targetMountSelectionId}`)
      continue
    }
    mapped.set(mapping.sourceRootId, mapping.targetMountSelectionId)
    usedTargets.add(mapping.targetMountSelectionId)
  }
  return { mapped, errors }
}

export function computeMigrationPreview(
  mappings: RootMapping[],
  options: MigrationPreviewOptions,
  database: Database.Database
): MigrationPreview {
  const identity = readCatalogIdentity(database)
  if (!identity) {
    throw structuredError('INSTANCE_MISMATCH', '资料库身份尚未初始化')
  }
  const roots = database
    .prepare(
      `SELECT r.id, r.library_id, r.path, l.name
         FROM media_library_roots r
         JOIN media_libraries l ON l.id = r.library_id`
    )
    .all() as RootRow[]
  const { mapped, errors } = validateMappings(mappings, roots)
  if (errors.length > 0) {
    throw structuredError('INVALID_INPUT', '根映射无效，不能降级为不映射', {
      field: 'mappings'
    })
  }
  const omittedRoots = roots
    .filter((root) => !mapped.has(root.id))
    .map((root) => ({ rootId: root.id, name: root.name }))
  const omittedIds = new Set(omittedRoots.map((root) => root.rootId))
  const resources = database
    .prepare(
      `SELECT id, library_id, video_id, root_id, kind, locator, strm_source_path
         FROM video_resources`
    )
    .all() as ResourceRow[]

  let localResourceRemovals = 0
  let strmConversions = 0
  const strmKeys = new Map<string, number[]>()
  const remainingByMember = new Map<string, number>()
  const beforeByMember = new Map<string, number>()

  const memberKey = (libraryId: number, videoId: number): string => `${libraryId}:${videoId}`
  for (const resource of resources) {
    const key = memberKey(resource.library_id, resource.video_id)
    beforeByMember.set(key, (beforeByMember.get(key) ?? 0) + 1)
    remainingByMember.set(key, (remainingByMember.get(key) ?? 0) + 1)
  }

  for (const resource of resources) {
    const unmapped = resource.root_id == null || omittedIds.has(resource.root_id)
    if (!unmapped) continue
    if (resource.kind === 'local') {
      localResourceRemovals += 1
      const key = memberKey(resource.library_id, resource.video_id)
      remainingByMember.set(key, (remainingByMember.get(key) ?? 1) - 1)
      continue
    }
    if (resource.strm_source_path) {
      strmConversions += 1
      const conflictKey = `${resource.library_id}|${resource.kind}|${resource.locator}`
      const list = strmKeys.get(conflictKey) ?? []
      list.push(resource.id)
      strmKeys.set(conflictKey, list)
    }
  }

  const ordinary = database
    .prepare(
      `SELECT library_id, kind, locator, id FROM video_resources
        WHERE kind != 'local' AND strm_source_path IS NULL`
    )
    .all() as Array<{ library_id: number; kind: string; locator: string; id: number }>
  const strmConflicts: Array<{ libraryId: number; resourceIds: number[] }> = []
  for (const [key, ids] of strmKeys) {
    const [libraryId, kind, locator] = key.split('|')
    const existing = ordinary.filter(
      (row) => row.library_id === Number(libraryId) && row.kind === kind && row.locator === locator
    )
    if (ids.length + existing.length > 1) {
      strmConflicts.push({
        libraryId: Number(libraryId),
        resourceIds: [...ids, ...existing.map((row) => row.id)]
      })
    }
  }

  const affectedLibraryIds = new Set<number>()
  for (const [key, remaining] of remainingByMember) {
    const before = beforeByMember.get(key) ?? 0
    if (before > 0 && remaining <= 0) {
      affectedLibraryIds.add(Number(key.split(':')[0]))
    }
  }
  const autoCleanupDisabledLibraryIds: number[] = []
  for (const libraryId of affectedLibraryIds) {
    const config = database
      .prepare(
        'SELECT remove_resource_less_memberships AS flag FROM media_library_configs WHERE library_id = ?'
      )
      .get(libraryId) as { flag: number } | undefined
    if (config?.flag === 1) autoCleanupDisabledLibraryIds.push(libraryId)
  }
  autoCleanupDisabledLibraryIds.sort((a, b) => a - b)

  const pendingBlockers = countPendingBlockers(database)

  const previewBase = {
    sourceServerId: identity.serverId,
    sourceCatalogId: identity.catalogId,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: options.appVersion,
    localResourceRemovals,
    strmConversions,
    strmConflicts,
    omittedRoots,
    autoCleanupDisabledLibraryIds,
    pendingBlockers,
    mappings,
    protocolVersion: MANAGE_PROTOCOL_VERSION
  }
  const digest = digestRequest(previewBase)
  return {
    migrationId: options.migrationId ?? randomUUID(),
    sourceServerId: identity.serverId,
    sourceCatalogId: identity.catalogId,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: options.appVersion,
    localResourceRemovals,
    strmConversions,
    strmConflicts,
    omittedRoots,
    autoCleanupDisabledLibraryIds,
    pendingBlockers,
    digest
  }
}
