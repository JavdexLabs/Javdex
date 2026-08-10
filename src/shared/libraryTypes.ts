/** Free-text metadata dimensions backed by a column on `videos`. */
export type FacetType = 'maker' | 'publisher' | 'series' | 'director'

export interface FacetItem {
  value: string
  video_count: number
  /** A representative cover for the list thumbnail. */
  cover_path: string | null
}

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
  videosBecomingResourceLess: number
}

export type LibraryScanTrigger = 'manual' | 'startup' | 'interval' | 'resume'
export type LibraryScanStatus = 'success' | 'cancelled' | 'failed'

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
  offlineFolders: string[]
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
}

export interface ScanProgress {
  scanned: number
  imported: number
  currentFile: string
}

/** Outcome of renaming an unrecognized file on disk and attempting re-import. */
export interface RenameImportResult {
  /** New absolute path after rename. */
  newPath: string
  /** New file name (with extension). */
  newName: string
  /** Whether the renamed file parsed into a code and was imported. */
  imported: boolean
  /** Parsed code, if the new name was recognizable. */
  code: string | null
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
