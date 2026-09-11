import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  LEGACY_CLEANUP_JOB_ID_PATTERN,
  LEGACY_CLEANUP_WAITING_ERROR
} from '@shared/legacyLibraryCleanup'
import {
  DEFAULT_MEDIA_LIBRARY_CONFIG,
  DEFAULT_MEDIA_LIBRARY_ID,
  MEDIA_LIBRARY_COLORS,
  MEDIA_LIBRARY_DEFAULT_SORTS,
  MEDIA_LIBRARY_ICONS,
  MEDIA_LIBRARY_ROOT_EDITABLE_STATES,
  MEDIA_LIBRARY_SORT_DIRECTIONS,
  type CreateMediaLibraryInput,
  type CreateMediaLibraryRootInput,
  type MediaLibrary,
  type MediaLibraryAutomaticScanState,
  type MediaLibraryConfig,
  type MediaLibraryConfigPatch,
  type MediaLibraryConfigValues,
  type MediaLibraryDeletePreview,
  type MediaLibraryDetail,
  type MediaLibraryErrorCode,
  type MediaLibraryPatch,
  type MediaLibraryRoot,
  type MediaLibraryRootConflict,
  type MediaLibraryRootEditableState,
  type MediaLibraryRootPatch,
  type MediaLibraryRootState,
  type MediaLibraryScanSnapshot,
  type MediaLibraryStatus,
  type MediaLibrarySummary
} from '@shared/mediaLibraryTypes'
import {
  mediaLibraryRootIdentitiesOverlap,
  resolveMediaLibraryRootIdentity,
  type ResolvedMediaLibraryRootPath
} from '@shared/mediaLibraryRootPath'
import { getDb } from './database'

const MANAGED_ROOT_STATES = ['active', 'pending_removal'] as const

interface MediaLibraryRow {
  id: number
  name: string
  icon: MediaLibrary['icon']
  color: MediaLibrary['color']
  position: number
  status: MediaLibraryStatus
  is_default: 0 | 1
  revision: number
  created_at: string
  updated_at: string
}

interface MediaLibraryConfigRow {
  library_id: number
  auto_scan_enabled: 0 | 1
  auto_scan_interval_minutes: number
  min_import_duration_minutes: number
  auto_merge_same_code_resources: 0 | 1
  auto_import_local_nfo: 0 | 1
  remove_resource_less_memberships: 0 | 1
  default_video_scraper: string | null
  default_sort_by: MediaLibraryConfig['defaultSortBy']
  default_sort_dir: MediaLibraryConfig['defaultSortDir']
  include_in_home_discovery: 0 | 1
  revision: number
}

interface MediaLibraryRootRow {
  id: number
  library_id: number
  path: string
  normalized_path: string
  real_path: string | null
  normalized_real_path: string | null
  device_id: string | null
  inode: string | null
  position: number
  state: MediaLibraryRootState
  created_at: string
  updated_at: string
}

interface MediaLibrarySummaryRow {
  id: number
  name: string
  icon: MediaLibrary['icon']
  color: MediaLibrary['color']
  position: number
  status: MediaLibraryStatus
  is_default: 0 | 1
  library_revision: number
  created_at: string
  updated_at: string
  auto_scan_enabled: 0 | 1
  auto_scan_interval_minutes: number
  min_import_duration_minutes: number
  auto_merge_same_code_resources: 0 | 1
  auto_import_local_nfo: 0 | 1
  remove_resource_less_memberships: 0 | 1
  default_video_scraper: string | null
  default_sort_by: MediaLibraryConfig['defaultSortBy']
  default_sort_dir: MediaLibraryConfig['defaultSortDir']
  include_in_home_discovery: 0 | 1
  config_revision: number
  root_count: number
  active_root_count: number
  pending_removal_root_count: number
  pending_cleanup_job_count: number
  pending_scan_group_count: number
  disabled_root_count: number
  archived_root_count: number
}

interface MediaLibraryDeletePreviewRow {
  root_count: number
  membership_count: number
  resource_count: number
  exclusive_video_count: number
  pending_scan_group_count: number
  pending_scan_resource_count: number
  scan_run_count: number
  active_scan_run_count: number
  unrecognized_file_count: number
  cleanup_job_count: number
  active_cleanup_job_count: number
}

interface PreparedRoot extends ResolvedMediaLibraryRootPath {
  position: number
  state: MediaLibraryRootEditableState
}

const LEGACY_CLEANUP_QUERY_PARAMETERS = {
  legacyCleanupJobIdPattern: LEGACY_CLEANUP_JOB_ID_PATTERN,
  legacyCleanupWaitingError: LEGACY_CLEANUP_WAITING_ERROR
} as const

const SUMMARY_SELECT_SQL = `
  SELECT
    library.id,
    library.name,
    library.icon,
    library.color,
    library.position,
    library.status,
    library.is_default,
    library.revision AS library_revision,
    library.created_at,
    library.updated_at,
    config.auto_scan_enabled,
    config.auto_scan_interval_minutes,
    config.min_import_duration_minutes,
    config.auto_merge_same_code_resources,
    config.auto_import_local_nfo,
    config.remove_resource_less_memberships,
    config.default_video_scraper,
    config.default_sort_by,
    config.default_sort_dir,
    config.include_in_home_discovery,
    config.revision AS config_revision,
    COUNT(root.id) AS root_count,
    COALESCE(SUM(CASE WHEN root.state = 'active' THEN 1 ELSE 0 END), 0) AS active_root_count,
    COALESCE(SUM(CASE WHEN root.state = 'pending_removal' THEN 1 ELSE 0 END), 0)
      AS pending_removal_root_count,
    (SELECT COUNT(*)
       FROM library_root_cleanup_jobs cleanup
      WHERE cleanup.library_id = library.id
        AND (
          cleanup.state = 'pending' OR (
            cleanup.state = 'failed'
            AND cleanup.id LIKE @legacyCleanupJobIdPattern
            AND cleanup.last_error = @legacyCleanupWaitingError
          )
        ))
      AS pending_cleanup_job_count,
    (SELECT COUNT(*)
       FROM pending_scan_groups pending_group
      WHERE pending_group.library_id = library.id) +
    (SELECT COUNT(*)
       FROM pending_resource_identities pending_identity
      WHERE pending_identity.library_id = library.id)
      AS pending_scan_group_count,
    COALESCE(SUM(CASE WHEN root.state = 'disabled' THEN 1 ELSE 0 END), 0)
      AS disabled_root_count,
    COALESCE(SUM(CASE WHEN root.state = 'archived' THEN 1 ELSE 0 END), 0)
      AS archived_root_count
  FROM media_libraries library
  JOIN media_library_configs config ON config.library_id = library.id
  LEFT JOIN media_library_roots root ON root.library_id = library.id
`

export class MediaLibraryRepoError extends Error {
  readonly conflict?: MediaLibraryRootConflict
  readonly currentRevision?: number

