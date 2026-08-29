/** Classification dimensions represented by stable entities. */
export type FacetType = 'maker' | 'publisher' | 'series' | 'director'

/** Aggregate counts for the settings overview dashboard. */
export interface LibraryOverviewStats {
  videos: {
    total: number
    scraped: number
    unscraped: number
    failed: number
  }
  actresses: {
    total: number
    female: number
    male: number
    /** Female performers with cumulative 刮削成功. */
    scraped: number
    /** Female performers with cumulative 刮削失败. */
    failed: number
    /** Female performers with cumulative 未刮削. */
    unscraped: number
  }
  playlists: number
  tags: number
  galleryAssets: number
  facets: {
    directors: number
    makers: number
    publishers: number
    series: number
  }
}

export interface LibraryPathRemovalPreview {
  libraryId: number
  rootId: number
  libraryRevision: number
  /** Frozen impact snapshot because scan/resource writes do not bump the library revision. */
  impactRevision: string
  path: string
  localResourceCount: number
  strmResourceCount: number
  pendingScanResourceCount: number
  unrecognizedFileCount: number
  terminalCleanupJobCount: number
  videosBecomingResourceLess: number
}

export interface PendingLibraryPathCleanup {
  jobId: string
  libraryId: number
  rootId: number
}

export type LibraryScanTrigger = 'manual' | 'startup' | 'interval' | 'resume'
export type LibraryScanStatus = 'success' | 'completed_with_errors' | 'cancelled' | 'failed'

export type StrmScanFailureCode =
  | 'too_large'
  | 'invalid_utf8'
  | 'missing_target'
  | 'multiple_targets'
  | 'unsupported_target'
  | 'read_failed'

export interface StrmScanFailure {
  sourcePath: string
  code: StrmScanFailureCode
  message: string
}

export interface LibraryScanSummary {
  libraryId: number
  runId: string
  configRevision: number
  trigger: LibraryScanTrigger
  startedAt: string
  finishedAt: string
  status: LibraryScanStatus
  scannedFiles: number
  resourcesAdded: number
  resourcesUpdated: number
  resourcesRemoved: number
  primaryResourcesPromoted: number
  videosDeleted: number
  skippedFiles: number
  failedFiles: number
  pendingScanGroups: number
  pendingScanResources: number
  offlineFolders: string[]
  strmFailures?: StrmScanFailure[]
  omittedStrmFailures?: number
  errorSummary: string | null
}

export type LibraryScanMetricKey =
  | 'resourcesAdded'
  | 'resourcesUpdated'
  | 'resourcesRemoved'
  | 'primaryResourcesPromoted'
  | 'videosDeleted'
  | 'scannedFiles'
  | 'skippedFiles'
  | 'failedFiles'
  | 'pendingScanGroups'
  | 'pendingScanResources'

interface LibraryScanFileAuditBase {
  rootId: number
  filePath: string
  sourceKind: 'local' | 'strm'
}

export type LibraryScanFileAuditEntry =
  | (LibraryScanFileAuditBase & {
      outcome: 'added'
      videoId: number
      videoCode: string
      resourceId: number
      resourceKind: import('./videoTypes').VideoResourceKind
      createdVideo: boolean
    })
  | (LibraryScanFileAuditBase & {
      outcome: 'updated'
      updateKind: 'relocated' | 'metadata_refreshed' | 'strm_target_synced'
      videoId: number
      videoCode: string
      resourceId: number
      resourceKind: import('./videoTypes').VideoResourceKind
    })
  | (LibraryScanFileAuditBase & {
      outcome: 'pending'
      normalizedCode: string | null
      groupId: number | null
      addedToQueue: boolean
    })
  | (LibraryScanFileAuditBase & {
      outcome: 'skipped'
      skipReason: 'unchanged' | 'below_min_duration' | 'duplicate'
      videoId?: number
      videoCode?: string
      resourceId?: number
      resourceKind?: import('./videoTypes').VideoResourceKind
    })
  | (LibraryScanFileAuditBase & { outcome: 'unrecognized' })
  | (LibraryScanFileAuditBase & {
      outcome: 'strm_failure'
      failureCode: StrmScanFailureCode
      message: string
    })
  | (LibraryScanFileAuditBase & {
      outcome: 'processing_failure'
      message: string
    })

export interface LibraryScanResourceAuditEntry {
  resourceId: number
  videoId: number
  videoCode: string
  videoTitle: string | null
  resourceKind: import('./videoTypes').VideoResourceKind
  /** Local locator or STRM source path. External targets are never persisted. */
  sourcePath: string | null
  displayName: string | null
  reason: 'missing' | 'removed_library_path' | 'promoted_after_removal'
}

export interface LibraryScanDeletedVideoAuditEntry {
  videoId: number
  videoCode: string
  videoTitle: string | null
  reason: 'resource_less'
}

export interface LibraryScanPendingGroupAuditEntry {
  groupId: number
  normalizedCode: string
  resourceCount: number
}

