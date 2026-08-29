import type { VideoQuery } from './videoTypes'

export const DEFAULT_MEDIA_LIBRARY_ID = 1 as const

export const MEDIA_LIBRARY_ICONS = [
  'library',
  'film',
  'folder',
  'hard-drive',
  'cloud',
  'star'
] as const

export const MEDIA_LIBRARY_COLORS = [
  'slate',
  'blue',
  'violet',
  'rose',
  'amber',
  'green'
] as const

export const MEDIA_LIBRARY_STATUSES = ['active', 'archived'] as const
export const MEDIA_LIBRARY_ROOT_STATES = [
  'active',
  'pending_removal',
  'disabled',
  'archived'
] as const
export const MEDIA_LIBRARY_ROOT_EDITABLE_STATES = [
  'active',
  'pending_removal',
  'disabled'
] as const
export const MEDIA_LIBRARY_SORT_DIRECTIONS = ['asc', 'desc'] as const

export type MediaLibraryIcon = (typeof MEDIA_LIBRARY_ICONS)[number]
export type MediaLibraryColor = (typeof MEDIA_LIBRARY_COLORS)[number]
export type MediaLibraryStatus = (typeof MEDIA_LIBRARY_STATUSES)[number]
export type MediaLibraryRootState = (typeof MEDIA_LIBRARY_ROOT_STATES)[number]
export type MediaLibraryRootEditableState = (typeof MEDIA_LIBRARY_ROOT_EDITABLE_STATES)[number]
export type MediaLibraryDefaultSortBy = NonNullable<VideoQuery['sortBy']>
export type MediaLibrarySortDirection = (typeof MEDIA_LIBRARY_SORT_DIRECTIONS)[number]

export const MEDIA_LIBRARY_DEFAULT_SORTS = [
  'add_time',
  'release_date',
  'rating',
  'code'
] as const satisfies readonly MediaLibraryDefaultSortBy[]

export interface MediaLibrary {
  id: number
  name: string
  icon: MediaLibraryIcon
  color: MediaLibraryColor
  position: number
  status: MediaLibraryStatus
  isDefault: boolean
  revision: number
  createdAt: string
  updatedAt: string
}

export interface MediaLibraryConfig {
  libraryId: number
  autoScanEnabled: boolean
  autoScanIntervalMinutes: number
  minImportDurationMinutes: number
  autoMergeSameCodeResources: boolean
  removeResourceLessMemberships: boolean
  defaultVideoScraper: string | null
  defaultSortBy: MediaLibraryDefaultSortBy
  defaultSortDir: MediaLibrarySortDirection
  includeInHomeDiscovery: boolean
  revision: number
}

export type MediaLibraryConfigValues = Omit<MediaLibraryConfig, 'libraryId' | 'revision'>

export const DEFAULT_MEDIA_LIBRARY_CONFIG: Readonly<MediaLibraryConfigValues> = {
  autoScanEnabled: false,
  autoScanIntervalMinutes: 1440,
  minImportDurationMinutes: 30,
  autoMergeSameCodeResources: true,
  removeResourceLessMemberships: false,
  defaultVideoScraper: null,
  defaultSortBy: 'release_date',
  defaultSortDir: 'desc',
  includeInHomeDiscovery: true
}

export interface MediaLibraryRoot {
  id: number
  libraryId: number
  path: string
  normalizedPath: string
  realPath: string | null
  normalizedRealPath: string | null
  deviceId: string | null
  inode: string | null
  position: number
  state: MediaLibraryRootState
  createdAt: string
  updatedAt: string
}

export interface MediaLibrarySummary extends MediaLibrary {
  config: MediaLibraryConfig
  rootCount: number
  activeRootCount: number
  pendingRemovalRootCount: number
  /** Queued or recoverable legacy cleanup work that makes a full scan actionable. */
  pendingCleanupJobCount: number
  /** Lightweight inbox projection used by global navigation; never requires per-library polling. */
  pendingScanGroupCount: number
  disabledRootCount: number
  archivedRootCount: number
}

export interface MediaLibraryDetail extends MediaLibrarySummary {
  roots: MediaLibraryRoot[]
}

/**
 * Read-only impact snapshot used to confirm permanent deletion. The library and
 * impact revisions together prove that the destructive command is acting on the
 * exact ownership graph the user reviewed.
 */
