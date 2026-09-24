export const NFO_EXPORT_PROFILE_IDS = [
  'portable-v1',
  'jellyfin-current',
  'emby-kodi-conservative',
  'plex-nfo-1.43.1+',
  'infuse-current'
] as const

export type NfoExportProfileId = (typeof NFO_EXPORT_PROFILE_IDS)[number]
export type NfoExportCollisionPolicy = 'skip' | 'replace'

/** File attachments, deliberately outside consumer artwork directories. */
export const NFO_SAMPLE_BACKUP_DIRECTORY = 'javdex-samples'

export interface NfoExportPreferences {
  libraryIds: number[]
  profileId: NfoExportProfileId
  includeCover: boolean
  includeFanart: boolean
  includeSamples: boolean
  includeActorAvatars: boolean
}

export const DEFAULT_NFO_EXPORT_PREFERENCES: NfoExportPreferences = {
  libraryIds: [],
  profileId: 'portable-v1',
  includeCover: true,
  includeFanart: true,
  includeSamples: false,
  includeActorAvatars: false
}

export interface NfoExportLibraryOption {
  id: number
  name: string
}

export interface NfoExportProfileOption {
  id: NfoExportProfileId
  label: string
  description: string
  warning?: string
}

export interface NfoExportOptions {
  libraries: NfoExportLibraryOption[]
  profiles: NfoExportProfileOption[]
  preferences: NfoExportPreferences
}

export interface NfoExportPlanRequest extends NfoExportPreferences {
  collisionPolicy: NfoExportCollisionPolicy
}

export type NfoExportFileKind =
  | 'nfo'
  | 'cover'
  | 'landscape'
  | 'fanart'
  | 'sample'
  | 'actor-avatar'

export type NfoExportPlanAction =
  | 'create'
  | 'replace'
  | 'skip-existing'
  | 'conflict'
  | 'unavailable'

export interface NfoExportPlanFile {
  id: string
  kind: NfoExportFileKind
  displayName: string
  videoCode: string
  action: NfoExportPlanAction
  bytes: number | null
  warning?: string
}

export interface NfoExportPlanSummary {
  videoCount: number
  resourceCount: number
  fileCount: number
  createCount: number
  replaceCount: number
  skipCount: number
  conflictCount: number
  unavailableCount: number
  skippedNoAnchorCount: number
  warningCount: number
  sampleCount: number
  estimatedBytes: number
}

export interface NfoExportPlanPreview {
  planId: string
  request: NfoExportPlanRequest
  summary: NfoExportPlanSummary
  files: NfoExportPlanFile[]
  warnings: string[]
}

export interface NfoExportStartResult {
  taskId: string
}

export type NfoExportResultDisposition =
  | 'written'
  | 'skipped-existing'
  | 'stale-plan'
  | 'conflict'
  | 'failed'
  | 'cancelled'
  | 'unavailable'

export interface NfoExportReportItem {
  id: string
  kind: NfoExportFileKind
  displayName: string
  videoCode: string
  disposition: NfoExportResultDisposition
  message?: string
}

export interface NfoExportReport {
  taskId: string
  startedAt: string
  finishedAt: string
  terminated: boolean
  writtenCount: number
  skippedCount: number
  failedCount: number
  items: NfoExportReportItem[]
}

export interface NfoExportProgressEvent {
  taskId: string
  completed: number
  total: number
  current?: Pick<NfoExportPlanFile, 'id' | 'kind' | 'displayName' | 'videoCode'>
}

export type NfoExportStateEvent =
  | { taskId: string; state: 'running' }
  | { taskId: string; state: 'finished'; report: NfoExportReport }