  constructor(
    readonly code: MediaLibraryErrorCode,
    message: string,
    options: {
      conflict?: MediaLibraryRootConflict
      currentRevision?: number
    } = {}
  ) {
    super(message)
    this.name = 'MediaLibraryRepoError'
    this.conflict = options.conflict
    this.currentRevision = options.currentRevision
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function includesValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function validationError(message: string): never {
  throw new MediaLibraryRepoError('VALIDATION_FAILED', message)
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) validationError(`${label}必须是正整数。`)
}

function assertRevision(value: number): void {
  assertPositiveInteger(value, 'revision')
}

function normalizePosition(value: number, label = 'position'): number {
  if (!Number.isInteger(value) || value < 0) validationError(`${label}必须是非负整数。`)
  return value
}

function normalizeLibraryName(value: string): string {
  if (typeof value !== 'string') validationError('媒体库名称必须是字符串。')
  const name = value.trim()
  if (!name) validationError('媒体库名称不能为空。')
  return name
}

function normalizeScraper(value: string | null): string | null {
  if (value === null) return null
  if (typeof value !== 'string') validationError('默认刮削器必须是字符串或 null。')
  return value.trim() || null
}

function normalizeConfigPatch(input: MediaLibraryConfigPatch): MediaLibraryConfigPatch {
  const patch: MediaLibraryConfigPatch = {}

  if (input.autoScanEnabled !== undefined) {
    if (typeof input.autoScanEnabled !== 'boolean') validationError('自动扫描开关必须是布尔值。')
    patch.autoScanEnabled = input.autoScanEnabled
  }
  if (input.autoScanIntervalMinutes !== undefined) {
    const value = input.autoScanIntervalMinutes
    if (!Number.isInteger(value) || value < 5 || value > 10080) {
      validationError('自动扫描周期必须是 5 到 10080 分钟之间的整数。')
    }
    patch.autoScanIntervalMinutes = value
  }
  if (input.minImportDurationMinutes !== undefined) {
    const value = input.minImportDurationMinutes
    if (!Number.isInteger(value) || value < 0 || value > 1440) {
      validationError('最小时长必须是 0 到 1440 分钟之间的整数。')
    }
    patch.minImportDurationMinutes = value
  }
  if (input.autoMergeSameCodeResources !== undefined) {
    if (typeof input.autoMergeSameCodeResources !== 'boolean') {
      validationError('同番号自动归并开关必须是布尔值。')
    }
    patch.autoMergeSameCodeResources = input.autoMergeSameCodeResources
  }
  if (input.autoImportLocalNfo !== undefined) {
    if (typeof input.autoImportLocalNfo !== 'boolean') {
      validationError('本地 NFO 自动导入开关必须是布尔值。')
    }
    patch.autoImportLocalNfo = input.autoImportLocalNfo
  }
  if (input.removeResourceLessMemberships !== undefined) {
    if (typeof input.removeResourceLessMemberships !== 'boolean') {
      validationError('无资源成员清理开关必须是布尔值。')
    }
    patch.removeResourceLessMemberships = input.removeResourceLessMemberships
  }
  if (input.defaultVideoScraper !== undefined) {
    patch.defaultVideoScraper = normalizeScraper(input.defaultVideoScraper)
  }
  if (input.defaultSortBy !== undefined) {
    if (!includesValue(MEDIA_LIBRARY_DEFAULT_SORTS, input.defaultSortBy)) {
      validationError('默认排序字段无效。')
    }
    patch.defaultSortBy = input.defaultSortBy
  }
  if (input.defaultSortDir !== undefined) {
    if (!includesValue(MEDIA_LIBRARY_SORT_DIRECTIONS, input.defaultSortDir)) {
      validationError('默认排序方向无效。')
    }
    patch.defaultSortDir = input.defaultSortDir
  }
  if (input.includeInHomeDiscovery !== undefined) {
    if (typeof input.includeInHomeDiscovery !== 'boolean') {
      validationError('首页发现开关必须是布尔值。')
    }
    patch.includeInHomeDiscovery = input.includeInHomeDiscovery
  }

  return patch
}

function normalizeConfigValues(input: MediaLibraryConfigPatch = {}): MediaLibraryConfigValues {
  return {
    ...DEFAULT_MEDIA_LIBRARY_CONFIG,
    ...normalizeConfigPatch(input)
  }
}

function assertEditableRootState(value: unknown): asserts value is MediaLibraryRootEditableState {
  if (!includesValue(MEDIA_LIBRARY_ROOT_EDITABLE_STATES, value)) {
    validationError('根目录状态无效。')
  }
}

function isForeignKeyConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; message?: unknown }
  return (
    String(candidate.code ?? '').startsWith('SQLITE_CONSTRAINT_FOREIGNKEY') ||
    String(candidate.message ?? '').includes('FOREIGN KEY constraint failed')
  )
}

/**
 * Resolve a user-supplied root without requiring it to be online. Lexical identity is
 * always present; filesystem identity is a best-effort snapshot and may be null.
 */
export function resolveMediaLibraryRootPath(
  inputPath: string
): ResolvedMediaLibraryRootPath {
  try {
    return resolveMediaLibraryRootIdentity(inputPath)
  } catch (error) {
    validationError((error as Error).message)
  }
}

function hydrateLibrary(row: MediaLibraryRow): MediaLibrary {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    position: row.position,
    status: row.status,
    isDefault: Boolean(row.is_default),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function hydrateConfig(row: MediaLibraryConfigRow): MediaLibraryConfig {
  return {
    libraryId: row.library_id,
    autoScanEnabled: Boolean(row.auto_scan_enabled),
    autoScanIntervalMinutes: row.auto_scan_interval_minutes,
    minImportDurationMinutes: row.min_import_duration_minutes,
    autoMergeSameCodeResources: Boolean(row.auto_merge_same_code_resources),
    autoImportLocalNfo: Boolean(row.auto_import_local_nfo),
    removeResourceLessMemberships: Boolean(row.remove_resource_less_memberships),
    defaultVideoScraper: row.default_video_scraper,
    defaultSortBy: row.default_sort_by,
    defaultSortDir: row.default_sort_dir,
    includeInHomeDiscovery: Boolean(row.include_in_home_discovery),
    revision: row.revision
  }
}

function hydrateRoot(row: MediaLibraryRootRow): MediaLibraryRoot {
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

function hydrateSummary(row: MediaLibrarySummaryRow): MediaLibrarySummary {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    position: row.position,
    status: row.status,
    isDefault: Boolean(row.is_default),
    revision: row.library_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config: hydrateConfig({
      library_id: row.id,
      auto_scan_enabled: row.auto_scan_enabled,
      auto_scan_interval_minutes: row.auto_scan_interval_minutes,
      min_import_duration_minutes: row.min_import_duration_minutes,
      auto_merge_same_code_resources: row.auto_merge_same_code_resources,
      auto_import_local_nfo: row.auto_import_local_nfo,
      remove_resource_less_memberships: row.remove_resource_less_memberships,
      default_video_scraper: row.default_video_scraper,
      default_sort_by: row.default_sort_by,
      default_sort_dir: row.default_sort_dir,
      include_in_home_discovery: row.include_in_home_discovery,
      revision: row.config_revision
    }),
    rootCount: row.root_count,
    activeRootCount: row.active_root_count,
    pendingRemovalRootCount: row.pending_removal_root_count,
    pendingCleanupJobCount: row.pending_cleanup_job_count,
    pendingScanGroupCount: row.pending_scan_group_count,
    disabledRootCount: row.disabled_root_count,
    archivedRootCount: row.archived_root_count
  }
}

function getLibraryRow(database: Database.Database, libraryId: number): MediaLibraryRow | null {
  assertPositiveInteger(libraryId, 'libraryId')
  return (
    (database.prepare('SELECT * FROM media_libraries WHERE id = ?').get(libraryId) as
      | MediaLibraryRow
      | undefined) ?? null
  )
}

function requireLibraryRow(database: Database.Database, libraryId: number): MediaLibraryRow {
  const row = getLibraryRow(database, libraryId)
  if (!row) throw new MediaLibraryRepoError('LIBRARY_NOT_FOUND', '媒体库不存在。')
  return row
}

function requireExpectedLibraryRevision(
  database: Database.Database,
  libraryId: number,
  expectedRevision: number
): MediaLibraryRow {
  assertRevision(expectedRevision)
  const row = requireLibraryRow(database, libraryId)
  if (row.revision !== expectedRevision) {
    throw new MediaLibraryRepoError('REVISION_CONFLICT', '媒体库已被其他操作更新，请刷新后重试。', {
      currentRevision: row.revision
    })
  }
  return row
}

function requireActiveLibrary(row: MediaLibraryRow): void {
  if (row.status !== 'active') {
    throw new MediaLibraryRepoError('LIBRARY_ARCHIVED', '已归档媒体库必须恢复后才能修改。')
  }
}

function getConfigRow(database: Database.Database, libraryId: number): MediaLibraryConfigRow | null {
  return (
    (database.prepare('SELECT * FROM media_library_configs WHERE library_id = ?').get(libraryId) as
      | MediaLibraryConfigRow
      | undefined) ?? null
  )
}

function requireConfigRow(database: Database.Database, libraryId: number): MediaLibraryConfigRow {
  const row = getConfigRow(database, libraryId)
  if (!row) {
    throw new MediaLibraryRepoError('VALIDATION_FAILED', '媒体库配置缺失，数据库状态不完整。')
  }
  return row
}

function getRootRow(
  database: Database.Database,
  libraryId: number,
  rootId: number
): MediaLibraryRootRow | null {
  assertPositiveInteger(rootId, 'rootId')
  return (
    (database
      .prepare('SELECT * FROM media_library_roots WHERE id = ? AND library_id = ?')
      .get(rootId, libraryId) as MediaLibraryRootRow | undefined) ?? null
  )
}

function requireRootRow(
  database: Database.Database,
  libraryId: number,
  rootId: number
): MediaLibraryRootRow {
  const row = getRootRow(database, libraryId, rootId)
  if (!row) throw new MediaLibraryRepoError('ROOT_NOT_FOUND', '媒体库根目录不存在。')
  return row
}

function assertRootAllowsOrdinaryEdit(row: MediaLibraryRootRow): void {
  if (row.state === 'pending_removal') {
    throw new MediaLibraryRepoError(
      'LIBRARY_BUSY',
      '根目录正在等待安全清理，不能执行普通编辑。'
    )
  }
  if (row.state === 'archived') {
    throw new MediaLibraryRepoError(
      'LIBRARY_ARCHIVED',
      '已归档根目录必须随媒体库恢复后才能修改。'
    )
  }
}

function assertRootPathHasNoOwnedData(
  database: Database.Database,
  libraryId: number,
  rootId: number
): void {
  const owned = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM video_resources
           WHERE library_id = @libraryId AND root_id = @rootId) AS resource_count,
         (SELECT COUNT(*) FROM pending_scan_resources
           WHERE library_id = @libraryId AND root_id = @rootId) AS pending_resource_count,
         (SELECT COUNT(*) FROM pending_resource_identities
           WHERE library_id = @libraryId AND root_id = @rootId) AS pending_identity_count,
         (SELECT COUNT(*) FROM library_unrecognized_files
           WHERE library_id = @libraryId AND root_id = @rootId) AS unrecognized_file_count,
         (SELECT COUNT(*) FROM library_root_cleanup_jobs
           WHERE library_id = @libraryId AND root_id = @rootId) AS cleanup_job_count`
    )
    .get({ libraryId, rootId }) as {
    resource_count: number
    pending_resource_count: number
    pending_identity_count: number
    unrecognized_file_count: number
    cleanup_job_count: number
  }
  if (
    owned.resource_count > 0 ||
    owned.pending_resource_count > 0 ||
    owned.pending_identity_count > 0 ||
    owned.unrecognized_file_count > 0 ||
    owned.cleanup_job_count > 0
  ) {
    throw new MediaLibraryRepoError(
      'LIBRARY_BUSY',
      '根目录仍拥有资源、待确认项、未识别记录或清理历史，请使用显式迁移或清理流程。'
    )
  }
}

function rootHasContinuityOwnedData(
  database: Database.Database,
  libraryId: number,
  rootId: number
): boolean {
  const row = database
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM video_resources
           WHERE library_id = @libraryId AND root_id = @rootId) OR
         EXISTS(SELECT 1 FROM pending_scan_resources
           WHERE library_id = @libraryId AND root_id = @rootId) OR
         EXISTS(SELECT 1 FROM pending_resource_identities
           WHERE library_id = @libraryId AND root_id = @rootId) OR
         EXISTS(SELECT 1 FROM library_unrecognized_files
           WHERE library_id = @libraryId AND root_id = @rootId)
         AS has_owned_data`
    )
    .get({ libraryId, rootId }) as { has_owned_data: 0 | 1 }
  return row.has_owned_data === 1
}

