import type {
  PendingScanGroup,
  PendingScanGroupResolution,
  PendingScanGroupResolutionResult,
  PendingScanResource
} from '@shared/libraryTypes'
import { normalizeLocalPathIdentity } from '@shared/localPathIdentity'
import { selectDefaultPendingScanPrimary } from '@shared/pendingScanPrimary'
import { normalizeVideoCode } from '@shared/videoCode'
import type { ExternalVideoResourceKind } from '@shared/videoTypes'
import { maskVideoResourceLocator } from '@shared/videoResourceLinks'
import { buildStrmResourceKey } from '@shared/strmResource'
import { readStrmFile } from '../scanner/strmParser'
import { getDb } from './database'

export interface PendingScanResourceInput {
  filePath: string
  scanRoot: string
  sourceKind?: 'local' | 'strm'
  targetKind?: ExternalVideoResourceKind | null
  targetLocator?: string | null
  targetKey?: string | null
  sizeBytes: number | null
  durationSeconds: number | null
  fileMtimeMs: number | null
  displayName?: string | null
}

function mapPendingResource(row: {
  id: number
  group_id: number
  file_path: string
  scan_root: string
  source_kind: 'local' | 'strm'
  target_kind: ExternalVideoResourceKind | null
  target_locator: string | null
  size_bytes: number | null
  duration_seconds: number | null
  file_mtime_ms: number | null
  display_name: string | null
}): PendingScanResource {
  return {
    id: row.id,
    groupId: row.group_id,
    filePath: row.file_path,
    scanRoot: row.scan_root,
    sourceKind: row.source_kind,
    targetKind: row.target_kind,
    targetDisplay:
      row.target_kind && row.target_locator
        ? maskVideoResourceLocator(row.target_locator, row.target_kind)
        : null,
    sizeBytes: row.size_bytes,
    durationSeconds: row.duration_seconds,
    fileMtimeMs: row.file_mtime_ms,
    displayName: row.display_name
  }
}

