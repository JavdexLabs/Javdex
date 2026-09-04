import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  MediaLibraryRoot,
  MediaLibraryRootMigrationPreview,
  MediaLibraryRootMigrationResult,
  MigrateMediaLibraryRootInput
} from '@shared/mediaLibraryTypes'
import { LEGACY_CLEANUP_WAITING_ERROR } from '@shared/legacyLibraryCleanup'
import {
  mediaLibraryRootIdentitiesOverlap,
  type ResolvedMediaLibraryRootPath
} from '@shared/mediaLibraryRootPath'
import { discoveryKeyForMembership } from './libraryMembershipRepo'
import { MediaLibraryRepoError } from './mediaLibraryRepo'
import { selectLibraryVideoResourcePromotionCandidate } from './videoResourcePromotionRepo'

interface LibraryRow {
  id: number
  name: string
  status: 'active' | 'archived'
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
  position: number
  state: 'active' | 'pending_removal' | 'disabled' | 'archived'
  created_at: string
  updated_at: string
}

interface ResourceRow {
  id: number
  video_id: number
  resource_key: string
  is_primary: 0 | 1
  add_time: string
}

interface PendingGroupRow {
  id: number
  normalized_code: string
  created_at: string
}

interface MigrationCountsRow {
  resource_count: number
  video_count: number
  target_memberships_to_create: number
  source_memberships_becoming_resource_less: number
  pending_scan_group_count: number
  pending_scan_resource_count: number
  target_pending_groups_to_merge: number
  unrecognized_file_count: number
  source_primary_resources_to_promote: number
}

export interface MediaLibraryRootMigrationRepo {
  preview(input: {
    sourceLibraryId: number
    targetLibraryId: number
    rootId: number
  }): MediaLibraryRootMigrationPreview
  migrate(input: MigrateMediaLibraryRootInput): MediaLibraryRootMigrationResult
}

function positiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MediaLibraryRepoError('VALIDATION_FAILED', `${label}必须是正整数。`)
  }
  return value
}

function requireDifferentLibraries(sourceLibraryId: number, targetLibraryId: number): void {
  if (sourceLibraryId === targetLibraryId) {
    throw new MediaLibraryRepoError('VALIDATION_FAILED', '源媒体库与目标媒体库不能相同。')
  }
}

function requireActiveLibrary(database: Database.Database, libraryId: number): LibraryRow {
  const row = database
    .prepare('SELECT id, name, status, revision FROM media_libraries WHERE id = ?')
    .get(libraryId) as LibraryRow | undefined
  if (!row) throw new MediaLibraryRepoError('LIBRARY_NOT_FOUND', '媒体库不存在。')
  if (row.status !== 'active') {
    throw new MediaLibraryRepoError('LIBRARY_ARCHIVED', '已归档媒体库不能迁移来源目录。')
  }
  return row
}

function requireMovableRoot(
  database: Database.Database,
  sourceLibraryId: number,
  rootId: number
): RootRow & { state: 'active' | 'disabled' } {
  const row = database
    .prepare('SELECT * FROM media_library_roots WHERE id = ? AND library_id = ?')
    .get(rootId, sourceLibraryId) as RootRow | undefined
  if (!row) throw new MediaLibraryRepoError('ROOT_NOT_FOUND', '来源目录不存在或不属于源媒体库。')
  if (row.state !== 'active' && row.state !== 'disabled') {
    throw new MediaLibraryRepoError(
      'VALIDATION_FAILED',
      '仅能迁移已启用或已停用的来源目录。'
    )
  }
  return row as RootRow & { state: 'active' | 'disabled' }
}

function rootIdentity(row: RootRow): ResolvedMediaLibraryRootPath {
  return {
    path: row.path,
    normalizedPath: row.normalized_path,
    realPath: row.real_path,
    normalizedRealPath: row.normalized_real_path,
    deviceId: row.device_id,
    inode: row.inode
  }
}