function hasCompletePhysicalIdentity(
  identity: Pick<
    ResolvedMediaLibraryRootPath,
    'normalizedRealPath' | 'deviceId' | 'inode'
  >
): boolean {
  return Boolean(identity.normalizedRealPath && identity.deviceId && identity.inode)
}

function assertContinuityOwnedRootIdentity(
  database: Database.Database,
  root: MediaLibraryRootRow,
  resolved: ResolvedMediaLibraryRootPath
): void {
  if (!rootHasContinuityOwnedData(database, root.library_id, root.id)) return

  const stored = rootIdentityFromRow(root)
  if (!hasCompletePhysicalIdentity(stored)) {
    throw new MediaLibraryRepoError(
      'VALIDATION_FAILED',
      `根目录“${root.path}”仍拥有资源、待确认项或未识别记录，但缺少可验证的原物理身份；请先完成显式迁移或清理。`
    )
  }

  const identityMatches =
    hasCompletePhysicalIdentity(resolved) &&
    resolved.normalizedRealPath === stored.normalizedRealPath &&
    resolved.deviceId === stored.deviceId &&
    resolved.inode === stored.inode
  if (identityMatches) return

  throw new MediaLibraryRepoError(
    'VALIDATION_FAILED',
    `根目录“${root.path}”仍拥有资源、待确认项或未识别记录，但当前物理身份与原记录不一致；请恢复原挂载或先完成显式迁移/清理。`
  )
}

function rootIdentityFromRow(row: MediaLibraryRootRow): ResolvedMediaLibraryRootPath {
  return {
    path: row.path,
    normalizedPath: row.normalized_path,
    realPath: row.real_path,
    normalizedRealPath: row.normalized_real_path,
    deviceId: row.device_id,
    inode: row.inode
  }
}

function assertPreparedRootsDoNotOverlap(
  roots: readonly ResolvedMediaLibraryRootPath[]
): void {
  for (let index = 0; index < roots.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < roots.length; otherIndex += 1) {
      if (mediaLibraryRootIdentitiesOverlap(roots[index], roots[otherIndex])) {
        throw new MediaLibraryRepoError(
          'ROOT_OVERLAP',
          `根目录“${roots[index].path}”与“${roots[otherIndex].path}”重叠。`
        )
      }
    }
  }
}

function findManagedRootConflict(
  database: Database.Database,
  identity: ResolvedMediaLibraryRootPath,
  exceptRootId: number | null = null
): MediaLibraryRootConflict | null {
  const rows = database
    .prepare(
      `SELECT root.*
         FROM media_library_roots root
         JOIN media_libraries library ON library.id = root.library_id
        WHERE library.status = 'active'
          AND root.state IN ('active', 'pending_removal')
          AND (@exceptRootId IS NULL OR root.id != @exceptRootId)`
    )
    .all({ exceptRootId }) as MediaLibraryRootRow[]

  const conflict = rows.find((row) =>
    mediaLibraryRootIdentitiesOverlap(identity, rootIdentityFromRow(row))
  )
  return conflict
    ? {
        rootId: conflict.id,
        libraryId: conflict.library_id,
        path: conflict.path
      }
    : null
}

/** Read the same global managed-root overlap boundary used by every root mutation. */
export function findManagedMediaLibraryRootConflict(
  identity: ResolvedMediaLibraryRootPath,
  exceptRootId: number | null = null
): MediaLibraryRootConflict | null {
  return findManagedRootConflict(getDb(), identity, exceptRootId)
}

function assertRootAvailable(
  database: Database.Database,
  identity: ResolvedMediaLibraryRootPath,
  exceptRootId: number | null = null
): void {
  const conflict = findManagedRootConflict(database, identity, exceptRootId)
  if (!conflict) return
  throw new MediaLibraryRepoError(
    'ROOT_OVERLAP',
    `根目录“${identity.path}”与媒体库 #${conflict.libraryId} 的“${conflict.path}”重叠。`,
    {
      conflict
    }
  )
}

function insertConfig(
  database: Database.Database,
  libraryId: number,
  values: MediaLibraryConfigValues
): void {
  database
    .prepare(
      `INSERT INTO media_library_configs (
         library_id,
         auto_scan_enabled,
         auto_scan_interval_minutes,
         min_import_duration_minutes,
         auto_merge_same_code_resources,
         auto_import_local_nfo,
         remove_resource_less_memberships,
         default_video_scraper,
         default_sort_by,
         default_sort_dir,
         include_in_home_discovery,
         revision
       ) VALUES (
         @libraryId,
         @autoScanEnabled,
         @autoScanIntervalMinutes,
         @minImportDurationMinutes,
         @autoMergeSameCodeResources,
         @autoImportLocalNfo,
         @removeResourceLessMemberships,
         @defaultVideoScraper,
         @defaultSortBy,
         @defaultSortDir,
         @includeInHomeDiscovery,
         1
       )`
    )
    .run({
      libraryId,
      autoScanEnabled: values.autoScanEnabled ? 1 : 0,
      autoScanIntervalMinutes: values.autoScanIntervalMinutes,
      minImportDurationMinutes: values.minImportDurationMinutes,
      autoMergeSameCodeResources: values.autoMergeSameCodeResources ? 1 : 0,
      autoImportLocalNfo: values.autoImportLocalNfo ? 1 : 0,
      removeResourceLessMemberships: values.removeResourceLessMemberships ? 1 : 0,
      defaultVideoScraper: values.defaultVideoScraper,
      defaultSortBy: values.defaultSortBy,
      defaultSortDir: values.defaultSortDir,
      includeInHomeDiscovery: values.includeInHomeDiscovery ? 1 : 0
    })
}

