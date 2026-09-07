import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import {
  LEGACY_CLEANUP_JOB_ID_PATTERN,
  LEGACY_CLEANUP_WAITING_ERROR
} from '@shared/legacyLibraryCleanup'
import { resolveMediaLibraryRootIdentity } from '@shared/mediaLibraryRootPath'
import type {
  LibraryPathRemovalPreview,
  PendingLibraryPathCleanup
} from '@shared/libraryTypes'
import type { VideoResource } from '@shared/videoTypes'
import { getDb } from '../db/database'
import {
  findManagedMediaLibraryRootConflict,
  getMediaLibraryRoot,
  MediaLibraryRepoError,
  resolveMediaLibraryRootPath
} from '../db/mediaLibraryRepo'
import {
  listVideoResources,
  removeSourceManagedVideoResourcesBatch,
  type VideoResourceBatchRemovalPlan
} from '../db/videoRepo'
import { maintenanceTaskGate } from './maintenanceTaskGate'
import { mediaAssetStore } from './mediaAssetStore'
import { selectPrimaryVideoResourceCandidate } from './videoResourcePromotion'

export interface LibraryRootScope {
  libraryId: number
  rootId: number
}

export interface ConfirmLibraryPathRemovalInput extends LibraryRootScope {
  expectedRevision: number
  expectedImpactRevision: string
}

export interface CancelLibraryPathRemovalInput extends LibraryRootScope {
  expectedRevision: number
}

export interface PendingLibraryPathCleanupResult {
  removed: number
  promoted: number
  consumedRoots: LibraryRootScope[]
}

interface LibraryRow {
  id: number
  status: 'active' | 'archived'
  revision: number
}

interface ConfigRow {
  revision: number
}

interface RootRow {
  id: number
  library_id: number
  path: string
  normalized_path: string
  real_path: string | null
  normalized_real_path: string | null
  device_id: string | null
  inode: string | null
  state: 'active' | 'pending_removal' | 'disabled' | 'archived'
}

interface CleanupJobRow {
  id: string
  library_id: number
  root_id: number
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  root_path: string
  normalized_root_path: string
  normalized_real_path: string | null
  device_id: string | null
  inode: string | null
  config_revision: number
}

interface RecoverableLegacyCleanupRow extends CleanupJobRow {
  root_real_path: string | null
  root_normalized_real_path: string | null
  root_device_id: string | null
  root_inode: string | null
  root_state: RootRow['state']
  current_config_revision: number
}