function hydrateRoot(row: RootRow): MediaLibraryRoot {
  return {
    id: row.id,
    libraryId: row.library_id,
    path: row.path,
    normalizedPath: row.normalized_path,
    realPath: row.real_path,
    normalizedRealPath: row.normalized_real_path,
    deviceId: row.device_id,
    inode: row.inode,
    position: row.position,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function assertLibrariesIdle(
  database: Database.Database,
  sourceLibraryId: number,
  targetLibraryId: number
): void {
  const busy = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM library_scan_runs
           WHERE library_id IN (?, ?) AND status IN ('queued', 'running')) AS scan_count,
         (SELECT COUNT(*) FROM library_root_cleanup_jobs
           WHERE library_id IN (?, ?)
             AND (
               state IN ('pending', 'running')
               OR (state = 'failed' AND last_error = ?)
             )) AS cleanup_count`
    )
    .get(
      sourceLibraryId,
      targetLibraryId,
      sourceLibraryId,
      targetLibraryId,
      LEGACY_CLEANUP_WAITING_ERROR
    ) as { scan_count: number; cleanup_count: number }
  if (busy.scan_count > 0 || busy.cleanup_count > 0) {
    throw new MediaLibraryRepoError(
      'LIBRARY_BUSY',
      '源媒体库或目标媒体库仍有扫描、待清理或正在清理的任务。'
    )
  }
}

function assertTargetRootAvailable(
  database: Database.Database,
  root: RootRow
): void {
  if (root.state !== 'active') return
  const candidates = database
    .prepare(
      `SELECT candidate.*
         FROM media_library_roots candidate
         JOIN media_libraries library ON library.id = candidate.library_id
        WHERE candidate.id != ?
          AND candidate.state IN ('active', 'pending_removal')
          AND library.status = 'active'`
    )
    .all(root.id) as RootRow[]
  const conflict = candidates.find((candidate) =>
    mediaLibraryRootIdentitiesOverlap(rootIdentity(root), rootIdentity(candidate))
  )
  if (!conflict) return
  throw new MediaLibraryRepoError(
    'ROOT_OVERLAP',
    `来源目录“${root.path}”与媒体库 #${conflict.library_id} 的“${conflict.path}”重叠。`,
    {
      conflict: {
        rootId: conflict.id,
        libraryId: conflict.library_id,
        path: conflict.path
      }
    }
  )
}

function assertNoTargetDataConflicts(
  database: Database.Database,
  sourceLibraryId: number,
  targetLibraryId: number,
  rootId: number
): void {
  const duplicateResource = database
    .prepare(
      `SELECT moving.id
         FROM video_resources moving
         JOIN video_resources target
           ON target.library_id = ?
          AND (
            target.resource_key = moving.resource_key
            OR (
              moving.source_identity IS NOT NULL
              AND target.source_identity = moving.source_identity
            )
          )
        WHERE moving.library_id = ? AND moving.root_id = ?
        LIMIT 1`
    )
    .get(targetLibraryId, sourceLibraryId, rootId)
  if (duplicateResource) {
    throw new MediaLibraryRepoError(
      'VALIDATION_FAILED',
      '目标媒体库已存在与该目录等价的影片资源。'
    )
  }
  const duplicateUnrecognized = database
    .prepare(
      `SELECT moving.normalized_path
         FROM library_unrecognized_files moving
         JOIN library_unrecognized_files target
           ON target.library_id = ? AND target.normalized_path = moving.normalized_path
        WHERE moving.library_id = ? AND moving.root_id = ?
        LIMIT 1`
    )
    .get(targetLibraryId, sourceLibraryId, rootId)
  if (duplicateUnrecognized) {
    throw new MediaLibraryRepoError(
      'VALIDATION_FAILED',
      '目标媒体库已存在该目录的未识别文件记录。'
    )
  }
  const duplicatePendingScanResource = database
    .prepare(
      `SELECT moving.normalized_path
         FROM pending_scan_resources moving
         JOIN pending_scan_resources target
           ON target.library_id = ?
          AND target.normalized_path = moving.normalized_path
        WHERE moving.library_id = ? AND moving.root_id = ?
        LIMIT 1`
    )
    .get(targetLibraryId, sourceLibraryId, rootId)
  if (duplicatePendingScanResource) {
    throw new MediaLibraryRepoError(
      'VALIDATION_FAILED',
      '目标媒体库已存在同路径的待处理扫描资源。'
    )
  }
  const duplicatePendingIdentity = database
    .prepare(
      `SELECT moving.normalized_path
         FROM pending_resource_identities moving
         JOIN pending_resource_identities target
           ON target.library_id = ? AND target.normalized_path = moving.normalized_path
        WHERE moving.library_id = ? AND moving.root_id = ?
        LIMIT 1`
    )
    .get(targetLibraryId, sourceLibraryId, rootId)
  if (duplicatePendingIdentity) {
    throw new MediaLibraryRepoError(
      'VALIDATION_FAILED',
      '目标媒体库已存在同路径的资源身份待办。'
    )
  }
}