function insertRoot(
  database: Database.Database,
  libraryId: number,
  root: PreparedRoot,
  timestamp: string
): number {
  const info = database
    .prepare(
      `INSERT INTO media_library_roots (
         library_id, path, normalized_path, real_path, normalized_real_path,
         device_id, inode, position, state, created_at, updated_at
       ) VALUES (
         @libraryId, @path, @normalizedPath, @realPath, @normalizedRealPath,
         @deviceId, @inode, @position, @state, @createdAt, @updatedAt
       )`
    )
    .run({
      libraryId,
      ...root,
      createdAt: timestamp,
      updatedAt: timestamp
    })
  return Number(info.lastInsertRowid)
}

function nextLibraryPosition(database: Database.Database): number {
  return (
    database.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS value FROM media_libraries').get() as {
      value: number
    }
  ).value
}

function nextRootPosition(database: Database.Database, libraryId: number): number {
  return (
    database
      .prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS value FROM media_library_roots WHERE library_id = ?'
      )
      .get(libraryId) as { value: number }
  ).value
}

function bumpLibraryRevision(
  database: Database.Database,
  libraryId: number,
  expectedRevision: number,
  timestamp: string
): void {
  const info = database
    .prepare(
      `UPDATE media_libraries
          SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?`
    )
    .run(timestamp, libraryId, expectedRevision)
  if (info.changes !== 1) {
    const current = getLibraryRow(database, libraryId)
    throw new MediaLibraryRepoError('REVISION_CONFLICT', '媒体库已被其他操作更新，请刷新后重试。', {
      currentRevision: current?.revision
    })
  }
}

export function listMediaLibraries(
  options: { includeArchived?: boolean } = {},
  database: Database.Database = getDb()
): MediaLibrarySummary[] {
  const where = options.includeArchived ? '' : "WHERE library.status = 'active'"
  const rows = database
    .prepare(
      `${SUMMARY_SELECT_SQL}
       ${where}
       GROUP BY library.id
       ORDER BY library.position, library.id`
    )
    .all(LEGACY_CLEANUP_QUERY_PARAMETERS) as MediaLibrarySummaryRow[]
  return rows.map(hydrateSummary)
}

export function listMediaLibraryAutomaticScanStates(): MediaLibraryAutomaticScanState[] {
  return getDb()
    .prepare(
      `SELECT
         library.id AS library_id,
         library.position,
         config.auto_scan_enabled AS enabled,
         config.auto_scan_interval_minutes AS interval_minutes,
         (SELECT COUNT(*) FROM media_library_roots root
           WHERE root.library_id = library.id AND root.state = 'active') AS active_root_count,
         (SELECT COUNT(*) FROM library_root_cleanup_jobs cleanup
           WHERE cleanup.library_id = library.id
             AND (
               cleanup.state = 'pending' OR (
                 cleanup.state = 'failed'
                 AND cleanup.id LIKE @legacyCleanupJobIdPattern
                 AND cleanup.last_error = @legacyCleanupWaitingError
               )
             ))
           AS pending_cleanup_job_count,
         scan_state.last_finished_at
       FROM media_libraries library
       JOIN media_library_configs config ON config.library_id = library.id
       LEFT JOIN media_library_scan_state scan_state ON scan_state.library_id = library.id
       WHERE library.status = 'active'
       ORDER BY library.position, library.id`
    )
    .all(LEGACY_CLEANUP_QUERY_PARAMETERS)
    .map((row) => {
      const stored = row as {
        library_id: number
        position: number
        enabled: 0 | 1
        interval_minutes: number
        active_root_count: number
        pending_cleanup_job_count: number
        last_finished_at: string | null
      }
      return {
        libraryId: stored.library_id,
        position: stored.position,
        enabled: Boolean(stored.enabled),
        intervalMinutes: stored.interval_minutes,
        activeRootCount: stored.active_root_count,
        pendingCleanupJobCount: stored.pending_cleanup_job_count,
        lastFinishedAt: stored.last_finished_at
      }
    })
}

export function getMediaLibrary(libraryId: number): MediaLibrary | null {
  const row = getLibraryRow(getDb(), libraryId)
  return row ? hydrateLibrary(row) : null
}

export function getMediaLibraryConfig(libraryId: number): MediaLibraryConfig | null {
  const database = getDb()
  if (!getLibraryRow(database, libraryId)) return null
  const row = getConfigRow(database, libraryId)
  return row ? hydrateConfig(row) : null
}

export function listMediaLibraryRoots(
  libraryId: number,
  options: { states?: MediaLibraryRootState[] } = {}
): MediaLibraryRoot[] {
  const database = getDb()
  requireLibraryRow(database, libraryId)
  const states = options.states
  if (!states || states.length === 0) {
    return (
      database
        .prepare(
          'SELECT * FROM media_library_roots WHERE library_id = ? ORDER BY position, id'
        )
        .all(libraryId) as MediaLibraryRootRow[]
    ).map(hydrateRoot)
  }

  const validStates = new Set<MediaLibraryRootState>([
    'active',
    'pending_removal',
    'disabled',
    'archived'
  ])
  if (states.some((state) => !validStates.has(state))) validationError('根目录状态筛选无效。')
  const placeholders = states.map(() => '?').join(', ')
  return (
    database
      .prepare(
        `SELECT * FROM media_library_roots
          WHERE library_id = ? AND state IN (${placeholders})
          ORDER BY position, id`
      )
      .all(libraryId, ...states) as MediaLibraryRootRow[]
  ).map(hydrateRoot)
}

export function getMediaLibraryRoot(libraryId: number, rootId: number): MediaLibraryRoot | null {
  const database = getDb()
  requireLibraryRow(database, libraryId)
  const row = getRootRow(database, libraryId, rootId)
  return row ? hydrateRoot(row) : null
}

export function getMediaLibraryDetail(libraryId: number): MediaLibraryDetail | null {
  assertPositiveInteger(libraryId, 'libraryId')
  const database = getDb()
  const row = database
    .prepare(`${SUMMARY_SELECT_SQL} WHERE library.id = @libraryId GROUP BY library.id`)
    .get({ ...LEGACY_CLEANUP_QUERY_PARAMETERS, libraryId }) as MediaLibrarySummaryRow | undefined
  if (!row) return null
  return {
    ...hydrateSummary(row),
    roots: (
      database
        .prepare(
          'SELECT * FROM media_library_roots WHERE library_id = ? ORDER BY position, id'
        )
        .all(libraryId) as MediaLibraryRootRow[]
    ).map(hydrateRoot)
  }
}

export function createMediaLibrary(input: CreateMediaLibraryInput): MediaLibraryDetail {
  const database = getDb()
  const name = normalizeLibraryName(input.name)
  const icon = input.icon ?? 'library'
  const color = input.color ?? 'slate'
  if (!includesValue(MEDIA_LIBRARY_ICONS, icon)) validationError('媒体库图标无效。')
  if (!includesValue(MEDIA_LIBRARY_COLORS, color)) validationError('媒体库颜色无效。')
  const config = normalizeConfigValues(input.config)
  const preparedRoots = (input.roots ?? []).map((root, index): PreparedRoot => {
    const state = root.state ?? 'active'
    assertEditableRootState(state)
    return {
      ...resolveMediaLibraryRootPath(root.path),
      position: root.position === undefined ? index : normalizePosition(root.position),
      state
    }
  })
  assertPreparedRootsDoNotOverlap(
    preparedRoots.filter((root) => includesValue(MANAGED_ROOT_STATES, root.state))
  )

  const libraryId = database.transaction(() => {
    const timestamp = nowIso()
    const position =
      input.position === undefined ? nextLibraryPosition(database) : normalizePosition(input.position)
    const info = database
      .prepare(
        `INSERT INTO media_libraries (
           name, icon, color, position, status, is_default, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'active', 0, 1, ?, ?)`
      )
      .run(name, icon, color, position, timestamp, timestamp)
    const id = Number(info.lastInsertRowid)
    insertConfig(database, id, config)
    for (const root of preparedRoots) {
      if (includesValue(MANAGED_ROOT_STATES, root.state)) assertRootAvailable(database, root)
      insertRoot(database, id, root, timestamp)
    }
    return id
  }).immediate()

  const detail = getMediaLibraryDetail(libraryId)
  if (!detail) throw new MediaLibraryRepoError('LIBRARY_NOT_FOUND', '媒体库创建失败。')
  return detail
}

