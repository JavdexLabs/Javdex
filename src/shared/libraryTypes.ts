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
  path: string
  localResourceCount: number
  strmResourceCount: number
  videosBecomingResourceLess: number
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

// ---- Scan results ----

export interface ScanResult {
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
  /** Resource-less videos removed by the opt-in safe post-scan cleanup. */
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
  groupId: number
  filePath: string
  scanRoot: string
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
  normalizedCode: string
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

export type LibraryScanEvent =
  | { phase: 'started'; trigger: LibraryScanTrigger }
  | { phase: 'progress'; trigger: LibraryScanTrigger; progress: ScanProgress }
  | { phase: 'completed'; trigger: LibraryScanTrigger; result: ScanResult }
  | { phase: 'failed'; trigger: LibraryScanTrigger; error: string }

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