function readCounts(
  database: Database.Database,
  sourceLibraryId: number,
  targetLibraryId: number,
  rootId: number
): MigrationCountsRow {
  return database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM video_resources
          WHERE library_id = @sourceLibraryId AND root_id = @rootId) AS resource_count,
        (SELECT COUNT(DISTINCT video_id) FROM video_resources
          WHERE library_id = @sourceLibraryId AND root_id = @rootId) AS video_count,
        (SELECT COUNT(DISTINCT moving.video_id)
           FROM video_resources moving
          WHERE moving.library_id = @sourceLibraryId AND moving.root_id = @rootId
            AND NOT EXISTS (
              SELECT 1 FROM library_video_memberships target_membership
               WHERE target_membership.library_id = @targetLibraryId
                 AND target_membership.video_id = moving.video_id
            )) AS target_memberships_to_create,
        (SELECT COUNT(DISTINCT moving.video_id)
           FROM video_resources moving
          WHERE moving.library_id = @sourceLibraryId AND moving.root_id = @rootId
            AND NOT EXISTS (
              SELECT 1 FROM video_resources remaining
               WHERE remaining.library_id = @sourceLibraryId
                 AND remaining.video_id = moving.video_id
                 AND (remaining.root_id IS NULL OR remaining.root_id != @rootId)
            )) AS source_memberships_becoming_resource_less,
        (SELECT COUNT(DISTINCT group_id) FROM pending_scan_resources
          WHERE library_id = @sourceLibraryId AND root_id = @rootId) +
        (SELECT COUNT(*) FROM pending_resource_identities
          WHERE library_id = @sourceLibraryId AND root_id = @rootId)
          AS pending_scan_group_count,
        (SELECT COUNT(*) FROM pending_scan_resources
          WHERE library_id = @sourceLibraryId AND root_id = @rootId) +
        (SELECT COUNT(*) FROM pending_resource_identities
          WHERE library_id = @sourceLibraryId AND root_id = @rootId)
          AS pending_scan_resource_count,
        (SELECT COUNT(DISTINCT source_group.id)
           FROM pending_scan_groups source_group
           JOIN pending_scan_resources resource
             ON resource.group_id = source_group.id
            AND resource.library_id = source_group.library_id
           JOIN pending_scan_groups target_group
             ON target_group.library_id = @targetLibraryId
            AND target_group.normalized_code = source_group.normalized_code
          WHERE source_group.library_id = @sourceLibraryId
            AND resource.root_id = @rootId) AS target_pending_groups_to_merge,
        (SELECT COUNT(*) FROM library_unrecognized_files
          WHERE library_id = @sourceLibraryId AND root_id = @rootId)
          AS unrecognized_file_count,
        (SELECT COUNT(DISTINCT moving.video_id)
           FROM video_resources moving
          WHERE moving.library_id = @sourceLibraryId
            AND moving.root_id = @rootId
            AND moving.is_primary = 1
            AND EXISTS (
              SELECT 1 FROM video_resources remaining
               WHERE remaining.library_id = @sourceLibraryId
                 AND remaining.video_id = moving.video_id
                 AND (remaining.root_id IS NULL OR remaining.root_id != @rootId)
            )) AS source_primary_resources_to_promote`
    )
    .get({ sourceLibraryId, targetLibraryId, rootId }) as MigrationCountsRow
}

function readImpactRevision(
  database: Database.Database,
  sourceLibraryId: number,
  targetLibraryId: number
): string {
  const snapshots = [
    `SELECT * FROM video_resources
      WHERE library_id IN (@sourceLibraryId, @targetLibraryId) ORDER BY library_id, id`,
    `SELECT * FROM library_video_memberships
      WHERE library_id IN (@sourceLibraryId, @targetLibraryId) ORDER BY library_id, video_id`,
    `SELECT * FROM pending_scan_groups
      WHERE library_id IN (@sourceLibraryId, @targetLibraryId) ORDER BY library_id, id`,
    `SELECT * FROM pending_scan_resources
      WHERE library_id IN (@sourceLibraryId, @targetLibraryId) ORDER BY library_id, id`,
    `SELECT * FROM pending_resource_identities
      WHERE library_id IN (@sourceLibraryId, @targetLibraryId) ORDER BY library_id, id`,
    `SELECT * FROM library_unrecognized_files
      WHERE library_id IN (@sourceLibraryId, @targetLibraryId)
      ORDER BY library_id, normalized_path`,
    `SELECT * FROM library_root_cleanup_jobs
      WHERE library_id IN (@sourceLibraryId, @targetLibraryId)
      ORDER BY library_id, id`
  ].map((sql) =>
    database.prepare(sql).all({ sourceLibraryId, targetLibraryId })
  )
  return createHash('sha256').update(JSON.stringify(snapshots)).digest('hex')
}

function readPreview(
  database: Database.Database,
  input: { sourceLibraryId: number; targetLibraryId: number; rootId: number }
): MediaLibraryRootMigrationPreview {
  const sourceLibraryId = positiveId(input.sourceLibraryId, '源媒体库 ID')
  const targetLibraryId = positiveId(input.targetLibraryId, '目标媒体库 ID')
  const rootId = positiveId(input.rootId, '来源目录 ID')
  requireDifferentLibraries(sourceLibraryId, targetLibraryId)
  const source = requireActiveLibrary(database, sourceLibraryId)
  const target = requireActiveLibrary(database, targetLibraryId)
  const root = requireMovableRoot(database, sourceLibraryId, rootId)
  assertLibrariesIdle(database, sourceLibraryId, targetLibraryId)
  assertTargetRootAvailable(database, root)
  assertNoTargetDataConflicts(database, sourceLibraryId, targetLibraryId, rootId)
  const counts = readCounts(database, sourceLibraryId, targetLibraryId, rootId)
  return {
    sourceLibraryId,
    sourceLibraryName: source.name,
    sourceRevision: source.revision,
    targetLibraryId,
    targetLibraryName: target.name,
    targetRevision: target.revision,
    impactRevision: readImpactRevision(database, sourceLibraryId, targetLibraryId),
    rootId,
    rootPath: root.path,
    rootState: root.state,
    resourceCount: counts.resource_count,
    videoCount: counts.video_count,
    targetMembershipsToCreate: counts.target_memberships_to_create,
    sourceMembershipsBecomingResourceLess: counts.source_memberships_becoming_resource_less,
    pendingScanGroupCount: counts.pending_scan_group_count,
    pendingScanResourceCount: counts.pending_scan_resource_count,
    targetPendingGroupsToMerge: counts.target_pending_groups_to_merge,
    unrecognizedFileCount: counts.unrecognized_file_count,
    sourcePrimaryResourcesToPromote: counts.source_primary_resources_to_promote,
    sourceFilesPreserved: true
  }
}

function insertTargetRoot(
  database: Database.Database,
  root: RootRow,
  targetLibraryId: number,
  timestamp: string
): number {
  if (root.state === 'active') {
    database
      .prepare(
        `UPDATE media_library_roots
            SET state = 'disabled', updated_at = ?
          WHERE id = ? AND library_id = ? AND state = 'active'`
      )
      .run(timestamp, root.id, root.library_id)
  }
  const position = (
    database
      .prepare(
        `SELECT COALESCE(MAX(position), -1) + 1 AS value
           FROM media_library_roots WHERE library_id = ?`
      )
      .get(targetLibraryId) as { value: number }
  ).value
  return Number(
    database
      .prepare(
        `INSERT INTO media_library_roots (
           library_id, path, normalized_path, real_path, normalized_real_path,
           device_id, inode, position, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        targetLibraryId,
        root.path,
        root.normalized_path,
        root.real_path,
        root.normalized_real_path,
        root.device_id,
        root.inode,
        position,
        root.state,
        timestamp,
        timestamp
      ).lastInsertRowid
  )
}