export interface RecoverLegacyLibraryPathCleanupResult {
  recovered: number
  waiting: number
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} 必须是正整数`)
}

function requireLibrary(libraryId: number): LibraryRow {
  assertPositiveInteger(libraryId, 'libraryId')
  const library = getDb()
    .prepare('SELECT id, status, revision FROM media_libraries WHERE id = ?')
    .get(libraryId) as LibraryRow | undefined
  if (!library) {
    throw new MediaLibraryRepoError('LIBRARY_NOT_FOUND', '媒体库不存在。')
  }
  return library
}

function requireRoot(scope: LibraryRootScope): RootRow {
  assertPositiveInteger(scope.rootId, 'rootId')
  requireLibrary(scope.libraryId)
  const root = getDb()
    .prepare(
      `SELECT id, library_id, path, normalized_path, real_path, normalized_real_path,
              device_id, inode, state
         FROM media_library_roots
        WHERE id = ? AND library_id = ?`
    )
    .get(scope.rootId, scope.libraryId) as RootRow | undefined
  if (!root) throw new MediaLibraryRepoError('ROOT_NOT_FOUND', '媒体库根目录不存在。')
  return root
}

function requireConfigRevision(libraryId: number): number {
  const config = getDb()
    .prepare('SELECT revision FROM media_library_configs WHERE library_id = ?')
    .get(libraryId) as ConfigRow | undefined
  if (!config) throw new MediaLibraryRepoError('LIBRARY_NOT_FOUND', '媒体库配置不存在。')
  return config.revision
}

function listRootManagedResources(scope: LibraryRootScope): VideoResource[] {
  return getDb()
    .prepare(
      `SELECT * FROM video_resources
        WHERE library_id = ? AND root_id = ?
          AND (kind = 'local' OR strm_source_path IS NOT NULL)
        ORDER BY id`
    )
    .all(scope.libraryId, scope.rootId) as VideoResource[]
}

function rootRemovalImpactRevision(scope: LibraryRootScope): string {
  const database = getDb()
  const parameters = { libraryId: scope.libraryId, rootId: scope.rootId }
  const snapshots = [
    database
      .prepare(
        `SELECT * FROM media_library_roots
          WHERE library_id = @libraryId AND id = @rootId`
      )
      .all(parameters),
    database
      .prepare(
        `SELECT * FROM video_resources
          WHERE library_id = @libraryId
          ORDER BY id`
      )
      .all(parameters),
    database
      .prepare(
        `SELECT * FROM pending_scan_resources
          WHERE library_id = @libraryId AND root_id = @rootId
          ORDER BY id`
      )
      .all(parameters),
    database
      .prepare(
        `SELECT * FROM pending_resource_identities
          WHERE library_id = @libraryId AND root_id = @rootId
          ORDER BY id`
      )
      .all(parameters),
    database
      .prepare(
        `SELECT pending_group.*
           FROM pending_scan_groups pending_group
          WHERE pending_group.library_id = @libraryId
            AND EXISTS (
              SELECT 1 FROM pending_scan_resources pending_resource
               WHERE pending_resource.library_id = @libraryId
                 AND pending_resource.root_id = @rootId
                 AND pending_resource.group_id = pending_group.id
            )
          ORDER BY pending_group.id`
      )
      .all(parameters),
    database
      .prepare(
        `SELECT * FROM library_unrecognized_files
          WHERE library_id = @libraryId AND root_id = @rootId
          ORDER BY normalized_path`
      )
      .all(parameters),
    database
      .prepare(
        `SELECT * FROM library_root_cleanup_jobs
          WHERE library_id = @libraryId AND root_id = @rootId
          ORDER BY requested_at, id`
      )
      .all(parameters)
  ]
  return createHash('sha256').update(JSON.stringify(snapshots)).digest('hex')
}

function assertStoredRootIdentity(root: RootRow): void {
  if (!root.normalized_real_path || !root.device_id || !root.inode) {
    throw new Error('根目录缺少可验证身份，请恢复连接并刷新根目录后重试')
  }
}

function resolvedIdentityMatchesRoot(
  root: Pick<RootRow, 'normalized_path' | 'normalized_real_path' | 'device_id' | 'inode'>,
  resolved: ReturnType<typeof resolveMediaLibraryRootPath>
): boolean {
  return (
    resolved.normalizedPath === root.normalized_path &&
    resolved.normalizedRealPath === root.normalized_real_path &&
    resolved.deviceId === root.device_id &&
    resolved.inode === root.inode
  )
}

function resolveRecoverableLegacyRoot(rootPath: string) {
  try {
    const resolved = resolveMediaLibraryRootIdentity(rootPath)
    if (!resolved.normalizedRealPath || !resolved.deviceId || !resolved.inode) return null
    return resolved
  } catch {
    return null
  }
}

function storedLegacyIdentityMatches(
  row: Pick<
    RecoverableLegacyCleanupRow,
    | 'root_normalized_real_path'
    | 'root_device_id'
    | 'root_inode'
    | 'normalized_real_path'
    | 'device_id'
    | 'inode'
  >,
  resolved: NonNullable<ReturnType<typeof resolveRecoverableLegacyRoot>>
): boolean {
  return (
    (!row.root_normalized_real_path ||
      row.root_normalized_real_path === resolved.normalizedRealPath) &&
    (!row.root_device_id || row.root_device_id === resolved.deviceId) &&
    (!row.root_inode || row.root_inode === resolved.inode) &&
    (!row.normalized_real_path || row.normalized_real_path === resolved.normalizedRealPath) &&
    (!row.device_id || row.device_id === resolved.deviceId) &&
    (!row.inode || row.inode === resolved.inode)
  )
}

function requirePendingJob(cleanup: PendingLibraryPathCleanup): CleanupJobRow {
  assertPositiveInteger(cleanup.libraryId, 'libraryId')
  assertPositiveInteger(cleanup.rootId, 'rootId')
  if (!cleanup.jobId) throw new Error('jobId 不能为空')
  const job = getDb()
    .prepare(
      `SELECT id, library_id, root_id, state, root_path, normalized_root_path,
              normalized_real_path, device_id, inode, config_revision
         FROM library_root_cleanup_jobs
        WHERE id = ? AND library_id = ? AND root_id = ? AND state = 'pending'`
    )
    .get(cleanup.jobId, cleanup.libraryId, cleanup.rootId) as CleanupJobRow | undefined
  if (!job) throw new Error('待执行的根目录清理任务不存在')
  return job
}

function assertCleanupJobSafe(job: CleanupJobRow): RootRow {
  const root = requireRoot({ libraryId: job.library_id, rootId: job.root_id })
  if (root.state !== 'pending_removal') throw new Error('根目录不再处于待移除状态')
  if (
    root.path !== job.root_path ||
    root.normalized_path !== job.normalized_root_path ||
    root.normalized_real_path !== job.normalized_real_path ||
    root.device_id !== job.device_id ||
    root.inode !== job.inode
  ) {
    throw new Error('根目录身份已变化，已停止清理')
  }

  assertStoredRootIdentity(root)
  const resolved = resolveMediaLibraryRootPath(root.path)
  if (!resolved.normalizedRealPath || !resolved.deviceId || !resolved.inode) {
    throw new Error('根目录不可用，已停止清理')
  }
  if (!resolvedIdentityMatchesRoot(root, resolved)) {
    throw new Error('根目录身份已变化，已停止清理')
  }
  return root
}

export function listPendingLibraryPathCleanupRoots(
  libraryId: number
): PendingLibraryPathCleanup[] {
  requireLibrary(libraryId)
  return (
    getDb()
      .prepare(
        `SELECT id AS job_id, library_id, root_id
           FROM library_root_cleanup_jobs
          WHERE library_id = ? AND state = 'pending'
          ORDER BY requested_at, id`
      )
      .all(libraryId) as Array<{ job_id: string; library_id: number; root_id: number }>
  ).map((row) => ({
    jobId: row.job_id,
    libraryId: row.library_id,
    rootId: row.root_id
  }))
}

/**
 * Re-arm cleanup intents imported while their legacy path was offline.
 *
 * Failed rows carrying the stable bootstrap marker are waiting records, not attempted
 * destructive work. A full scan calls this before reading its snapshot. The first usable
 * filesystem identity is frozen on both the root and job in one immediate transaction;
 * a previously frozen identity must match before the intent can become active again. A
 * candidate that overlaps any globally managed root remains disabled and waiting.
 */
export function recoverLegacyLibraryPathCleanups(
  libraryId: number
): RecoverLegacyLibraryPathCleanupResult {
  const library = requireLibrary(libraryId)
  if (library.status !== 'active') return { recovered: 0, waiting: 0 }
  const database = getDb()
  const candidates = database
    .prepare(
      `SELECT job.id, job.library_id, job.root_id, job.state, job.root_path,
              job.normalized_root_path, job.normalized_real_path, job.device_id,
              job.inode, job.config_revision,
              root.real_path AS root_real_path,
              root.normalized_real_path AS root_normalized_real_path,
              root.device_id AS root_device_id, root.inode AS root_inode,
              root.state AS root_state,
              config.revision AS current_config_revision
         FROM library_root_cleanup_jobs job
         JOIN media_library_roots root
           ON root.id = job.root_id AND root.library_id = job.library_id
         JOIN media_library_configs config ON config.library_id = job.library_id
        WHERE job.library_id = ?
          AND job.id LIKE ?
          AND job.state = 'failed'
          AND job.last_error = ?
          AND root.state = 'disabled'
        ORDER BY job.requested_at, job.id`
    )
    .all(libraryId, LEGACY_CLEANUP_JOB_ID_PATTERN, LEGACY_CLEANUP_WAITING_ERROR) as
    RecoverableLegacyCleanupRow[]
  const prepared = candidates.flatMap((candidate) => {
    const resolved = resolveRecoverableLegacyRoot(candidate.root_path)
    if (!resolved || !storedLegacyIdentityMatches(candidate, resolved)) return []
    return [{ candidate, resolved }]
  })
  if (prepared.length === 0) return { recovered: 0, waiting: candidates.length }

  const recovered = database.transaction(() => {
    let count = 0
    const readCurrent = database.prepare(
      `SELECT job.id, job.library_id, job.root_id, job.state, job.root_path,
              job.normalized_root_path, job.normalized_real_path, job.device_id,
              job.inode, job.config_revision,
              root.real_path AS root_real_path,
              root.normalized_real_path AS root_normalized_real_path,
              root.device_id AS root_device_id, root.inode AS root_inode,
              root.state AS root_state,
              config.revision AS current_config_revision
         FROM library_root_cleanup_jobs job
         JOIN media_library_roots root
           ON root.id = job.root_id AND root.library_id = job.library_id
         JOIN media_library_configs config ON config.library_id = job.library_id
         JOIN media_libraries library ON library.id = job.library_id
        WHERE job.id = ? AND job.library_id = ? AND job.root_id = ?
          AND job.state = 'failed' AND job.last_error = ?
          AND root.state = 'disabled' AND library.status = 'active'`
    )
    const timestamp = new Date().toISOString()
    for (const item of prepared) {
      const current = readCurrent.get(
        item.candidate.id,
        libraryId,
        item.candidate.root_id,
        LEGACY_CLEANUP_WAITING_ERROR
      ) as RecoverableLegacyCleanupRow | undefined
      if (!current) continue
      if (
        current.root_path !== item.candidate.root_path ||
        current.normalized_root_path !== item.candidate.normalized_root_path
      ) {
        continue
      }
      const confirmed = resolveRecoverableLegacyRoot(current.root_path)
      if (
        !confirmed ||
        confirmed.normalizedRealPath !== item.resolved.normalizedRealPath ||
        confirmed.deviceId !== item.resolved.deviceId ||
        confirmed.inode !== item.resolved.inode ||
        !storedLegacyIdentityMatches(current, confirmed)
      ) {
        continue
      }
      if (findManagedMediaLibraryRootConflict(confirmed, current.root_id)) continue
      const rootUpdate = database
        .prepare(
          `UPDATE media_library_roots
              SET real_path = ?, normalized_real_path = ?, device_id = ?, inode = ?,
                  state = 'pending_removal', updated_at = ?
            WHERE id = ? AND library_id = ? AND state = 'disabled'
              AND path = ? AND normalized_path = ?`
        )
        .run(
          confirmed.realPath,
          confirmed.normalizedRealPath,
          confirmed.deviceId,
          confirmed.inode,
          timestamp,
          current.root_id,
          libraryId,
          current.root_path,
          current.normalized_root_path
        )
      if (rootUpdate.changes !== 1) continue
      const jobUpdate = database
        .prepare(
          `UPDATE library_root_cleanup_jobs
              SET state = 'pending', normalized_real_path = ?, device_id = ?, inode = ?,
                  config_revision = ?, last_error = NULL, started_at = NULL,
                  completed_at = NULL
            WHERE id = ? AND library_id = ? AND root_id = ?
              AND state = 'failed' AND last_error = ?`
        )
        .run(
          confirmed.normalizedRealPath,
          confirmed.deviceId,
          confirmed.inode,
          current.current_config_revision,
          current.id,
          libraryId,
          current.root_id,
          LEGACY_CLEANUP_WAITING_ERROR
        )
      if (jobUpdate.changes !== 1) throw new Error('旧版根目录清理恢复状态已变化')
      count += 1
    }
    if (count > 0) {
      database
        .prepare(
          'UPDATE media_libraries SET revision = revision + 1, updated_at = ? WHERE id = ?'
        )
        .run(timestamp, libraryId)
    }
    return count
  }).immediate()

  return { recovered, waiting: candidates.length - recovered }
}

/**
 * Cancel one queued removal without adopting whatever currently occupies the path.
 *
 * The frozen physical identity is intentionally retained and the root becomes disabled.
 * This lets an operator recover from an offline/replaced source without deleting any
 * root-owned records or silently treating a replacement directory as the old source.
 */
export function cancelLibraryPathRemoval(
  input: CancelLibraryPathRemovalInput
): NonNullable<ReturnType<typeof getMediaLibraryRoot>> {
  assertPositiveInteger(input.libraryId, 'libraryId')
  assertPositiveInteger(input.rootId, 'rootId')
  assertPositiveInteger(input.expectedRevision, 'expectedRevision')
  const database = getDb()
  database.transaction(() => {
    const library = requireLibrary(input.libraryId)
    if (library.status !== 'active') {
      throw new MediaLibraryRepoError('LIBRARY_ARCHIVED', '已归档媒体库不能取消目录移除。')
    }
    if (library.revision !== input.expectedRevision) {
      throw new MediaLibraryRepoError(
        'REVISION_CONFLICT',
        '媒体库已被其他操作更新，请刷新后重试。',
        { currentRevision: library.revision }
      )
    }
    const root = requireRoot(input)
    if (root.state !== 'pending_removal') {
      throw new MediaLibraryRepoError('VALIDATION_FAILED', '根目录不再处于待移除状态。')
    }
    const jobs = database
      .prepare(
        `SELECT id
           FROM library_root_cleanup_jobs
          WHERE library_id = ? AND root_id = ? AND state = 'pending'
          ORDER BY requested_at, id`
      )
      .all(input.libraryId, input.rootId) as Array<{ id: string }>
    if (jobs.length !== 1) {
      throw new MediaLibraryRepoError(
        'VALIDATION_FAILED',
        '根目录待移除任务状态不完整，请刷新后重试。'
      )
    }

    const cancelledAt = new Date().toISOString()
    const jobUpdate = database
      .prepare(
        `UPDATE library_root_cleanup_jobs
            SET state = 'cancelled', completed_at = ?, last_error = NULL
          WHERE id = ? AND library_id = ? AND root_id = ? AND state = 'pending'`
      )
      .run(cancelledAt, jobs[0].id, input.libraryId, input.rootId)
    if (jobUpdate.changes !== 1) {
      throw new MediaLibraryRepoError('REVISION_CONFLICT', '目录移除任务已发生变化，请刷新后重试。')
    }
    const rootUpdate = database
      .prepare(
        `UPDATE media_library_roots
            SET state = 'disabled', updated_at = ?
          WHERE id = ? AND library_id = ? AND state = 'pending_removal'`
      )
      .run(cancelledAt, input.rootId, input.libraryId)
    if (rootUpdate.changes !== 1) {
      throw new MediaLibraryRepoError('REVISION_CONFLICT', '根目录状态已发生变化，请刷新后重试。')
    }
    const revisionUpdate = database
      .prepare(
        `UPDATE media_libraries
            SET revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?`
      )
      .run(cancelledAt, input.libraryId, input.expectedRevision)
    if (revisionUpdate.changes !== 1) {
      throw new MediaLibraryRepoError(
        'REVISION_CONFLICT',
        '媒体库已被其他操作更新，请刷新后重试。'
      )
    }
  }).immediate()

  const root = getMediaLibraryRoot(input.libraryId, input.rootId)
  if (!root) {
    throw new MediaLibraryRepoError('ROOT_NOT_FOUND', '媒体库根目录不存在。')
  }
  return root
}

export function runLibraryScanCleanupTransaction<T>(operation: () => T): T {
  return mediaAssetStore.coordinateDatabaseChange(() => getDb().transaction(operation)())
}

export function previewLibraryPathRemoval(scope: LibraryRootScope): LibraryPathRemovalPreview {
  const database = getDb()
  const library = requireLibrary(scope.libraryId)
  const root = requireRoot(scope)
  const affectedResources = listRootManagedResources(scope)
  const affectedIds = new Set(affectedResources.map((resource) => resource.id))
  const affectedVideoIds = new Set(affectedResources.map((resource) => resource.video_id))
  let videosBecomingResourceLess = 0

  for (const videoId of affectedVideoIds) {
    if (
      listVideoResources(scope.libraryId, videoId).every((resource) =>
        affectedIds.has(resource.id)
      )
    ) {
      videosBecomingResourceLess += 1
    }
  }
  const counts = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM pending_scan_resources
           WHERE library_id = @libraryId AND root_id = @rootId) +
         (SELECT COUNT(*) FROM pending_resource_identities
           WHERE library_id = @libraryId AND root_id = @rootId)
           AS pending_scan_resource_count,
         (SELECT COUNT(*) FROM library_unrecognized_files
           WHERE library_id = @libraryId AND root_id = @rootId) AS unrecognized_file_count,
         (SELECT COUNT(*) FROM library_root_cleanup_jobs
           WHERE library_id = @libraryId AND root_id = @rootId
             AND state IN ('completed', 'failed', 'cancelled')) AS terminal_cleanup_job_count`
    )
    .get(scope) as {
    pending_scan_resource_count: number
    unrecognized_file_count: number
    terminal_cleanup_job_count: number
  }

  return {
    libraryId: scope.libraryId,
    rootId: scope.rootId,
    libraryRevision: library.revision,
    impactRevision: rootRemovalImpactRevision(scope),
    path: root.path,
    localResourceCount: affectedResources.filter((resource) => resource.kind === 'local').length,
    strmResourceCount: affectedResources.filter((resource) => resource.strm_source_path !== null)
      .length,
    pendingScanResourceCount: counts.pending_scan_resource_count,
    unrecognizedFileCount: counts.unrecognized_file_count,
    terminalCleanupJobCount: counts.terminal_cleanup_job_count,
    videosBecomingResourceLess
  }
}

