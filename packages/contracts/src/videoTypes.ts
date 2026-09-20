import type { z } from 'zod'
import type {
  videoTagSchema,
  videoResourceKindSchema,
  videoDetailSchema,
  videoResourceDetailSchema,
  videoExternalStatsSchema,
  videoAssetSchema,
  videoResourceSchema,
  videoSchema
} from './catalogDetailSchemas'
import type { ScrapedStatus } from './commonTypes'
import type {
  DirectorAssignmentInput,
  OrganizationAssignmentInput,
  SeriesAssignmentInput
} from './classificationTypes'
import type { RelatedLinkInput } from './relatedLinkTypes'

export type VideoResourceKind = z.infer<typeof videoResourceKindSchema>
export type VideoResourceFilter = VideoResourceKind | 'none'
export type VideoPendingScrapeFilter = 'all' | 'pending' | 'none'
export type LinkVideoResourceKind = Extract<VideoResourceKind, 'direct' | 'web'>
export type ExternalVideoResourceKind = Exclude<VideoResourceKind, 'local'>
export type VideoResourceSizeUnit = 'MB' | 'GB' | 'TB'

/** Every manual resource import must name its destination explicitly. */
export type VideoResourceImportTarget =
  | { kind: 'new' }
  | { kind: 'existing'; videoId: number }

export type VideoResource = z.infer<typeof videoResourceSchema>

export type LocalVideoResource = VideoResource & { kind: 'local' }

export type VideoResourceDetail = z.infer<typeof videoResourceDetailSchema>

export interface VideoLinkResourceFields {
  url: string
  kind?: ExternalVideoResourceKind
  displayName?: string | null
  sizeBytes?: number | null
}

export interface VideoLinkResourceImportInput {
  libraryId: number
  code: string
  target: VideoResourceImportTarget
  /** Playable resource URL. Omit to register a video without a playback resource. */
  url?: string
  kind?: ExternalVideoResourceKind
  displayName?: string | null
  sizeBytes?: number | null
  /** Additional playback resources created in the same import. */
  resources?: VideoLinkResourceFields[]
  /** Related HTTP(S) links; merged into the video, not used for playback. */
  links?: RelatedLinkInput[]
}

export interface VideoLinkResourceUpdateInput {
  url: string
  kind?: ExternalVideoResourceKind
  displayName?: string | null
  sizeBytes?: number | null
}

export interface VideoResourceImportResult {
  videoId: number
  resource: VideoResource | null
  createdVideo: boolean
}

export interface VideoMergeInput {
  retainedVideoId: number
  sourceVideoId: number
}

export interface VideoMergeResult {
  retainedVideoId: number
  deletedVideoId: number
}

export interface VideoResourceSplitResult {
  videoId: number
  resourceId: number
}

export interface VideoResourceLinkCheckResult {
  ok: boolean
  status?: number
  sizeBytes?: number | null
  error?: string
}

/** Explicit confirmation that removing the last resource keeps the canonical video. */
export type LastVideoResourceRemovalMode = 'retain-video'

export interface VideoResourceRemovalResult {
  videoDeleted: boolean
  promotedResourceId: number | null
}

export type Video = z.infer<typeof videoSchema>

export type TagOrigin = 'manual' | 'scraped'

/** Fields rendered by a poster card; long descriptions and editing data stay in detail reads. */
export type VideoCard = Pick<Video,
  'id' | 'code' | 'title' | 'cover_path' | 'scraped_status' | 'has_pending_scrape' | 'resource_kinds'>

export type VideoTag = z.infer<typeof videoTagSchema>

export type VideoAsset = z.infer<typeof videoAssetSchema>

export type VideoExternalStats = z.infer<typeof videoExternalStatsSchema>

export interface VideoSampleImportInput {
  source: 'file' | 'url'
  sourcePath?: string | null
  remoteUrl?: string | null
}

export type VideoDetail = z.infer<typeof videoDetailSchema>

export type StoredVideoDetail = Omit<VideoDetail, 'resources'> & {
  resources: VideoResource[]
}

/** Maximum number of videos accepted by one `video:list` IPC request. */
export const VIDEO_LIST_PAGE_LIMIT_MAX = 200

export interface VideoQuery {
  search?: string
  scrapedStatus?: ScrapedStatus | 'all'
  minRating?: number
  year?: number | 'all'
  actressId?: number
  tagId?: number
  tagIds?: number[]
  makerOrganizationId?: number
  publisherOrganizationId?: number
  seriesId?: number
  directorId?: number
  codePrefix?: string
  /** OR filter; `none` matches videos with zero resource rows. */
  resourceKinds?: VideoResourceFilter[]
  pendingScrape?: VideoPendingScrapeFilter
  sortBy?: 'add_time' | 'release_date' | 'rating' | 'code'
  sortDir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export const VIDEO_FIELD_UPDATE_KEYS = [
  'title',
  'summary',
  'release_date',
  'duration_seconds'
] as const

export type VideoFieldUpdateInput = Partial<
  Pick<Video, (typeof VIDEO_FIELD_UPDATE_KEYS)[number]>
>

export interface VideoEditInput {
  title?: string | null
  summary?: string | null
  release_date?: string | null
  makerOrganization?: OrganizationAssignmentInput | null
  publisherOrganization?: OrganizationAssignmentInput | null
  directorAssignment?: DirectorAssignmentInput | null
  seriesAssignment?: SeriesAssignmentInput | null
  duration_seconds?: number | null
  rating?: number
  tags?: string[]
  actressesFemale?: string[]
  actressesMale?: string[]
  coverSourcePath?: string
  links?: RelatedLinkInput[]
}

export interface VideoListResult {
  items: Video[]
  total: number
}

export interface CorrectImportResult {
  code: string
  previousCode: string
  mergedIntoId?: number
  /** The rename was not applied; the caller must warn before retrying with discard enabled. */
  pendingDiscardRequired?: boolean
}
