import type Database from 'better-sqlite3'
import type {
  PendingScanGroup,
  PendingScanGroupResolution,
  PendingScanGroupResolutionResult,
  PendingScanResource
} from '@shared/libraryTypes'
import {
  isNormalizedLocalPathUnderRoot,
  normalizeAbsoluteLocalPath,
  normalizeLocalPathIdentity
} from '@shared/localPathIdentity'
import { selectDefaultPendingScanPrimary } from '@shared/pendingScanPrimary'
import { normalizeVideoCode } from '@shared/videoCode'
import type { ExternalVideoResourceKind } from '@shared/videoTypes'
import { maskVideoResourceLocator } from '@shared/videoResourceLinks'
import { readStrmFile } from '../scanner/strmParser'
import { getDb } from './database'
import { insertLocalVideoResource, insertStrmVideoResource } from './videoRepo'

export interface PendingScanResourceInput {
  rootId: number
  filePath: string
  sourceKind?: 'local' | 'strm'
  targetKind?: ExternalVideoResourceKind | null
  targetLocator?: string | null
  targetKey?: string | null
  sizeBytes: number | null
  durationSeconds: number | null
  fileMtimeMs: number | null
  displayName?: string | null
}

export interface PendingScanUpsertResult {
  groupId: number
  revision: number
  addedResources: number
}

export interface PendingScanStrmRefreshResult {
  changed: boolean
  message: string | null
  group: PendingScanGroup | null
}

export type PendingScanRepoErrorCode =
  | 'LIBRARY_NOT_FOUND'
  | 'ROOT_NOT_FOUND'
  | 'GROUP_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'VALIDATION_FAILED'

export class PendingScanRepoError extends Error {
  constructor(
    readonly code: PendingScanRepoErrorCode,
    message: string,
    readonly currentRevision?: number
  ) {
    super(message)
    this.name = 'PendingScanRepoError'
  }
}

interface LibraryRow {
  id: number
  status: 'active' | 'archived'
}

interface RootRow {
  id: number
  library_id: number
  normalized_path: string
  normalized_real_path: string | null
  state: 'active' | 'pending_removal' | 'disabled' | 'archived'
}

interface PendingGroupRow {
  id: number
  library_id: number
  normalized_code: string
  revision: number
  created_at: string
  updated_at: string
}

interface PendingResourceRow {
  id: number
  library_id: number
  group_id: number
  root_id: number
  file_path: string
  normalized_path: string
  source_kind: 'local' | 'strm'
  target_kind: ExternalVideoResourceKind | null
  target_locator: string | null
  target_key: string | null
  size_bytes: number | null
  duration_seconds: number | null
  file_mtime_ms: number | null
  display_name: string | null
  created_at: string
  updated_at: string
}

interface PreparedPendingResource {
  rootId: number
  filePath: string
  normalizedPath: string
  sourceKind: 'local' | 'strm'
  targetKind: ExternalVideoResourceKind | null
  targetLocator: string | null
  targetKey: string | null
  sizeBytes: number | null
  durationSeconds: number | null
  fileMtimeMs: number | null
  displayName: string | null
}

function validationError(message: string): never {
  throw new PendingScanRepoError('VALIDATION_FAILED', message)
}

function positiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) validationError(`${label}必须是正整数。`)
  return value
}

function positiveRevision(value: number): number {
  return positiveId(value, 'revision')
}

function requireLibrary(database: Database.Database, libraryId: number): LibraryRow {
  positiveId(libraryId, 'libraryId')
  const library = database
    .prepare('SELECT id, status FROM media_libraries WHERE id = ?')
    .get(libraryId) as LibraryRow | undefined
  if (!library) throw new PendingScanRepoError('LIBRARY_NOT_FOUND', '媒体库不存在。')
  return library
}

function requireActiveLibrary(database: Database.Database, libraryId: number): LibraryRow {
  const library = requireLibrary(database, libraryId)
  if (library.status !== 'active') {
    throw new PendingScanRepoError('LIBRARY_NOT_FOUND', '媒体库已归档，不能修改待确认扫描。')
  }
  return library
}

function getRoot(database: Database.Database, libraryId: number, rootId: number): RootRow | null {
  positiveId(rootId, 'rootId')
  return (
    (database
      .prepare(
        `SELECT id, library_id, normalized_path, normalized_real_path, state
           FROM media_library_roots
          WHERE id = ? AND library_id = ?`
      )
      .get(rootId, libraryId) as RootRow | undefined) ?? null
  )
}