function movePendingScanResources(
  database: Database.Database,
  sourceLibraryId: number,
  targetLibraryId: number,
  sourceRootId: number,
  targetRootId: number,
  timestamp: string
): number {
  const groups = database
    .prepare(
      `SELECT DISTINCT source_group.id, source_group.normalized_code, source_group.created_at
         FROM pending_scan_groups source_group
         JOIN pending_scan_resources resource
           ON resource.group_id = source_group.id
          AND resource.library_id = source_group.library_id
        WHERE source_group.library_id = ? AND resource.root_id = ?
        ORDER BY source_group.id`
    )
    .all(sourceLibraryId, sourceRootId) as PendingGroupRow[]
  let moved = 0
  for (const group of groups) {
    let targetGroup = database
      .prepare(
        `SELECT id FROM pending_scan_groups
          WHERE library_id = ? AND normalized_code = ?`
      )
      .get(targetLibraryId, group.normalized_code) as { id: number } | undefined
    const targetGroupExisted = Boolean(targetGroup)
    if (!targetGroup) {
      targetGroup = {
        id: Number(
          database
            .prepare(
              `INSERT INTO pending_scan_groups (
                 library_id, normalized_code, revision, created_at, updated_at
               ) VALUES (?, ?, 1, ?, ?)`
            )
            .run(targetLibraryId, group.normalized_code, group.created_at, timestamp)
            .lastInsertRowid
        )
      }
    }
    const changed = database
      .prepare(
        `UPDATE pending_scan_resources
            SET library_id = ?, group_id = ?, root_id = ?, updated_at = ?
          WHERE library_id = ? AND group_id = ? AND root_id = ?`
      )
      .run(
        targetLibraryId,
        targetGroup.id,
        targetRootId,
        timestamp,
        sourceLibraryId,
        group.id,
        sourceRootId
      ).changes
    moved += changed
    if (changed > 0 && targetGroupExisted) {
      database
        .prepare(
          `UPDATE pending_scan_groups
              SET revision = revision + 1, updated_at = ?
            WHERE id = ? AND library_id = ?`
        )
        .run(timestamp, targetGroup.id, targetLibraryId)
    }
    const sourceHasResources = database
      .prepare(
        `SELECT 1 FROM pending_scan_resources
          WHERE library_id = ? AND group_id = ? LIMIT 1`
      )
      .get(sourceLibraryId, group.id)
    if (sourceHasResources) {
      database
        .prepare(
          `UPDATE pending_scan_groups
              SET revision = revision + 1, updated_at = ?
            WHERE id = ? AND library_id = ?`
        )
        .run(timestamp, group.id, sourceLibraryId)
    } else {
      database
        .prepare('DELETE FROM pending_scan_groups WHERE id = ? AND library_id = ?')
        .run(group.id, sourceLibraryId)
    }
  }
  return moved
}