export function updateMediaLibrary(input: {
  libraryId: number
  expectedRevision: number
  patch: MediaLibraryPatch
}): MediaLibraryDetail {
  const database = getDb()
  const updates: string[] = []
  const parameters: Record<string, unknown> = {
    libraryId: input.libraryId,
    expectedRevision: input.expectedRevision
  }

  if (input.patch.name !== undefined) {
    updates.push('name = @name')
    parameters.name = normalizeLibraryName(input.patch.name)
  }
  if (input.patch.icon !== undefined) {
    if (!includesValue(MEDIA_LIBRARY_ICONS, input.patch.icon)) validationError('媒体库图标无效。')
    updates.push('icon = @icon')
    parameters.icon = input.patch.icon
  }
  if (input.patch.color !== undefined) {
    if (!includesValue(MEDIA_LIBRARY_COLORS, input.patch.color)) validationError('媒体库颜色无效。')
    updates.push('color = @color')
    parameters.color = input.patch.color
  }
  if (input.patch.position !== undefined) {
    updates.push('position = @position')
    parameters.position = normalizePosition(input.patch.position)
  }

  database.transaction(() => {
    const current = requireExpectedLibraryRevision(
      database,
      input.libraryId,
      input.expectedRevision
    )
    requireActiveLibrary(current)
    if (updates.length === 0) return
    parameters.updatedAt = nowIso()
    const info = database
      .prepare(
        `UPDATE media_libraries
            SET ${updates.join(', ')}, revision = revision + 1, updated_at = @updatedAt
          WHERE id = @libraryId AND revision = @expectedRevision`
      )
      .run(parameters)
    if (info.changes !== 1) {
      throw new MediaLibraryRepoError(
        'REVISION_CONFLICT',
        '媒体库已被其他操作更新，请刷新后重试。'
      )
    }
  }).immediate()

  const detail = getMediaLibraryDetail(input.libraryId)
  if (!detail) throw new MediaLibraryRepoError('LIBRARY_NOT_FOUND', '媒体库不存在。')
  return detail
}

export function updateMediaLibraryConfig(input: {
  libraryId: number
  expectedRevision: number
  patch: MediaLibraryConfigPatch
}): MediaLibraryConfig {
  const database = getDb()
  assertPositiveInteger(input.libraryId, 'libraryId')
  assertRevision(input.expectedRevision)
  const patch = normalizeConfigPatch(input.patch)

  const result = database.transaction(() => {
    const library = requireLibraryRow(database, input.libraryId)
    requireActiveLibrary(library)
    const currentRow = requireConfigRow(database, input.libraryId)
    if (currentRow.revision !== input.expectedRevision) {
      throw new MediaLibraryRepoError(
        'REVISION_CONFLICT',
        '媒体库配置已被其他操作更新，请刷新后重试。',
        { currentRevision: currentRow.revision }
      )
    }
    if (Object.keys(patch).length === 0) return hydrateConfig(currentRow)

    const next: MediaLibraryConfigValues = {
      autoScanEnabled: patch.autoScanEnabled ?? Boolean(currentRow.auto_scan_enabled),
      autoScanIntervalMinutes:
        patch.autoScanIntervalMinutes ?? currentRow.auto_scan_interval_minutes,
      minImportDurationMinutes:
        patch.minImportDurationMinutes ?? currentRow.min_import_duration_minutes,
      autoMergeSameCodeResources:
        patch.autoMergeSameCodeResources ?? Boolean(currentRow.auto_merge_same_code_resources),
      autoImportLocalNfo:
        patch.autoImportLocalNfo ?? Boolean(currentRow.auto_import_local_nfo),
      removeResourceLessMemberships:
        patch.removeResourceLessMemberships ??
        Boolean(currentRow.remove_resource_less_memberships),
      defaultVideoScraper:
        patch.defaultVideoScraper !== undefined
          ? patch.defaultVideoScraper
          : currentRow.default_video_scraper,
      defaultSortBy: patch.defaultSortBy ?? currentRow.default_sort_by,
      defaultSortDir: patch.defaultSortDir ?? currentRow.default_sort_dir,
      includeInHomeDiscovery:
        patch.includeInHomeDiscovery ?? Boolean(currentRow.include_in_home_discovery)
    }
    const info = database
      .prepare(
        `UPDATE media_library_configs
            SET auto_scan_enabled = @autoScanEnabled,
                auto_scan_interval_minutes = @autoScanIntervalMinutes,
                min_import_duration_minutes = @minImportDurationMinutes,
                auto_merge_same_code_resources = @autoMergeSameCodeResources,
                auto_import_local_nfo = @autoImportLocalNfo,
                remove_resource_less_memberships = @removeResourceLessMemberships,
                default_video_scraper = @defaultVideoScraper,
                default_sort_by = @defaultSortBy,
                default_sort_dir = @defaultSortDir,
                include_in_home_discovery = @includeInHomeDiscovery,
                revision = revision + 1
          WHERE library_id = @libraryId AND revision = @expectedRevision`
      )
      .run({
        libraryId: input.libraryId,
        expectedRevision: input.expectedRevision,
        autoScanEnabled: next.autoScanEnabled ? 1 : 0,
        autoScanIntervalMinutes: next.autoScanIntervalMinutes,
        minImportDurationMinutes: next.minImportDurationMinutes,
        autoMergeSameCodeResources: next.autoMergeSameCodeResources ? 1 : 0,
        autoImportLocalNfo: next.autoImportLocalNfo ? 1 : 0,
        removeResourceLessMemberships: next.removeResourceLessMemberships ? 1 : 0,
        defaultVideoScraper: next.defaultVideoScraper,
        defaultSortBy: next.defaultSortBy,
        defaultSortDir: next.defaultSortDir,
        includeInHomeDiscovery: next.includeInHomeDiscovery ? 1 : 0
      })
    if (info.changes !== 1) {
      throw new MediaLibraryRepoError(
        'REVISION_CONFLICT',
        '媒体库配置已被其他操作更新，请刷新后重试。'
      )
    }
    return hydrateConfig(requireConfigRow(database, input.libraryId))
  }).immediate()

  return result
}

export function addMediaLibraryRoot(input: {
  libraryId: number
  expectedRevision: number
  root: CreateMediaLibraryRootInput
}): MediaLibraryRoot {
  const database = getDb()
  const state = input.root.state ?? 'active'
  assertEditableRootState(state)
  const identity = resolveMediaLibraryRootPath(input.root.path)

  const rootId = database.transaction(() => {
    const library = requireExpectedLibraryRevision(
      database,
      input.libraryId,
      input.expectedRevision
    )
    requireActiveLibrary(library)
    if (includesValue(MANAGED_ROOT_STATES, state)) assertRootAvailable(database, identity)
    const position =
      input.root.position === undefined
        ? nextRootPosition(database, input.libraryId)
        : normalizePosition(input.root.position)
    const timestamp = nowIso()
    const id = insertRoot(database, input.libraryId, { ...identity, position, state }, timestamp)
    bumpLibraryRevision(database, input.libraryId, input.expectedRevision, timestamp)
    return id
  }).immediate()

  const root = getMediaLibraryRoot(input.libraryId, rootId)
  if (!root) throw new MediaLibraryRepoError('ROOT_NOT_FOUND', '媒体库根目录创建失败。')
  return root
}

export interface BindOnlineMediaLibraryRootIdentitiesResult {
  boundRootIds: number[]
  revision: number
}