function requireActiveRoot(
  database: Database.Database,
  libraryId: number,
  rootId: number
): RootRow {
  const root = getRoot(database, libraryId, rootId)
  if (!root || root.state !== 'active') {
    throw new PendingScanRepoError(
      'ROOT_NOT_FOUND',
      '根目录不属于该媒体库或当前不可用于扫描。'
    )
  }
  return root
}

function getGroupRow(
  database: Database.Database,
  libraryId: number,
  groupId: number
): PendingGroupRow | null {
  positiveId(groupId, 'groupId')
  return (
    (database
      .prepare('SELECT * FROM pending_scan_groups WHERE id = ? AND library_id = ?')
      .get(groupId, libraryId) as PendingGroupRow | undefined) ?? null
  )
}

function requireGroupRow(
  database: Database.Database,
  libraryId: number,
  groupId: number
): PendingGroupRow {
  const group = getGroupRow(database, libraryId, groupId)
  if (!group) throw new PendingScanRepoError('GROUP_NOT_FOUND', '待确认扫描组不存在。')
  return group
}

function mapPendingResource(row: PendingResourceRow): PendingScanResource {
  return {
    id: row.id,
    libraryId: row.library_id,
    groupId: row.group_id,
    rootId: row.root_id,
    filePath: row.file_path,
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

function mapPendingGroup(
  row: PendingGroupRow,
  resources: PendingScanResource[]
): PendingScanGroup {
  return {
    id: row.id,
    libraryId: row.library_id,
    normalizedCode: row.normalized_code,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resources
  }
}

function prepareResourceInput(
  database: Database.Database,
  libraryId: number,
  input: PendingScanResourceInput
): PreparedPendingResource {
  const root = requireActiveRoot(database, libraryId, input.rootId)
  let filePath: string
  let normalizedPath: string
  try {
    ;({ path: filePath, normalizedPath } = normalizeAbsoluteLocalPath(input.filePath))
  } catch {
    validationError('待确认资源路径必须是绝对路径。')
  }
  if (
    !isNormalizedLocalPathUnderRoot(normalizedPath, root.normalized_path) &&
    (!root.normalized_real_path ||
      !isNormalizedLocalPathUnderRoot(normalizedPath, root.normalized_real_path))
  ) {
    throw new PendingScanRepoError('ROOT_NOT_FOUND', '待确认资源不在指定媒体库根目录内。')
  }

  const sourceKind = input.sourceKind ?? 'local'
  if (sourceKind !== 'local' && sourceKind !== 'strm') {
    validationError('待确认资源类型无效。')
  }
  const targetKind = input.targetKind ?? null
  const targetLocator = input.targetLocator ?? null
  const targetKey = input.targetKey ?? null
  if (sourceKind === 'strm' && (!targetKind || !targetLocator || !targetKey)) {
    validationError('STRM 待确认资源缺少有效目标快照。')
  }
  if (sourceKind === 'local' && (targetKind || targetLocator || targetKey)) {
    validationError('本地待确认资源不能包含 STRM 目标快照。')
  }

  return {
    rootId: root.id,
    filePath,
    normalizedPath,
    sourceKind,
    targetKind,
    targetLocator,
    targetKey,
    sizeBytes: input.sizeBytes,
    durationSeconds: input.durationSeconds,
    fileMtimeMs: input.fileMtimeMs,
    displayName: input.displayName?.trim() || null
  }
}

function touchOrDeleteGroup(
  database: Database.Database,
  libraryId: number,
  groupId: number
): 'updated' | 'deleted' | 'missing' {
  const group = getGroupRow(database, libraryId, groupId)
  if (!group) return 'missing'
  const hasResources = Boolean(
    database
      .prepare(
        `SELECT 1 FROM pending_scan_resources
          WHERE library_id = ? AND group_id = ? LIMIT 1`
      )
      .get(libraryId, groupId)
  )
  if (!hasResources) {
    database
      .prepare('DELETE FROM pending_scan_groups WHERE id = ? AND library_id = ?')
      .run(groupId, libraryId)
    return 'deleted'
  }
  database
    .prepare(
      `UPDATE pending_scan_groups
          SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND library_id = ?`
    )
    .run(groupId, libraryId)
  return 'updated'
}

export function upsertPendingScanResources(
  libraryId: number,
  code: string,
  inputs: PendingScanResourceInput[]
): PendingScanUpsertResult {
  const database = getDb()
  requireActiveLibrary(database, libraryId)
  if (!Array.isArray(inputs) || inputs.length === 0) {
    validationError('待确认扫描资源不能为空。')
  }
  const normalizedCode = normalizeVideoCode(code)
  const prepared = inputs.map((input) => prepareResourceInput(database, libraryId, input))
  if (new Set(prepared.map((input) => input.normalizedPath)).size !== prepared.length) {
    validationError('同一次待确认写入不能包含重复路径。')
  }

  return database.transaction(() => {
    requireActiveLibrary(database, libraryId)
    for (const input of inputs) requireActiveRoot(database, libraryId, input.rootId)

    let group = database
      .prepare(
        'SELECT * FROM pending_scan_groups WHERE library_id = ? AND normalized_code = ?'
      )
      .get(libraryId, normalizedCode) as PendingGroupRow | undefined
    const groupExisted = Boolean(group)
    if (!group) {
      const info = database
        .prepare(
          `INSERT INTO pending_scan_groups (
             library_id, normalized_code, revision, created_at, updated_at
           ) VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        )
        .run(libraryId, normalizedCode)
      group = requireGroupRow(database, libraryId, Number(info.lastInsertRowid))
    }

    const previousGroupIds = new Set<number>()
    const insert = database.prepare(
      `INSERT INTO pending_scan_resources (
         library_id, group_id, root_id, file_path, normalized_path, source_kind,
         target_kind, target_locator, target_key, size_bytes, duration_seconds,
         file_mtime_ms, display_name, created_at, updated_at
       ) VALUES (
         @libraryId, @groupId, @rootId, @filePath, @normalizedPath, @sourceKind,
         @targetKind, @targetLocator, @targetKey, @sizeBytes, @durationSeconds,
         @fileMtimeMs, @displayName, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )`
    )
    const update = database.prepare(
      `UPDATE pending_scan_resources
          SET group_id = @groupId,
              root_id = @rootId,
              file_path = @filePath,
              source_kind = @sourceKind,
              target_kind = @targetKind,
              target_locator = @targetLocator,
              target_key = @targetKey,
              size_bytes = @sizeBytes,
              duration_seconds = @durationSeconds,
              file_mtime_ms = @fileMtimeMs,
              display_name = @displayName,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = @id AND library_id = @libraryId`
    )
    let addedResources = 0
    for (const resource of prepared) {
      const existing = database
        .prepare(
          `SELECT id, library_id, group_id
             FROM pending_scan_resources
            WHERE library_id = ? AND normalized_path = ?`
        )
        .get(libraryId, resource.normalizedPath) as
        | { id: number; library_id: number; group_id: number }
        | undefined
      const parameters = { libraryId, groupId: group.id, ...resource }
      if (existing) {
        if (existing.group_id !== group.id) previousGroupIds.add(existing.group_id)
        update.run({ id: existing.id, ...parameters })
      } else {
        insert.run(parameters)
        addedResources += 1
      }
    }

    if (groupExisted) {
      database
        .prepare(
          `UPDATE pending_scan_groups
              SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND library_id = ?`
        )
        .run(group.id, libraryId)
    }
    for (const previousGroupId of previousGroupIds) {
      touchOrDeleteGroup(database, libraryId, previousGroupId)
    }
    const current = requireGroupRow(database, libraryId, group.id)
    return { groupId: current.id, revision: current.revision, addedResources }
  }).immediate()
}

export function pendingScanResourceExists(libraryId: number, filePath: string): boolean {
  const database = getDb()
  requireLibrary(database, libraryId)
  let normalizedPath: string
  try {
    ;({ normalizedPath } = normalizeAbsoluteLocalPath(filePath))
  } catch {
    validationError('待确认资源路径必须是绝对路径。')
  }
  return Boolean(
    database
      .prepare(
        'SELECT 1 FROM pending_scan_resources WHERE library_id = ? AND normalized_path = ?'
      )
      .get(libraryId, normalizedPath)
  )
}

export function removePendingScanResource(libraryId: number, filePath: string): boolean {
  const database = getDb()
  requireLibrary(database, libraryId)
  let normalizedPath: string
  try {
    ;({ normalizedPath } = normalizeAbsoluteLocalPath(filePath))
  } catch {
    validationError('待确认资源路径必须是绝对路径。')
  }
  return database.transaction(() => {
    requireLibrary(database, libraryId)
    const resource = database
      .prepare(
        `SELECT id, group_id FROM pending_scan_resources
          WHERE library_id = ? AND normalized_path = ?`
      )
      .get(libraryId, normalizedPath) as { id: number; group_id: number } | undefined
    if (!resource) return false
    database
      .prepare('DELETE FROM pending_scan_resources WHERE id = ? AND library_id = ?')
      .run(resource.id, libraryId)
    touchOrDeleteGroup(database, libraryId, resource.group_id)
    return true
  }).immediate()
}

export function listPendingScanGroups(libraryId: number): PendingScanGroup[] {
  const database = getDb()
  requireLibrary(database, libraryId)
  const groups = database
    .prepare(
      'SELECT * FROM pending_scan_groups WHERE library_id = ? ORDER BY updated_at, id'
    )
    .all(libraryId) as PendingGroupRow[]
  if (groups.length === 0) return []
  const resources = database
    .prepare(
      `SELECT * FROM pending_scan_resources
        WHERE library_id = ? ORDER BY group_id, normalized_path, id`
    )
    .all(libraryId) as PendingResourceRow[]
  const resourcesByGroup = new Map<number, PendingScanResource[]>()
  for (const row of resources) {
    const resource = mapPendingResource(row)
    const items = resourcesByGroup.get(row.group_id)
    if (items) items.push(resource)
    else resourcesByGroup.set(row.group_id, [resource])
  }
  return groups.map((group) => mapPendingGroup(group, resourcesByGroup.get(group.id) ?? []))
}

export function getPendingScanGroup(libraryId: number, groupId: number): PendingScanGroup | null {
  const database = getDb()
  requireLibrary(database, libraryId)
  const group = getGroupRow(database, libraryId, groupId)
  if (!group) return null
  const resources = (
    database
      .prepare(
        `SELECT * FROM pending_scan_resources
          WHERE library_id = ? AND group_id = ? ORDER BY normalized_path, id`
      )
      .all(libraryId, groupId) as PendingResourceRow[]
  ).map(mapPendingResource)
  return mapPendingGroup(group, resources)
}

export function reconcilePendingScanResources(
  libraryId: number,
  accessibleRootIds: number[],
  inspectPath: (filePath: string) => 'present' | 'missing' | 'unknown',
  candidateIds?: readonly number[]
): { removedResources: number; removedGroups: number } {
  if (candidateIds && (candidateIds.length > 128 || candidateIds.some(id => !Number.isSafeInteger(id) || id <= 0))) throw new Error('Invalid cleanup candidate IDs')
  const database = getDb()
  requireLibrary(database, libraryId)
  const rootIds = Array.from(
    new Set(accessibleRootIds.map((rootId) => positiveId(rootId, 'rootId')))
  )
  if (rootIds.length === 0) return { removedResources: 0, removedGroups: 0 }

  return database.transaction(() => {
    requireLibrary(database, libraryId)
    for (const rootId of rootIds) requireActiveRoot(database, libraryId, rootId)
    const resources = database
      .prepare(
        `SELECT id, group_id, file_path FROM pending_scan_resources ${candidateIds ? 'NOT INDEXED' : ''}
          WHERE library_id = ? AND root_id IN (SELECT value FROM json_each(?))
          ${candidateIds ? 'AND id IN (SELECT value FROM json_each(?))' : ''} ORDER BY id`
      )
      .all(libraryId, JSON.stringify(rootIds), ...(candidateIds ? [JSON.stringify(candidateIds)] : [])) as Array<{
      id: number
      group_id: number
      file_path: string
    }>
    const affectedGroupIds = new Set<number>()
    let removedResources = 0
    for (const resource of resources) {
      if (inspectPath(resource.file_path) !== 'missing') continue
      const info = database
        .prepare('DELETE FROM pending_scan_resources WHERE id = ? AND library_id = ?')
        .run(resource.id, libraryId)
      if (info.changes > 0) {
        removedResources += info.changes
        affectedGroupIds.add(resource.group_id)
      }
    }
    let removedGroups = 0
    for (const groupId of affectedGroupIds) {
      if (touchOrDeleteGroup(database, libraryId, groupId) === 'deleted') removedGroups += 1
    }
    return { removedResources, removedGroups }
  }).immediate()
}

export function refreshPendingStrmSnapshots(
  libraryId: number,
  groupId: number
): PendingScanStrmRefreshResult {
  const database = getDb()
  requireActiveLibrary(database, libraryId)
  const initialGroup = requireGroupRow(database, libraryId, groupId)
  const rows = database
    .prepare(
      `SELECT * FROM pending_scan_resources
        WHERE library_id = ? AND group_id = ? AND source_kind = 'strm'
        ORDER BY id`
    )
    .all(libraryId, groupId) as PendingResourceRow[]
  if (rows.length === 0) {
    return { changed: false, message: null, group: getPendingScanGroup(libraryId, groupId) }
  }

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

  if (invalidIds.length === 0 && updates.length === 0) {
    return { changed: false, message: null, group: getPendingScanGroup(libraryId, groupId) }
  }
  database.transaction(() => {
    const currentGroup = requireGroupRow(database, libraryId, groupId)
    if (currentGroup.revision !== initialGroup.revision) {
      throw new PendingScanRepoError(
        'REVISION_CONFLICT',
        '待确认扫描组已被其他操作更新，请刷新后重试。',
        currentGroup.revision
      )
    }
    const update = database.prepare(
      `UPDATE pending_scan_resources
          SET target_kind = ?, target_locator = ?, target_key = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND library_id = ? AND group_id = ?`
    )
    for (const item of updates) {
      update.run(item.kind, item.locator, item.targetKey, item.id, libraryId, groupId)
    }
    const remove = database.prepare(
      'DELETE FROM pending_scan_resources WHERE id = ? AND library_id = ? AND group_id = ?'
    )
    for (const id of invalidIds) remove.run(id, libraryId, groupId)
    touchOrDeleteGroup(database, libraryId, groupId)
  }).immediate()

  const message =
    invalidIds.length > 0
      ? '待确认 STRM 已失效或消失，待确认组已刷新'
      : targetChanged
        ? '待确认 STRM 目标已变化，待确认组已刷新'
        : null
  return {
    changed: true,
    message,
    group: getPendingScanGroup(libraryId, groupId)
  }
}

function assertResolutionAssignments(
  resources: PendingScanResource[],
  resolution: PendingScanGroupResolution
): void {
  const expectedIds = new Set(resources.map((resource) => resource.id))
  const assignedIds = resolution.assignments.map((assignment) => assignment.resourceId)
  if (
    assignedIds.length !== resources.length ||
    new Set(assignedIds).size !== assignedIds.length ||
    assignedIds.some((id) => !expectedIds.has(id))
  ) {
    validationError('必须将待确认扫描组内每条资源恰好分配一次。')
  }
}

export function resolvePendingScanGroup(
  libraryId: number,
  groupId: number,
  resolution: PendingScanGroupResolution,
  options?: {
    selectFallbackPrimaryResourceId?: (libraryId: number, videoId: number) => number | null
  }
): PendingScanGroupResolutionResult {
  positiveRevision(resolution.expectedRevision)
  requireActiveLibrary(getDb(), libraryId)
  const refresh = refreshPendingStrmSnapshots(libraryId, groupId)
  if (refresh.changed) {
    throw new PendingScanRepoError(
      'REVISION_CONFLICT',
      refresh.message ?? '待确认扫描组已刷新，请重新确认。',
      refresh.group?.revision
    )
  }

  const database = getDb()
  return database.transaction(() => {
    requireActiveLibrary(database, libraryId)
    const group = requireGroupRow(database, libraryId, groupId)
    if (group.revision !== resolution.expectedRevision) {
      throw new PendingScanRepoError(
        'REVISION_CONFLICT',
        '待确认扫描组已被其他操作更新，请刷新后重试。',
        group.revision
      )
    }
    const resourceRows = database
      .prepare(
        `SELECT * FROM pending_scan_resources
          WHERE library_id = ? AND group_id = ? ORDER BY id`
      )
      .all(libraryId, groupId) as PendingResourceRow[]
    const resources = resourceRows.map(mapPendingResource)
    assertResolutionAssignments(resources, resolution)

    const assignmentsByTarget = new Map<string, typeof resolution.assignments>()
    for (const assignment of resolution.assignments) {
      positiveId(assignment.resourceId, 'resourceId')
      const key =
        assignment.target.kind === 'existing'
          ? `existing:${positiveId(assignment.target.videoId, 'videoId')}`
          : `new:${assignment.target.groupKey.trim()}`
      if (assignment.target.kind === 'new' && !assignment.target.groupKey.trim()) {
        validationError('新影片分组标识不能为空。')
      }
      const items = assignmentsByTarget.get(key)
      if (items) items.push(assignment)
      else assignmentsByTarget.set(key, [assignment])
    }

    const resourcesById = new Map(resources.map((resource) => [resource.id, resource]))
    const rawResourcesById = new Map(resourceRows.map((resource) => [resource.id, resource]))
    const existingVideoIds: number[] = []
    const createdVideoIds: number[] = []

    for (const assignments of assignmentsByTarget.values()) {
      const target = assignments[0].target
      let videoId: number
      let existingPrimaryResourceId: number | null = null
      let selectedPendingPrimaryId: number | null = null
      if (target.kind === 'existing') {
        const video = database
          .prepare('SELECT id, code FROM videos WHERE id = ?')
          .get(target.videoId) as { id: number; code: string | null } | undefined
        if (!video?.code || normalizeVideoCode(video.code) !== group.normalized_code) {
          validationError('待确认资源只能分配给同番号现有影片。')
        }
        videoId = video.id
        existingVideoIds.push(videoId)
        const primary = database
          .prepare(
            `SELECT id FROM video_resources
              WHERE library_id = ? AND video_id = ? AND is_primary = 1 LIMIT 1`
          )
          .get(libraryId, videoId) as { id: number } | undefined
        existingPrimaryResourceId = primary?.id ?? null
      } else {
        videoId = Number(
          database
            .prepare('INSERT INTO videos (code, scraped_status) VALUES (?, 0)')
            .run(group.normalized_code).lastInsertRowid
        )
        createdVideoIds.push(videoId)
        const assignedResources = assignments.map(
          (assignment) => resourcesById.get(assignment.resourceId)!
        )
        const overrideId = resolution.primaryResourceIds?.[target.groupKey]
        if (overrideId != null && !assignedResources.some((resource) => resource.id === overrideId)) {
          validationError(`主资源不属于新影片分组 ${target.groupKey}。`)
        }
        selectedPendingPrimaryId =
          overrideId ??
          selectDefaultPendingScanPrimary(assignedResources, normalizeLocalPathIdentity)?.id ??
          null
      }

      for (const assignment of assignments) {
        const resource = resourcesById.get(assignment.resourceId)!
        const isPrimary = selectedPendingPrimaryId === resource.id
        let insertedResourceId: number | null
        if (resource.sourceKind === 'strm') {
          const raw = rawResourcesById.get(resource.id)!
          if (!raw.target_kind || !raw.target_locator) {
            validationError('待确认 STRM 目标快照无效。')
          }
          insertedResourceId = insertStrmVideoResource({
            libraryId,
            videoId,
            rootId: resource.rootId,
            sourcePath: resource.filePath,
            kind: raw.target_kind,
            locator: raw.target_locator,
            displayName: resource.displayName,
            isPrimary
          })
        } else {
          insertedResourceId = insertLocalVideoResource({
            libraryId,
            videoId,
            rootId: resource.rootId,
            locator: resource.filePath,
            sizeBytes: resource.sizeBytes,
            durationSeconds: resource.durationSeconds,
            fileMtimeMs: resource.fileMtimeMs,
            displayName: resource.displayName,
            isPrimary
          })
        }
        if (insertedResourceId == null) {
          validationError('待确认资源已被其它影片或媒体库占用。')
        }
      }

      if (target.kind === 'existing' && existingPrimaryResourceId == null) {
        const fallbackId = options?.selectFallbackPrimaryResourceId
          ? options.selectFallbackPrimaryResourceId(libraryId, videoId)
          : (
              database
                .prepare(
                  `SELECT id FROM video_resources
                    WHERE library_id = ? AND video_id = ?
                    ORDER BY is_primary DESC, id LIMIT 1`
                )
                .get(libraryId, videoId) as { id: number } | undefined
            )?.id ?? null
        if (fallbackId != null) {
          const fallback = database
            .prepare(
              `SELECT id FROM video_resources
                WHERE id = ? AND library_id = ? AND video_id = ?`
            )
            .get(fallbackId, libraryId, videoId) as { id: number } | undefined
          if (!fallback) validationError('主资源候选不属于当前媒体库中的所选影片。')
          database
            .prepare(
              `UPDATE video_resources
                  SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END
                WHERE library_id = ? AND video_id = ?`
            )
            .run(fallback.id, libraryId, videoId)
        }
      }
    }

    const deleted = database
      .prepare(
        `DELETE FROM pending_scan_groups
          WHERE id = ? AND library_id = ? AND revision = ?`
      )
      .run(groupId, libraryId, resolution.expectedRevision)
    if (deleted.changes !== 1) {
      throw new PendingScanRepoError(
        'REVISION_CONFLICT',
        '待确认扫描组已被其他操作更新，请刷新后重试。'
      )
    }
    return {
      assignedResources: resources.length,
      existingVideoIds: Array.from(new Set(existingVideoIds)),
      createdVideoIds
    }
  }).immediate()
}