function moveUnrecognizedFiles(
  database: Database.Database,
  sourceLibraryId: number,
  targetLibraryId: number,
  sourceRootId: number,
  targetRootId: number,
  timestamp: string
): number {
  const count = (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM library_unrecognized_files
          WHERE library_id = ? AND root_id = ?`
      )
      .get(sourceLibraryId, sourceRootId) as { count: number }
  ).count
  if (count === 0) return 0
  const configRevision = (
    database
      .prepare('SELECT revision FROM media_library_configs WHERE library_id = ?')
      .get(targetLibraryId) as { revision: number }
  ).revision
  const migrationRunId = `root-migration:${randomUUID()}`
  database
    .prepare(
      `INSERT INTO library_scan_runs (
         id, library_id, config_revision, trigger, status, started_at, finished_at
       ) VALUES (?, ?, ?, 'root', 'completed', ?, ?)`
    )
    .run(
      migrationRunId,
      targetLibraryId,
      configRevision,
      timestamp,
      timestamp
    )
  database
    .prepare(
      `UPDATE library_unrecognized_files
          SET library_id = ?, root_id = ?, scan_run_id = ?
        WHERE library_id = ? AND root_id = ?`
    )
    .run(targetLibraryId, targetRootId, migrationRunId, sourceLibraryId, sourceRootId)
  return count
}

function movePendingResourceIdentities(
  database: Database.Database,
  sourceLibraryId: number,
  targetLibraryId: number,
  sourceRootId: number,
  targetRootId: number,
  timestamp: string
): number {
  return database
    .prepare(
      `UPDATE pending_resource_identities
          SET library_id = ?, root_id = ?, revision = revision + 1, updated_at = ?
        WHERE library_id = ? AND root_id = ?`
    )
    .run(targetLibraryId, targetRootId, timestamp, sourceLibraryId, sourceRootId).changes
}

function moveHistoricalCleanupJobs(
  database: Database.Database,
  sourceLibraryId: number,
  targetLibraryId: number,
  sourceRootId: number,
  targetRootId: number
): void {
  database
    .prepare(
      `UPDATE library_root_cleanup_jobs
          SET library_id = ?, root_id = ?
        WHERE library_id = ? AND root_id = ?
          AND state IN ('completed', 'failed', 'cancelled')`
    )
    .run(targetLibraryId, targetRootId, sourceLibraryId, sourceRootId)
}

function bumpRevision(
  database: Database.Database,
  libraryId: number,
  expectedRevision: number,
  timestamp: string
): void {
  const changed = database
    .prepare(
      `UPDATE media_libraries
          SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'active'`
    )
    .run(timestamp, libraryId, expectedRevision).changes
  if (changed !== 1) {
    throw new MediaLibraryRepoError(
      'REVISION_CONFLICT',
      '媒体库已被其它操作更新，请重新预览后重试。'
    )
  }
}

export function createMediaLibraryRootMigrationRepo(
  database: Database.Database,
  dependencies: { isLocalAccessible: (path: string) => boolean }
): MediaLibraryRootMigrationRepo {
  const { isLocalAccessible } = dependencies
  return {
    preview(input) {
      return database.transaction(() => readPreview(database, input))()
    },

    migrate(input) {
      return database.transaction(() => {
        const preview = readPreview(database, input)
        if (
          preview.sourceRevision !== input.expectedSourceRevision ||
          preview.targetRevision !== input.expectedTargetRevision ||
          preview.impactRevision !== input.expectedImpactRevision
        ) {
          throw new MediaLibraryRepoError(
            'REVISION_CONFLICT',
            '来源目录迁移预览已过期，请刷新后重试。'
          )
        }

        const root = requireMovableRoot(database, input.sourceLibraryId, input.rootId)
        const timestamp = new Date().toISOString()
        const movedResources = database
          .prepare(
            `SELECT id, video_id, resource_key, is_primary, add_time
               FROM video_resources
              WHERE library_id = ? AND root_id = ?
              ORDER BY id`
          )
          .all(input.sourceLibraryId, input.rootId) as ResourceRow[]
        const movedVideoIds = [...new Set(movedResources.map((resource) => resource.video_id))]
        const originallyPrimaryVideoIds = [
          ...new Set(
            movedResources
              .filter((resource) => Boolean(resource.is_primary))
              .map((resource) => resource.video_id)
          )
        ]
        const targetRootId = insertTargetRoot(
          database,
          root,
          input.targetLibraryId,
          timestamp
        )

        let createdMembershipCount = 0
        const insertMembership = database.prepare(
          `INSERT OR IGNORE INTO library_video_memberships (
             library_id, video_id, added_at, updated_at, added_via,
             is_pinned, is_hidden, discovery_key
           ) VALUES (?, ?, ?, ?, 'shared', 0, 0, ?)`
        )
        for (const videoId of movedVideoIds) {
          createdMembershipCount += insertMembership.run(
            input.targetLibraryId,
            videoId,
            timestamp,
            timestamp,
            discoveryKeyForMembership(input.targetLibraryId, videoId)
          ).changes
          const targetHasPrimary = database
            .prepare(
              `SELECT 1 FROM video_resources
                WHERE library_id = ? AND video_id = ? AND is_primary = 1
                LIMIT 1`
            )
            .get(input.targetLibraryId, videoId)
          if (targetHasPrimary) {
            database
              .prepare(
                `UPDATE video_resources SET is_primary = 0
                  WHERE library_id = ? AND root_id = ? AND video_id = ?`
              )
              .run(input.sourceLibraryId, input.rootId, videoId)
          }
        }

        const movedResourceCount = database
          .prepare(
            `UPDATE video_resources
                SET library_id = ?, root_id = ?
              WHERE library_id = ? AND root_id = ?`
          )
          .run(
            input.targetLibraryId,
            targetRootId,
            input.sourceLibraryId,
            input.rootId
          ).changes

        const promotedSourceResourceIds: number[] = []
        for (const videoId of originallyPrimaryVideoIds) {
          const candidate = selectLibraryVideoResourcePromotionCandidate(database, {
            libraryId: input.sourceLibraryId,
            videoId,
            isLocalAccessible
          })
          if (!candidate) continue
          database
            .prepare('UPDATE video_resources SET is_primary = 1 WHERE id = ?')
            .run(candidate.id)
          promotedSourceResourceIds.push(candidate.id)
        }

        const movedPendingScanResourceCount = movePendingScanResources(
          database,
          input.sourceLibraryId,
          input.targetLibraryId,
          input.rootId,
          targetRootId,
          timestamp
        ) + movePendingResourceIdentities(
          database,
          input.sourceLibraryId,
          input.targetLibraryId,
          input.rootId,
          targetRootId,
          timestamp
        )
        const movedUnrecognizedFileCount = moveUnrecognizedFiles(
          database,
          input.sourceLibraryId,
          input.targetLibraryId,
          input.rootId,
          targetRootId,
          timestamp
        )
        moveHistoricalCleanupJobs(
          database,
          input.sourceLibraryId,
          input.targetLibraryId,
          input.rootId,
          targetRootId
        )
        const removedRoot = database
          .prepare('DELETE FROM media_library_roots WHERE id = ? AND library_id = ?')
          .run(input.rootId, input.sourceLibraryId).changes
        if (removedRoot !== 1) {
          throw new MediaLibraryRepoError('ROOT_NOT_FOUND', '来源目录在迁移期间已发生变化。')
        }
        bumpRevision(
          database,
          input.sourceLibraryId,
          input.expectedSourceRevision,
          timestamp
        )
        bumpRevision(
          database,
          input.targetLibraryId,
          input.expectedTargetRevision,
          timestamp
        )
        const targetRoot = database
          .prepare('SELECT * FROM media_library_roots WHERE id = ? AND library_id = ?')
          .get(targetRootId, input.targetLibraryId) as RootRow | undefined
        if (!targetRoot) throw new MediaLibraryRepoError('ROOT_NOT_FOUND', '目标来源目录创建失败。')
        return {
          sourceLibraryId: input.sourceLibraryId,
          targetLibraryId: input.targetLibraryId,
          previousRootId: input.rootId,
          targetRoot: hydrateRoot(targetRoot),
          movedResourceCount,
          createdMembershipCount,
          movedPendingScanResourceCount,
          movedUnrecognizedFileCount,
          promotedSourceResourceIds,
          sourceFilesPreserved: true as const
        }
      }).immediate()
    }
  }
}