/**
 * Freeze the first usable filesystem identity for roots that were configured while offline.
 * Resolution happens before the write lock, then is repeated inside the transaction so an alias
 * or mount change cannot be committed from a stale filesystem snapshot.
 */
export function bindOnlineMediaLibraryRootIdentities(input: {
  libraryId: number
  rootIds: readonly number[]
  expectedRevision: number
}): BindOnlineMediaLibraryRootIdentitiesResult {
  const database = getDb()
  const rootIds = [...new Set(input.rootIds)]
  for (const rootId of rootIds) assertPositiveInteger(rootId, 'rootId')
  const library = requireExpectedLibraryRevision(
    database,
    input.libraryId,
    input.expectedRevision
  )
  requireActiveLibrary(library)

  const prepared = rootIds.flatMap((rootId) => {
    const root = requireRootRow(database, input.libraryId, rootId)
    if (root.state !== 'active') return []
    if (root.normalized_real_path && root.device_id && root.inode) return []
    const identity = resolveMediaLibraryRootPath(root.path)
    if (!identity.normalizedRealPath || !identity.deviceId || !identity.inode) return []
    return [{ root, identity }]
  })
  if (prepared.length === 0) {
    return { boundRootIds: [], revision: input.expectedRevision }
  }
  assertPreparedRootsDoNotOverlap(prepared.map((item) => item.identity))

  const boundRootIds = database.transaction(() => {
    const currentLibrary = requireExpectedLibraryRevision(
      database,
      input.libraryId,
      input.expectedRevision
    )
    requireActiveLibrary(currentLibrary)
    const timestamp = nowIso()
    const bound: number[] = []
    for (const item of prepared) {
      const current = requireRootRow(database, input.libraryId, item.root.id)
      const databaseSnapshotChanged =
        current.path !== item.root.path ||
        current.state !== 'active' ||
        current.real_path !== item.root.real_path ||
        current.normalized_real_path !== item.root.normalized_real_path ||
        current.device_id !== item.root.device_id ||
        current.inode !== item.root.inode
      if (databaseSnapshotChanged) {
        throw new MediaLibraryRepoError(
          'REVISION_CONFLICT',
          '媒体库根目录已被其他操作更新，请刷新后重试。',
          { currentRevision: currentLibrary.revision }
        )
      }

      const confirmed = resolveMediaLibraryRootPath(current.path)
      if (
        confirmed.normalizedRealPath !== item.identity.normalizedRealPath ||
        confirmed.deviceId !== item.identity.deviceId ||
        confirmed.inode !== item.identity.inode
      ) {
        throw new MediaLibraryRepoError(
          'VALIDATION_FAILED',
          `根目录“${current.path}”的身份在扫描准备期间发生变化，请确认挂载后重试。`
        )
      }
      assertContinuityOwnedRootIdentity(database, current, confirmed)
      assertRootAvailable(database, confirmed, current.id)
      database
        .prepare(
          `UPDATE media_library_roots
              SET real_path = @realPath,
                  normalized_real_path = @normalizedRealPath,
                  device_id = @deviceId,
                  inode = @inode,
                  updated_at = @updatedAt
            WHERE id = @rootId AND library_id = @libraryId`
        )
        .run({
          rootId: current.id,
          libraryId: input.libraryId,
          realPath: confirmed.realPath,
          normalizedRealPath: confirmed.normalizedRealPath,
          deviceId: confirmed.deviceId,
          inode: confirmed.inode,
          updatedAt: timestamp
        })
      bound.push(current.id)
    }
    bumpLibraryRevision(database, input.libraryId, input.expectedRevision, timestamp)
    return bound
  }).immediate()

  return { boundRootIds, revision: input.expectedRevision + 1 }
}

export function updateMediaLibraryRoot(input: {
  libraryId: number
  rootId: number
  expectedRevision: number
  patch: MediaLibraryRootPatch
}): MediaLibraryRoot {
  const database = getDb()
  if (input.patch.state !== undefined) assertEditableRootState(input.patch.state)

  const result = database.transaction(() => {
    const library = requireExpectedLibraryRevision(
      database,
      input.libraryId,
      input.expectedRevision
    )
    requireActiveLibrary(library)
    const current = requireRootRow(database, input.libraryId, input.rootId)
    if (Object.keys(input.patch).length === 0) return hydrateRoot(current)
    assertRootAllowsOrdinaryEdit(current)
    if (input.patch.state === 'pending_removal') {
      throw new MediaLibraryRepoError(
        'VALIDATION_FAILED',
        '根目录待移除状态只能由显式移除流程建立。'
      )
    }
    if (input.patch.path !== undefined) {
      assertRootPathHasNoOwnedData(database, input.libraryId, input.rootId)
    }

    const nextState = input.patch.state ?? current.state
    if (nextState === 'archived') validationError('归档根目录只能随媒体库恢复。')
    const shouldRefreshIdentity =
      input.patch.path !== undefined ||
      (includesValue(MANAGED_ROOT_STATES, nextState) &&
        !includesValue(MANAGED_ROOT_STATES, current.state))
    const identity = shouldRefreshIdentity
      ? resolveMediaLibraryRootPath(input.patch.path ?? current.path)
      : rootIdentityFromRow(current)
    if (
      includesValue(MANAGED_ROOT_STATES, nextState) &&
      !includesValue(MANAGED_ROOT_STATES, current.state)
    ) {
      assertContinuityOwnedRootIdentity(database, current, identity)
    }
    if (includesValue(MANAGED_ROOT_STATES, nextState)) {
      assertRootAvailable(database, identity, current.id)
    }

    const position =
      input.patch.position === undefined
        ? current.position
        : normalizePosition(input.patch.position)
    const timestamp = nowIso()
    database
      .prepare(
        `UPDATE media_library_roots
            SET path = @path,
                normalized_path = @normalizedPath,
                real_path = @realPath,
                normalized_real_path = @normalizedRealPath,
                device_id = @deviceId,
                inode = @inode,
                position = @position,
                state = @state,
                updated_at = @updatedAt
          WHERE id = @rootId AND library_id = @libraryId`
      )
      .run({
        rootId: input.rootId,
        libraryId: input.libraryId,
        ...identity,
        position,
        state: nextState,
        updatedAt: timestamp
      })
    bumpLibraryRevision(database, input.libraryId, input.expectedRevision, timestamp)
    return hydrateRoot(requireRootRow(database, input.libraryId, input.rootId))
  }).immediate()

  return result
}