export function confirmLibraryPathRemoval(
  input: ConfirmLibraryPathRemovalInput
): PendingLibraryPathCleanup {
  return maintenanceTaskGate.runSync('resource-maintenance', () => {
    const database = getDb()
    const jobId = randomUUID()
    database.transaction(() => {
      const library = requireLibrary(input.libraryId)
      if (library.status !== 'active') {
        throw new MediaLibraryRepoError('LIBRARY_ARCHIVED', '已归档媒体库不能移除根目录。')
      }
      if (library.revision !== input.expectedRevision) {
        throw new MediaLibraryRepoError(
          'REVISION_CONFLICT',
          '媒体库已被其他操作更新，请刷新后重试。',
          { currentRevision: library.revision }
        )
      }
      const currentImpactRevision = rootRemovalImpactRevision(input)
      if (currentImpactRevision !== input.expectedImpactRevision) {
        throw new MediaLibraryRepoError(
          'REVISION_CONFLICT',
          '根目录影响范围已变化，请重新预览后重试。',
          { currentRevision: library.revision }
        )
      }
      const root = requireRoot(input)
      if (root.state !== 'active' && root.state !== 'disabled') {
        throw new MediaLibraryRepoError('VALIDATION_FAILED', '根目录已被移除或不可编辑。')
      }
      assertStoredRootIdentity(root)
      const resolved = resolveMediaLibraryRootPath(root.path)
      if (resolved.normalizedRealPath && !resolvedIdentityMatchesRoot(root, resolved)) {
        throw new Error('根目录身份已变化，请刷新根目录后重试')
      }

      const timestamp = new Date().toISOString()
      database
        .prepare(
          `INSERT INTO library_root_cleanup_jobs (
             id, library_id, root_id, state, requested_at, root_path,
             normalized_root_path, normalized_real_path, device_id, inode,
             config_revision
           ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          jobId,
          input.libraryId,
          input.rootId,
          timestamp,
          root.path,
          root.normalized_path,
          root.normalized_real_path,
          root.device_id,
          root.inode,
          requireConfigRevision(input.libraryId)
        )
      database
        .prepare(
          `UPDATE media_library_roots
              SET state = 'pending_removal', updated_at = ?
            WHERE id = ? AND library_id = ? AND state IN ('active', 'disabled')`
        )
        .run(timestamp, input.rootId, input.libraryId)
      const revisionUpdate = database
        .prepare(
          `UPDATE media_libraries
              SET revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ?`
        )
        .run(timestamp, input.libraryId, input.expectedRevision)
      if (revisionUpdate.changes !== 1) {
        throw new MediaLibraryRepoError(
          'REVISION_CONFLICT',
          '媒体库已被其他操作更新，请刷新后重试。'
        )
      }
    }).immediate()

    return { jobId, libraryId: input.libraryId, rootId: input.rootId }
  })
}

function applyPendingLibraryPathCleanupsInTransaction(
  cleanups: PendingLibraryPathCleanup[]
): PendingLibraryPathCleanupResult {
  if (cleanups.length === 0) return { removed: 0, promoted: 0, consumedRoots: [] }
  const database = getDb()
  const uniqueCleanups = Array.from(new Map(cleanups.map((item) => [item.jobId, item])).values())
  const jobs = uniqueCleanups.map(requirePendingJob)
  for (const job of jobs) assertCleanupJobSafe(job)

  const affectedResources = jobs.flatMap((job) =>
    listRootManagedResources({ libraryId: job.library_id, rootId: job.root_id })
  )
  const resourcesByVideo = new Map<string, VideoResource[]>()
  for (const resource of affectedResources) {
    const key = `${resource.library_id}:${resource.video_id}`
    const resources = resourcesByVideo.get(key) ?? []
    resources.push(resource)
    resourcesByVideo.set(key, resources)
  }

  const plans: VideoResourceBatchRemovalPlan[] = []
  for (const affected of resourcesByVideo.values()) {
    const { library_id: libraryId, video_id: videoId } = affected[0]
    const affectedIds = new Set(affected.map((resource) => resource.id))
    const resources = listVideoResources(libraryId, videoId)
    const removesPrimary = affected.some((resource) => resource.is_primary === 1)
    const remaining = resources.filter((resource) => !affectedIds.has(resource.id))
    const promoted = removesPrimary
      ? selectPrimaryVideoResourceCandidate(remaining, fs.existsSync)
      : null
    plans.push({
      libraryId,
      videoId,
      resourceIds: [...affectedIds],
      promotedResourceId: promoted?.id ?? null
    })
  }

  const result = removeSourceManagedVideoResourcesBatch(plans)
  const timestamp = new Date().toISOString()
  const affectedLibraries = new Set<number>()
  for (const job of jobs) {
    database
      .prepare('DELETE FROM pending_scan_resources WHERE library_id = ? AND root_id = ?')
      .run(job.library_id, job.root_id)
    database
      .prepare('DELETE FROM pending_resource_identities WHERE library_id = ? AND root_id = ?')
      .run(job.library_id, job.root_id)
    database
      .prepare('DELETE FROM library_unrecognized_files WHERE library_id = ? AND root_id = ?')
      .run(job.library_id, job.root_id)
    database
      .prepare(
        `DELETE FROM pending_scan_groups
          WHERE library_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM pending_scan_resources resource
               WHERE resource.library_id = pending_scan_groups.library_id
                 AND resource.group_id = pending_scan_groups.id
            )`
      )
      .run(job.library_id)
    const rootUpdate = database
      .prepare(
        `UPDATE media_library_roots
            SET state = 'disabled', updated_at = ?
          WHERE id = ? AND library_id = ? AND state = 'pending_removal'`
      )
      .run(timestamp, job.root_id, job.library_id)
    if (rootUpdate.changes !== 1) throw new Error('根目录清理状态已变化')
    const jobUpdate = database
      .prepare(
        `UPDATE library_root_cleanup_jobs
            SET state = 'completed', started_at = COALESCE(started_at, ?),
                completed_at = ?, last_error = NULL
          WHERE id = ? AND library_id = ? AND root_id = ? AND state = 'pending'`
      )
      .run(timestamp, timestamp, job.id, job.library_id, job.root_id)
    if (jobUpdate.changes !== 1) throw new Error('根目录清理任务状态已变化')
    affectedLibraries.add(job.library_id)
  }
  for (const libraryId of affectedLibraries) {
    database
      .prepare('UPDATE media_libraries SET revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(timestamp, libraryId)
  }

  return {
    ...result,
    consumedRoots: jobs.map((job) => ({ libraryId: job.library_id, rootId: job.root_id }))
  }
}

export function applyPendingLibraryPathCleanups(
  cleanups: PendingLibraryPathCleanup[]
): PendingLibraryPathCleanupResult {
  return getDb().transaction(() => applyPendingLibraryPathCleanupsInTransaction(cleanups))()
}

export function consumePendingLibraryPathCleanups(
  libraryId: number
): PendingLibraryPathCleanupResult {
  const cleanups = listPendingLibraryPathCleanupRoots(libraryId)
  return runLibraryScanCleanupTransaction(() => applyPendingLibraryPathCleanups(cleanups))
}