export interface LibraryScanAudit {
  schemaVersion: 1
  libraryId: number
  runId: string
  configRevision: number
  trigger: LibraryScanTrigger
  startedAt: string
  finishedAt: string
  status: LibraryScanStatus
  files: LibraryScanFileAuditEntry[]
  removedResources: LibraryScanResourceAuditEntry[]
  promotedResources: LibraryScanResourceAuditEntry[]
  deletedVideos: LibraryScanDeletedVideoAuditEntry[]
  pendingGroups: LibraryScanPendingGroupAuditEntry[]
}

export interface LibraryScanLatestSnapshot {
  summary: LibraryScanSummary | null
  audit: LibraryScanAudit | null
  unrecognized: Array<{
    rootId: number
    filePath: string
  }>
}

// ---- Scan results ----

export interface ScanResult {
  libraryId: number
  runId: string
  scannedFiles: number
  imported: number
  skipped: number
  /** Files skipped because local duration is below the scan import threshold. */
  skippedShort: number
  failed: number
  /** Same-code resource groups that require an explicit ownership decision. */
  pendingGroups: number
  /** Newly discovered resources retained outside the ordinary library for confirmation. */
  pendingResources: number
  cancelled?: boolean
  /** Videos whose file was moved/renamed but code matched — metadata kept, path updated. */
  relocated: number
  /** Existing local resources whose fingerprint, size, or duration was refreshed. */
  refreshed: number
  /** Missing local resource records removed from accessible configured folders. */
  removed: number
  /** Primary resources promoted after missing local resources were removed. */
  promoted: number
  /** Resource-less memberships removed by the opt-in safe post-scan cleanup. Does not delete global videos. */
  deletedVideos: number
  /** Configured roots that were missing or unreadable and therefore preserved. */
  offlineFolders: string[]
  newCodes: string[]
  /** Absolute paths of files whose 番号 could not be parsed from the filename. */
  unrecognizedFiles: string[]
  /** Safe, bounded STRM failures from this scan. Never contains target content. */
  strmFailures: StrmScanFailure[]
  /** STRM failures omitted after the persisted/display limit. */
  omittedStrmFailures: number
}

export interface PendingScanResource {
  id: number
  libraryId: number
  groupId: number
  rootId: number
  filePath: string
  sourceKind: 'local' | 'strm'
  targetKind: import('./videoTypes').ExternalVideoResourceKind | null
  /** Masked target display. The complete snapshot remains main-process only. */
  targetDisplay: string | null
  sizeBytes: number | null
  durationSeconds: number | null
  fileMtimeMs: number | null
  displayName: string | null
}

export interface PendingScanGroup {
  id: number
  libraryId: number
  normalizedCode: string
  revision: number
  createdAt: string
  updatedAt: string
  resources: PendingScanResource[]
}

export type PendingScanResourceTarget =
  | { kind: 'existing'; videoId: number }
  | { kind: 'new'; groupKey: string }

export interface PendingScanResourceAssignment {
  resourceId: number
  target: PendingScanResourceTarget
}

export interface PendingScanGroupResolution {
  expectedRevision: number
  assignments: PendingScanResourceAssignment[]
  /** Optional primary overrides keyed by a `new` target's groupKey. */
  primaryResourceIds?: Record<string, number>
}

export interface PendingScanGroupResolutionResult {
  assignedResources: number
  existingVideoIds: number[]
  createdVideoIds: number[]
}

export interface ScanProgress {
  scanned: number
  imported: number
  currentFile: string
}

export interface LibraryScanProgressEvent {
  libraryId: number
  runId: string
  progress: ScanProgress
}

export type LibraryScanEvent =
  | {
      phase: 'started'
      libraryId: number
      runId: string
      trigger: LibraryScanTrigger
    }
  | {
      phase: 'progress'
      libraryId: number
      runId: string
      trigger: LibraryScanTrigger
      progress: ScanProgress
    }
  | {
      phase: 'completed'
      libraryId: number
      runId: string
      trigger: LibraryScanTrigger
      result: ScanResult
    }
  | {
      phase: 'failed'
      libraryId: number
      runId: string
      trigger: LibraryScanTrigger
      error: string
    }

/** Outcome of renaming an unrecognized file and importing it into an explicit target. */
export interface RenameImportResult {
  /** New absolute path after rename. */
  newPath: string
  /** New file name (with extension). */
  newName: string
  /** Whether the renamed file parsed into a code and was imported. */
  imported: boolean
  /** Normalized user-supplied code used for the explicit import. */
  code: string
}

/** Outcome of manual import with a user-supplied code (no format validation). */
export interface ManualImportResult {
  code: string
  imported: boolean
  /** Path already registered in the library. */
  skippedPath?: boolean
  /** Same code exists elsewhere — file path updated. */
  relocated?: boolean
}

/** Progress for full-library asset encrypt/decrypt migration. */
export interface AssetCryptoProgress {
  phase: 'encrypt' | 'decrypt' | 'relocate'
  current: number
  total: number
  currentFile: string
  status: 'running' | 'done' | 'error'
  error?: string
}

export interface PlayResult {
  ok: boolean
  /** True when the file no longer exists on disk. */
  fileMissing?: boolean
  error?: string
}