export function deleteMediaLibraryRoot(input: {
  libraryId: number
  rootId: number
  expectedRevision: number
}): MediaLibraryRoot {
  const database = getDb()
  try {
    return database.transaction(() => {
      const library = requireExpectedLibraryRevision(
        database,
        input.libraryId,
        input.expectedRevision
      )
      requireActiveLibrary(library)
      const current = requireRootRow(database, input.libraryId, input.rootId)
      const ownedData = database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM video_resources
               WHERE library_id = @libraryId AND root_id = @rootId) +
             (SELECT COUNT(*) FROM pending_scan_resources
               WHERE library_id = @libraryId AND root_id = @rootId) +
             (SELECT COUNT(*) FROM pending_resource_identities
               WHERE library_id = @libraryId AND root_id = @rootId) +
             (SELECT COUNT(*) FROM library_unrecognized_files
               WHERE library_id = @libraryId AND root_id = @rootId) +
             (SELECT COUNT(*) FROM library_root_cleanup_jobs
               WHERE library_id = @libraryId AND root_id = @rootId
                 AND state IN ('pending', 'running')) AS count`
        )
        .get({ libraryId: input.libraryId, rootId: input.rootId }) as { count: number }
      if (ownedData.count > 0) {
        throw new MediaLibraryRepoError(
          'LIBRARY_BUSY',
          '根目录仍有资源、待确认项、未识别记录或清理历史，请先完成清理或迁移。'
        )
      }
      // Terminal cleanup rows are audit-only snapshots. Explicit root-record deletion may
      // discard that bounded history after the caller has confirmed the current impact.
      database
        .prepare(
          `DELETE FROM library_root_cleanup_jobs
            WHERE library_id = ? AND root_id = ?
              AND state IN ('completed', 'failed', 'cancelled')`
        )
        .run(input.libraryId, input.rootId)
      database
        .prepare('DELETE FROM media_library_roots WHERE id = ? AND library_id = ?')
        .run(input.rootId, input.libraryId)
      bumpLibraryRevision(database, input.libraryId, input.expectedRevision, nowIso())
      return hydrateRoot(current)
    }).immediate()
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      throw new MediaLibraryRepoError(
        'LIBRARY_BUSY',
        '根目录仍被资源、待确认项或清理任务引用，暂时不能删除。'
      )
    }
    throw error
  }
}

function assertPermanentDeletionCandidate(library: MediaLibraryRow): void {
  if (library.id === DEFAULT_MEDIA_LIBRARY_ID || library.is_default) {
    throw new MediaLibraryRepoError(
      'DEFAULT_LIBRARY_PROTECTED',
      '此媒体库受系统保护，不能永久删除。'
    )
  }
  if (library.status !== 'archived') {
    throw new MediaLibraryRepoError(
      'VALIDATION_FAILED',
      '媒体库必须先归档，才能预览或执行永久删除。'
    )
  }
}

function readMediaLibraryDeletionCounts(
  database: Database.Database,
  libraryId: number
): MediaLibraryDeletePreviewRow {
  return database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM media_library_roots WHERE library_id = @libraryId)
          AS root_count,
        (SELECT COUNT(*) FROM library_video_memberships WHERE library_id = @libraryId)
          AS membership_count,
        (SELECT COUNT(*) FROM video_resources WHERE library_id = @libraryId)
          AS resource_count,
        (SELECT COUNT(*)
           FROM library_video_memberships membership
          WHERE membership.library_id = @libraryId
            AND NOT EXISTS (
              SELECT 1
                FROM library_video_memberships other
               WHERE other.video_id = membership.video_id
                 AND other.library_id <> @libraryId
            )) AS exclusive_video_count,
        (SELECT COUNT(*) FROM pending_scan_groups WHERE library_id = @libraryId) +
        (SELECT COUNT(*) FROM pending_resource_identities WHERE library_id = @libraryId)
          AS pending_scan_group_count,
        (SELECT COUNT(*) FROM pending_scan_resources WHERE library_id = @libraryId) +
        (SELECT COUNT(*) FROM pending_resource_identities WHERE library_id = @libraryId)
          AS pending_scan_resource_count,
        (SELECT COUNT(*) FROM library_scan_runs WHERE library_id = @libraryId)
          AS scan_run_count,
        (SELECT COUNT(*)
           FROM library_scan_runs
          WHERE library_id = @libraryId AND status IN ('queued', 'running'))
          AS active_scan_run_count,
        (SELECT COUNT(*) FROM library_unrecognized_files WHERE library_id = @libraryId)
          AS unrecognized_file_count,
        (SELECT COUNT(*) FROM library_root_cleanup_jobs WHERE library_id = @libraryId)
          AS cleanup_job_count,
        (SELECT COUNT(*)
           FROM library_root_cleanup_jobs
          WHERE library_id = @libraryId AND state IN ('pending', 'running'))
          AS active_cleanup_job_count`
    )
    .get({ libraryId }) as MediaLibraryDeletePreviewRow
}

/**
 * Hash the complete database ownership graph removed by permanent deletion.
 *
 * `media_libraries.revision` only protects edits to the library row. Archived
 * memberships and resources can still be changed by global video lifecycle
 * operations, while scan history and completed cleanup records have their own
 * lifecycle. Keeping this snapshot separate makes the confirmation bind to the
 * exact impact the user reviewed.
 */
function readMediaLibraryDeletionImpactRevision(
  database: Database.Database,
  libraryId: number,
  counts: MediaLibraryDeletePreviewRow
): string {
  const params = { libraryId }
  const snapshot = {
    version: 1,
    counts,
    config: database
      .prepare('SELECT * FROM media_library_configs WHERE library_id = @libraryId')
      .all(params),
    roots: database
      .prepare(
        'SELECT * FROM media_library_roots WHERE library_id = @libraryId ORDER BY id'
      )
      .all(params),
    memberships: database
      .prepare(
        `SELECT * FROM library_video_memberships
          WHERE library_id = @libraryId ORDER BY video_id`
      )
      .all(params),
    resources: database
      .prepare('SELECT * FROM video_resources WHERE library_id = @libraryId ORDER BY id')
      .all(params),
    pendingScanGroups: database
      .prepare(
        'SELECT * FROM pending_scan_groups WHERE library_id = @libraryId ORDER BY id'
      )
      .all(params),
    pendingScanResources: database
      .prepare(
        'SELECT * FROM pending_scan_resources WHERE library_id = @libraryId ORDER BY id'
      )
      .all(params),
    pendingResourceIdentities: database
      .prepare(
        'SELECT * FROM pending_resource_identities WHERE library_id = @libraryId ORDER BY id'
      )
      .all(params),
    scanRuns: database
      .prepare('SELECT * FROM library_scan_runs WHERE library_id = @libraryId ORDER BY id')
      .all(params),
    scanState: database
      .prepare('SELECT * FROM media_library_scan_state WHERE library_id = @libraryId')
      .all(params),
    unrecognizedFiles: database
      .prepare(
        `SELECT * FROM library_unrecognized_files
          WHERE library_id = @libraryId ORDER BY normalized_path`
      )
      .all(params),
    cleanupJobs: database
      .prepare(
        'SELECT * FROM library_root_cleanup_jobs WHERE library_id = @libraryId ORDER BY id'
      )
      .all(params)
  }
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

/**
 * Capture the database-only impact of deleting an archived library. Callers must
 * pass both returned revisions to deleteMediaLibrary after explicit confirmation.
 */
export function previewMediaLibraryDeletion(libraryId: number): MediaLibraryDeletePreview {
  const database = getDb()
  return database.transaction((): MediaLibraryDeletePreview => {
    const library = requireLibraryRow(database, libraryId)
    assertPermanentDeletionCandidate(library)
    const counts = readMediaLibraryDeletionCounts(database, libraryId)
    return {
      libraryId,
      name: library.name,
      revision: library.revision,
      impactRevision: readMediaLibraryDeletionImpactRevision(database, libraryId, counts),
      status: 'archived',
      rootCount: counts.root_count,
      membershipCount: counts.membership_count,
      resourceCount: counts.resource_count,
      exclusiveVideoCount: counts.exclusive_video_count,
      pendingScanGroupCount: counts.pending_scan_group_count,
      pendingScanResourceCount: counts.pending_scan_resource_count,
      scanRunCount: counts.scan_run_count,
      activeScanRunCount: counts.active_scan_run_count,
      unrecognizedFileCount: counts.unrecognized_file_count,
      cleanupJobCount: counts.cleanup_job_count,
      activeCleanupJobCount: counts.active_cleanup_job_count
    }
  })()
}

export function archiveMediaLibrary(input: {
  libraryId: number
  expectedRevision: number
}): MediaLibraryDetail {
  const database = getDb()
  database.transaction(() => {
    const library = requireExpectedLibraryRevision(
      database,
      input.libraryId,
      input.expectedRevision
    )
    if (library.id === DEFAULT_MEDIA_LIBRARY_ID || library.is_default) {
      throw new MediaLibraryRepoError(
        'DEFAULT_LIBRARY_PROTECTED',
        '此媒体库受系统保护，不能归档。'
      )
    }
    if (library.status === 'archived') return
    const pending = database
      .prepare(
        `SELECT
          (SELECT COUNT(*)
             FROM media_library_roots
            WHERE library_id = @libraryId AND state = 'pending_removal')
            AS pending_root_count,
          (SELECT COUNT(*)
             FROM library_scan_runs
            WHERE library_id = @libraryId AND status IN ('queued', 'running'))
            AS active_scan_run_count,
          (SELECT COUNT(*)
             FROM library_root_cleanup_jobs
            WHERE library_id = @libraryId AND state IN ('pending', 'running'))
            AS active_cleanup_job_count`
      )
      .get({ libraryId: input.libraryId }) as {
      pending_root_count: number
      active_scan_run_count: number
      active_cleanup_job_count: number
    }
    if (
      pending.pending_root_count > 0 ||
      pending.active_scan_run_count > 0 ||
      pending.active_cleanup_job_count > 0
    ) {
      throw new MediaLibraryRepoError(
        'LIBRARY_BUSY',
        '媒体库仍有待移除根目录、运行中的扫描或清理任务，完成或取消后才能归档。'
      )
    }
    const timestamp = nowIso()
    database
      .prepare(
        `UPDATE media_library_roots
            SET state = 'archived', updated_at = ?
          WHERE library_id = ? AND state = 'active'`
      )
      .run(timestamp, input.libraryId)
    const info = database
      .prepare(
        `UPDATE media_libraries
            SET status = 'archived', revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?`
      )
      .run(timestamp, input.libraryId, input.expectedRevision)
    if (info.changes !== 1) {
      throw new MediaLibraryRepoError(
        'REVISION_CONFLICT',
        '媒体库已被其他操作更新，请刷新后重试。'
      )
    }
  }).immediate()

  const detail = getMediaLibraryDetail(input.libraryId)
  if (!detail) throw new MediaLibraryRepoError('LIBRARY_NOT_FOUND', '媒体库不存在。')
  return detail
}

export function restoreMediaLibrary(input: {
  libraryId: number
  expectedRevision: number
}): MediaLibraryDetail {
  const database = getDb()
  const initialLibrary = requireExpectedLibraryRevision(
    database,
    input.libraryId,
    input.expectedRevision
  )
  if (initialLibrary.status === 'active') {
    const activeDetail = getMediaLibraryDetail(input.libraryId)
    if (!activeDetail) throw new MediaLibraryRepoError('LIBRARY_NOT_FOUND', '媒体库不存在。')
    return activeDetail
  }
  // Filesystem calls may block on offline/network roots, so keep them outside the
  // IMMEDIATE transaction. The library revision and root snapshot are rechecked below.
  const preparedRoots = (
    database
      .prepare(
        `SELECT * FROM media_library_roots
          WHERE library_id = ? AND state = 'archived'
          ORDER BY position, id`
      )
      .all(input.libraryId) as MediaLibraryRootRow[]
  ).map((root) => ({ root, identity: resolveMediaLibraryRootPath(root.path) }))
  assertPreparedRootsDoNotOverlap(preparedRoots.map((item) => item.identity))

  database.transaction(() => {
    const library = requireExpectedLibraryRevision(
      database,
      input.libraryId,
      input.expectedRevision
    )
    if (library.status === 'active') return
    const currentRoots = database
      .prepare(
        `SELECT * FROM media_library_roots
          WHERE library_id = ? AND state = 'archived'
          ORDER BY position, id`
      )
      .all(input.libraryId) as MediaLibraryRootRow[]
    const snapshotChanged =
      currentRoots.length !== preparedRoots.length ||
      currentRoots.some((root, index) => {
        const prepared = preparedRoots[index]?.root
        return (
          !prepared ||
          prepared.id !== root.id ||
          prepared.path !== root.path ||
          prepared.normalized_path !== root.normalized_path ||
          prepared.real_path !== root.real_path ||
          prepared.normalized_real_path !== root.normalized_real_path ||
          prepared.device_id !== root.device_id ||
          prepared.inode !== root.inode ||
          prepared.state !== root.state
        )
      })
    if (snapshotChanged) {
      throw new MediaLibraryRepoError(
        'REVISION_CONFLICT',
        '媒体库根目录已被其他操作更新，请刷新后重试。',
        { currentRevision: library.revision }
      )
    }
    for (const item of preparedRoots) {
      assertContinuityOwnedRootIdentity(database, item.root, item.identity)
      assertRootAvailable(database, item.identity)
    }

    const timestamp = nowIso()
    const updateRoot = database.prepare(
      `UPDATE media_library_roots
          SET path = @path,
              normalized_path = @normalizedPath,
              real_path = @realPath,
              normalized_real_path = @normalizedRealPath,
              device_id = @deviceId,
              inode = @inode,
              state = 'active',
              updated_at = @updatedAt
        WHERE id = @rootId AND library_id = @libraryId AND state = 'archived'`
    )
    for (const item of preparedRoots) {
      updateRoot.run({
        rootId: item.root.id,
        libraryId: input.libraryId,
        ...item.identity,
        updatedAt: timestamp
      })
    }
    const info = database
      .prepare(
        `UPDATE media_libraries
            SET status = 'active', revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'archived'`
      )
      .run(timestamp, input.libraryId, input.expectedRevision)
    if (info.changes !== 1) {
      throw new MediaLibraryRepoError(
        'REVISION_CONFLICT',
        '媒体库已被其他操作更新，请刷新后重试。'
      )
    }
  }).immediate()

  const detail = getMediaLibraryDetail(input.libraryId)
  if (!detail) throw new MediaLibraryRepoError('LIBRARY_NOT_FOUND', '媒体库不存在。')
  return detail
}

export function deleteMediaLibrary(input: {
  libraryId: number
  expectedRevision: number
  expectedImpactRevision: string
}): MediaLibraryDetail {
  const database = getDb()
  try {
    return database.transaction(() => {
      const library = requireExpectedLibraryRevision(
        database,
        input.libraryId,
        input.expectedRevision
      )
      assertPermanentDeletionCandidate(library)
      const counts = readMediaLibraryDeletionCounts(database, input.libraryId)
      if (counts.active_scan_run_count > 0 || counts.active_cleanup_job_count > 0) {
        throw new MediaLibraryRepoError(
          'LIBRARY_BUSY',
          '媒体库仍有运行中的扫描或根目录清理任务，暂时不能永久删除。'
        )
      }
      const impactRevision = readMediaLibraryDeletionImpactRevision(
        database,
        input.libraryId,
        counts
      )
      if (impactRevision !== input.expectedImpactRevision) {
        throw new MediaLibraryRepoError(
          'REVISION_CONFLICT',
          '媒体库删除预览已过期，请刷新影响范围后重试。'
        )
      }
      const detail = getMediaLibraryDetail(input.libraryId)
      if (!detail) throw new MediaLibraryRepoError('LIBRARY_NOT_FOUND', '媒体库不存在。')
      // Root-scoped rows use RESTRICT so lifecycle commands cannot silently detach
      // data. Permanent deletion is the one explicit operation that removes those
      // database records. It deliberately never touches local or STRM target files.
      database
        .prepare('DELETE FROM library_root_cleanup_jobs WHERE library_id = ?')
        .run(input.libraryId)
      database
        .prepare('DELETE FROM pending_scan_resources WHERE library_id = ?')
        .run(input.libraryId)
      database
        .prepare('DELETE FROM pending_resource_identities WHERE library_id = ?')
        .run(input.libraryId)
      database.prepare('DELETE FROM video_resources WHERE library_id = ?').run(input.libraryId)
      database
        .prepare('DELETE FROM library_unrecognized_files WHERE library_id = ?')
        .run(input.libraryId)
      const info = database
        .prepare(
          "DELETE FROM media_libraries WHERE id = ? AND revision = ? AND status = 'archived'"
        )
        .run(input.libraryId, input.expectedRevision)
      if (info.changes !== 1) {
        throw new MediaLibraryRepoError(
          'REVISION_CONFLICT',
          '媒体库已被其他操作更新，请刷新后重试。'
        )
      }
      return detail
    }).immediate()
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      throw new MediaLibraryRepoError(
        'LIBRARY_BUSY',
        '媒体库仍有运行中或待处理的数据，暂时不能永久删除。'
      )
    }
    throw error
  }
}

/**
 * Read config and enabled roots in one SQLite read transaction. The returned value is
 * detached and frozen so later settings edits cannot mutate an in-flight scan.
 */
export function readMediaLibraryScanSnapshot(libraryId: number): MediaLibraryScanSnapshot {
  const database = getDb()
  return database.transaction(() => {
    const library = requireLibraryRow(database, libraryId)
    requireActiveLibrary(library)
    const config = hydrateConfig(requireConfigRow(database, libraryId))
    const roots = (
      database
        .prepare(
          `SELECT * FROM media_library_roots
            WHERE library_id = ? AND state = 'active'
            ORDER BY position, id`
        )
        .all(libraryId) as MediaLibraryRootRow[]
    ).map((row) => Object.freeze(hydrateRoot(row)))
    return Object.freeze({
      libraryId,
      libraryRevision: library.revision,
      configRevision: config.revision,
      capturedAt: nowIso(),
      config: Object.freeze(config),
      roots: Object.freeze(roots)
    })
  })()
}