export interface MediaLibraryDeletePreview {
  libraryId: number
  name: string
  revision: number
  /**
   * SHA-256 snapshot of every library-owned row affected by permanent deletion.
   * Unlike the library revision, this also changes when archived resources,
   * memberships, scan history, or other owned data changes independently.
   */
  impactRevision: string
  status: 'archived'
  rootCount: number
  membershipCount: number
  resourceCount: number
  exclusiveVideoCount: number
  pendingScanGroupCount: number
  pendingScanResourceCount: number
  scanRunCount: number
  activeScanRunCount: number
  unrecognizedFileCount: number
  cleanupJobCount: number
  activeCleanupJobCount: number
}

export interface MediaLibraryRootMigrationPreview {
  sourceLibraryId: number
  sourceLibraryName: string
  sourceRevision: number
  targetLibraryId: number
  targetLibraryName: string
  targetRevision: number
  /** Frozen database impact snapshot; resource/pending changes do not bump library revisions. */
  impactRevision: string
  rootId: number
  rootPath: string
  rootState: Extract<MediaLibraryRootState, 'active' | 'disabled'>
  resourceCount: number
  videoCount: number
  targetMembershipsToCreate: number
  sourceMembershipsBecomingResourceLess: number
  pendingScanGroupCount: number
  pendingScanResourceCount: number
  targetPendingGroupsToMerge: number
  unrecognizedFileCount: number
  sourcePrimaryResourcesToPromote: number
  /** Root migration only changes database ownership; source media stays on disk. */
  sourceFilesPreserved: true
}

export interface MigrateMediaLibraryRootInput {
  sourceLibraryId: number
  targetLibraryId: number
  rootId: number
  expectedSourceRevision: number
  expectedTargetRevision: number
  expectedImpactRevision: string
}

export interface MediaLibraryRootMigrationResult {
  sourceLibraryId: number
  targetLibraryId: number
  previousRootId: number
  targetRoot: MediaLibraryRoot
  movedResourceCount: number
  createdMembershipCount: number
  movedPendingScanResourceCount: number
  movedUnrecognizedFileCount: number
  promotedSourceResourceIds: number[]
  sourceFilesPreserved: true
}

export interface MediaLibraryAutomaticScanState {
  libraryId: number
  position: number
  enabled: boolean
  intervalMinutes: number
  activeRootCount: number
  pendingCleanupJobCount: number
  lastFinishedAt: string | null
}

export interface CreateMediaLibraryInput {
  name: string
  icon?: MediaLibraryIcon
  color?: MediaLibraryColor
  position?: number
  config?: MediaLibraryConfigPatch
  roots?: CreateMediaLibraryRootInput[]
}

export interface MediaLibraryPatch {
  name?: string
  icon?: MediaLibraryIcon
  color?: MediaLibraryColor
  position?: number
}

export interface MediaLibraryConfigPatch {
  autoScanEnabled?: boolean
  autoScanIntervalMinutes?: number
  minImportDurationMinutes?: number
  autoMergeSameCodeResources?: boolean
  removeResourceLessMemberships?: boolean
  defaultVideoScraper?: string | null
  defaultSortBy?: MediaLibraryDefaultSortBy
  defaultSortDir?: MediaLibrarySortDirection
  includeInHomeDiscovery?: boolean
}

export interface CreateMediaLibraryRootInput {
  path: string
  position?: number
  state?: MediaLibraryRootEditableState
}

export interface MediaLibraryRootPatch {
  path?: string
  position?: number
  state?: MediaLibraryRootEditableState
}

export type CatalogScope =
  | { kind: 'library'; libraryId: number }
  | { kind: 'all'; libraryIds?: number[] }

/** A self-consistent, detached snapshot captured when a scan run begins. */
export interface MediaLibraryScanSnapshot {
  readonly libraryId: number
  readonly libraryRevision: number
  readonly configRevision: number
  readonly capturedAt: string
  readonly config: Readonly<MediaLibraryConfig>
  readonly roots: readonly Readonly<MediaLibraryRoot>[]
}

export type MediaLibraryErrorCode =
  | 'LIBRARY_NOT_FOUND'
  | 'ROOT_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'ROOT_OVERLAP'
  | 'DEFAULT_LIBRARY_PROTECTED'
  | 'LIBRARY_ARCHIVED'
  | 'LIBRARY_BUSY'
  | 'VALIDATION_FAILED'

export interface MediaLibraryRootConflict {
  rootId: number
  libraryId: number
  path: string
}