export function upsertPendingScanResources(
  code: string,
  inputs: PendingScanResourceInput[]
): { groupId: number; addedResources: number } {
  const db = getDb()
  const normalizedCode = normalizeVideoCode(code)
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO pending_scan_groups (normalized_code, created_at, updated_at)
       VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(normalized_code) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`
    ).run(normalizedCode)
    const group = db
      .prepare('SELECT id FROM pending_scan_groups WHERE normalized_code = ?')
      .get(normalizedCode) as { id: number }
    const upsert = db.prepare(
      `INSERT INTO pending_scan_resources (
         group_id, file_path, normalized_path, scan_root, source_kind,
         target_kind, target_locator, target_key, size_bytes,
         duration_seconds, file_mtime_ms, display_name, created_at, updated_at
       ) VALUES (
         @groupId, @filePath, @normalizedPath, @scanRoot, @sourceKind,
         @targetKind, @targetLocator, @targetKey, @sizeBytes,
         @durationSeconds, @fileMtimeMs, @displayName, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )
       ON CONFLICT(normalized_path) DO UPDATE SET
         group_id = excluded.group_id,
         file_path = excluded.file_path,
         scan_root = excluded.scan_root,
         source_kind = excluded.source_kind,
         target_kind = excluded.target_kind,
         target_locator = excluded.target_locator,
         target_key = excluded.target_key,
         size_bytes = excluded.size_bytes,
         duration_seconds = excluded.duration_seconds,
         file_mtime_ms = excluded.file_mtime_ms,
         display_name = excluded.display_name,
         updated_at = CURRENT_TIMESTAMP`
    )
    let addedResources = 0
    for (const input of inputs) {
      const normalizedPath = normalizeLocalPathIdentity(input.filePath)
      const existed = Boolean(
        db
          .prepare('SELECT 1 FROM pending_scan_resources WHERE normalized_path = ?')
          .get(normalizedPath)
      )
      upsert.run({
        groupId: group.id,
        filePath: input.filePath,
        normalizedPath,
        scanRoot: input.scanRoot,
        sourceKind: input.sourceKind ?? 'local',
        targetKind: input.targetKind ?? null,
        targetLocator: input.targetLocator ?? null,
        targetKey: input.targetKey ?? null,
        sizeBytes: input.sizeBytes,
        durationSeconds: input.durationSeconds,
        fileMtimeMs: input.fileMtimeMs,
        displayName: input.displayName ?? null
      })
      if (!existed) addedResources += 1
    }
    return { groupId: group.id, addedResources }
  })()
}

export function pendingScanResourceExists(filePath: string): boolean {
  return Boolean(
    getDb()
      .prepare('SELECT 1 FROM pending_scan_resources WHERE normalized_path = ?')
      .get(normalizeLocalPathIdentity(filePath))
  )
}

export function removePendingScanResource(filePath: string): boolean {
  const db = getDb()
  return db.transaction(() => {
    const resource = db
      .prepare('SELECT id, group_id FROM pending_scan_resources WHERE normalized_path = ?')
      .get(normalizeLocalPathIdentity(filePath)) as { id: number; group_id: number } | undefined
    if (!resource) return false
    db.prepare('DELETE FROM pending_scan_resources WHERE id = ?').run(resource.id)
    db.prepare(
      `DELETE FROM pending_scan_groups
       WHERE id = ? AND NOT EXISTS (
         SELECT 1 FROM pending_scan_resources WHERE group_id = pending_scan_groups.id
       )`
    ).run(resource.group_id)
    return true
  })()
}

export function listPendingScanGroups(): PendingScanGroup[] {
  const db = getDb()
  const groups = db
    .prepare(
      `SELECT id, normalized_code, created_at, updated_at
       FROM pending_scan_groups ORDER BY updated_at, id`
    )
    .all() as Array<{
    id: number
    normalized_code: string
    created_at: string
    updated_at: string
  }>
  const listResources = db.prepare(
    `SELECT id, group_id, file_path, scan_root, source_kind, target_kind,
            target_locator, size_bytes, duration_seconds, file_mtime_ms, display_name
     FROM pending_scan_resources WHERE group_id = ? ORDER BY normalized_path, id`
  )
  return groups.map((group) => ({
    id: group.id,
    normalizedCode: group.normalized_code,
    createdAt: group.created_at,
    updatedAt: group.updated_at,
    resources: (listResources.all(group.id) as Parameters<typeof mapPendingResource>[0][]).map(
      mapPendingResource
    )
  }))
}

export function reconcilePendingScanResources(
  accessibleRoots: string[],
  inspectPath: (filePath: string) => 'present' | 'missing' | 'unknown'
): { removedResources: number; removedGroups: number } {
  const db = getDb()
  return db.transaction(() => {
    const resources = db
      .prepare('SELECT id, file_path, scan_root FROM pending_scan_resources ORDER BY id')
      .all() as Array<{ id: number; file_path: string; scan_root: string }>
    let removedResources = 0
    for (const resource of resources) {
      if (!accessibleRoots.some(
        (root) => normalizeLocalPathIdentity(root) === normalizeLocalPathIdentity(resource.scan_root)
      )) {
        continue
      }
      if (inspectPath(resource.file_path) === 'missing') {
        removedResources += db.prepare('DELETE FROM pending_scan_resources WHERE id = ?').run(resource.id)
          .changes
      }
    }
    const removedGroups = db
      .prepare(
        `DELETE FROM pending_scan_groups
         WHERE NOT EXISTS (
           SELECT 1 FROM pending_scan_resources WHERE group_id = pending_scan_groups.id
         )`
      )
      .run().changes
    return { removedResources, removedGroups }
  })()
}

function refreshPendingStrmSnapshots(groupId: number): string | null {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, file_path, target_kind, target_key, target_locator
       FROM pending_scan_resources
       WHERE group_id = ? AND source_kind = 'strm'
       ORDER BY id`
    )
    .all(groupId) as Array<{
    id: number
    file_path: string
    target_kind: ExternalVideoResourceKind | null
    target_key: string | null
    target_locator: string | null
  }>
  if (rows.length === 0) return null

  const invalidIds: number[] = []
  const updates: Array<{
    id: number
    kind: ExternalVideoResourceKind
    locator: string
    targetKey: string
  }> = []
  let targetChanged = false
  for (const row of rows) {
    try {
      const current = readStrmFile(row.file_path)
      if (
        row.target_kind !== current.kind ||
        row.target_key !== current.targetKey ||
        row.target_locator !== current.locator
      ) {
        targetChanged = true
        updates.push({
          id: row.id,
          kind: current.kind,
          locator: current.locator,
          targetKey: current.targetKey
        })
      }
    } catch {
      invalidIds.push(row.id)
    }
  }

  if (invalidIds.length === 0 && updates.length === 0) return null
  db.transaction(() => {
    const update = db.prepare(
      `UPDATE pending_scan_resources
       SET target_kind = ?, target_locator = ?, target_key = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    for (const item of updates) {
      update.run(item.kind, item.locator, item.targetKey, item.id)
    }
    const remove = db.prepare('DELETE FROM pending_scan_resources WHERE id = ?')
    for (const id of invalidIds) remove.run(id)
    db.prepare(
      `DELETE FROM pending_scan_groups
       WHERE id = ? AND NOT EXISTS (
         SELECT 1 FROM pending_scan_resources WHERE group_id = pending_scan_groups.id
       )`
    ).run(groupId)
  })()

  if (invalidIds.length > 0) return '待确认 STRM 已失效或消失，待确认组已刷新'
  if (targetChanged) return '待确认 STRM 目标已变化，待确认组已刷新'
  return null
}

export function resolvePendingScanGroup(
  groupId: number,
  resolution: PendingScanGroupResolution,
  options?: { selectFallbackPrimaryResourceId?: (videoId: number) => number | null }
): PendingScanGroupResolutionResult {
  const db = getDb()
  const staleMessage = refreshPendingStrmSnapshots(groupId)
  if (staleMessage) throw new Error(staleMessage)
  return db.transaction(() => {
    const group = db
      .prepare('SELECT id, normalized_code FROM pending_scan_groups WHERE id = ?')
      .get(groupId) as { id: number; normalized_code: string } | undefined
    if (!group) throw new Error('待确认扫描组不存在')
    const resources = (
      db
        .prepare(
          `SELECT id, group_id, file_path, scan_root, source_kind, target_kind,
                  target_locator, size_bytes, duration_seconds, file_mtime_ms, display_name
           FROM pending_scan_resources WHERE group_id = ? ORDER BY id`
        )
        .all(groupId) as Parameters<typeof mapPendingResource>[0][]
    ).map(mapPendingResource)
    const expectedIds = new Set(resources.map((resource) => resource.id))
    const assignedIds = resolution.assignments.map((assignment) => assignment.resourceId)
    if (
      assignedIds.length !== resources.length ||
      new Set(assignedIds).size !== assignedIds.length ||
      assignedIds.some((id) => !expectedIds.has(id))
    ) {
      throw new Error('必须将待确认扫描组内每条资源恰好分配一次')
    }

    const assignmentsByTarget = new Map<string, typeof resolution.assignments>()
    for (const assignment of resolution.assignments) {
      const key =
        assignment.target.kind === 'existing'
          ? `existing:${assignment.target.videoId}`
          : `new:${assignment.target.groupKey.trim()}`
      if (assignment.target.kind === 'new' && !assignment.target.groupKey.trim()) {
        throw new Error('新影片分组标识不能为空')
      }
      const items = assignmentsByTarget.get(key)
      if (items) items.push(assignment)
      else assignmentsByTarget.set(key, [assignment])
    }

    const resourcesById = new Map(resources.map((resource) => [resource.id, resource]))
    const existingVideoIds: number[] = []
    const createdVideoIds: number[] = []
    const insertLocalResource = db.prepare(
      `INSERT INTO video_resources (
         video_id, kind, locator, resource_key, size_bytes, duration_seconds,
         file_mtime_ms, display_name, is_primary, add_time
       ) VALUES (?, 'local', ?, 'local:' || ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    )
    const insertStrmResource = db.prepare(
      `INSERT INTO video_resources (
         video_id, kind, locator, resource_key, strm_source_path, size_bytes,
         duration_seconds, file_mtime_ms, display_name, is_primary, add_time
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, CURRENT_TIMESTAMP)`
    )

    for (const assignments of assignmentsByTarget.values()) {
      const target = assignments[0].target
      let videoId: number
      let primaryResourceId: number | null = null
      if (target.kind === 'existing') {
        const video = db
          .prepare('SELECT id, code FROM videos WHERE id = ?')
          .get(target.videoId) as { id: number; code: string | null } | undefined
        if (!video || !video.code || normalizeVideoCode(video.code) !== group.normalized_code) {
          throw new Error('待确认资源只能分配给同番号现有影片')
        }
        videoId = video.id
        existingVideoIds.push(videoId)
        const existingPrimary = db
          .prepare('SELECT id FROM video_resources WHERE video_id = ? AND is_primary = 1 LIMIT 1')
          .get(videoId) as { id: number } | undefined
        primaryResourceId = existingPrimary?.id ?? null
      } else {
        videoId = Number(
          db
            .prepare('INSERT INTO videos (code, scraped_status) VALUES (?, 0)')
            .run(group.normalized_code).lastInsertRowid
        )
        createdVideoIds.push(videoId)
        const assignedResources = assignments.map((assignment) => resourcesById.get(assignment.resourceId)!)
        const overrideId = resolution.primaryResourceIds?.[target.groupKey]
        if (overrideId != null && !assignedResources.some((resource) => resource.id === overrideId)) {
          throw new Error(`主资源不属于新影片分组 ${target.groupKey}`)
        }
        primaryResourceId =
          overrideId ??
          selectDefaultPendingScanPrimary(assignedResources, normalizeLocalPathIdentity)?.id ??
          null
      }

      for (const assignment of assignments) {
        const resource = resourcesById.get(assignment.resourceId)!
        if (resource.sourceKind === 'strm') {
          const raw = db
            .prepare(
              `SELECT target_kind, target_locator
               FROM pending_scan_resources WHERE id = ?`
            )
            .get(resource.id) as {
            target_kind: ExternalVideoResourceKind | null
            target_locator: string | null
          }
          if (!raw.target_kind || !raw.target_locator) {
            throw new Error('待确认 STRM 目标快照无效')
          }
          insertStrmResource.run(
            videoId,
            raw.target_kind,
            raw.target_locator,
            buildStrmResourceKey(resource.filePath),
            resource.filePath,
            resource.displayName,
            primaryResourceId === resource.id ? 1 : 0
          )
        } else {
          insertLocalResource.run(
            videoId,
            resource.filePath,
            resource.filePath,
            resource.sizeBytes,
            resource.durationSeconds,
            resource.fileMtimeMs,
            resource.displayName,
            primaryResourceId === resource.id ? 1 : 0
          )
        }
      }
      if (target.kind === 'existing' && primaryResourceId == null) {
        const fallbackId = options?.selectFallbackPrimaryResourceId
          ? options.selectFallbackPrimaryResourceId(videoId)
          : (
              db
                .prepare('SELECT id FROM video_resources WHERE video_id = ? ORDER BY id LIMIT 1')
                .get(videoId) as { id: number } | undefined
            )?.id ?? null
        if (fallbackId != null) {
          const fallback = db
            .prepare('SELECT id FROM video_resources WHERE video_id = ? AND id = ?')
            .get(videoId, fallbackId) as { id: number } | undefined
          if (!fallback) throw new Error('主资源候选不属于所选现有影片')
          db.prepare('UPDATE video_resources SET is_primary = 1 WHERE id = ?').run(fallback.id)
        }
      }
    }

    db.prepare('DELETE FROM pending_scan_groups WHERE id = ?').run(groupId)
    return {
      assignedResources: resources.length,
      existingVideoIds: Array.from(new Set(existingVideoIds)),
      createdVideoIds
    }
  })()
}
