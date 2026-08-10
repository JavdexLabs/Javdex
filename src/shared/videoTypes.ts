import type { Actress } from './actressTypes'
import type { ScrapedStatus, Tag } from './commonTypes'

export type VideoResourceKind = 'local' | 'direct' | 'web' | 'magnet' | 'ed2k'
export type VideoResourceFilter = VideoResourceKind | 'none'
export type LinkVideoResourceKind = Extract<VideoResourceKind, 'direct' | 'web'>
export type ExternalVideoResourceKind = Exclude<VideoResourceKind, 'local'>
export type VideoResourceSizeUnit = 'MB' | 'GB' | 'TB'

export interface VideoResource {
  id: number
  video_id: number
  kind: VideoResourceKind
  locator: string
  resource_key: string
  size_bytes: number | null
  duration_seconds: number | null
  file_mtime_ms: number | null
  display_name: string | null
  is_primary: number
  add_time: string
}

export type LocalVideoResource = VideoResource & { kind: 'local' }

export interface VideoResourceDetail extends Omit<VideoResource, 'locator' | 'resource_key'> {
  /** Safe display value; external resource credentials and query parameters are omitted. */
  display_locator: string
}

export interface VideoLinkResourceImportInput {
  code: string
  url: string
  kind?: ExternalVideoResourceKind
  displayName?: string | null
  sizeBytes?: number | null
}

export interface VideoLinkResourceUpdateInput {
  url: string
  kind?: ExternalVideoResourceKind
  displayName?: string | null
  sizeBytes?: number | null
}

export interface VideoResourceImportResult {
  videoId: number
  resource: VideoResource
  createdVideo: boolean
}

export interface VideoResourceLinkCheckResult {
  ok: boolean
  status?: number
  sizeBytes?: number | null
  error?: string
}

export type LastVideoResourceRemovalMode = 'retain-video' | 'delete-video'

export interface VideoResourceRemovalResult {
  videoDeleted: boolean
  promotedResourceId: number | null
}

export interface Video {
  id: number
  code: string
  title: string | null
  summary: string | null
  cover_path: string | null
  poster_path: string | null
  original_title: string | null
  rating: number
  release_date: string | null
  maker: string | null
  publisher: string | null
  series: string | null
  director: string | null
  duration_seconds: number | null
  scraped_status: ScrapedStatus
  last_scraped_at: string | null
  updated_at: string | null
  add_time: string
  primary_resource_kind?: VideoResourceKind | null
  resource_count?: number
  /** Primary kind first, followed by each remaining kind at most once. */
  resource_kinds?: VideoResourceKind[]
}

export type TagOrigin = 'manual' | 'scraped'

export interface VideoTag extends Tag {
  origin: TagOrigin
  source: string | null
}

export interface VideoAsset {
  id: number
  video_id: number
  type: 'cover' | 'poster' | 'sample' | string
  position: number
  remote_url: string | null
  local_path: string | null
  width: number | null
  height: number | null
  is_primary: number
  created_at: string | null
}

export interface VideoExternalStats {
  id: number
  video_id: number
  source: string
  rating_average: number | null
  rating_count: number | null
  fetched_at: string | null
}

export interface VideoSampleImportInput {
  source: 'file' | 'url'
  sourcePath?: string | null
  remoteUrl?: string | null
}

export interface VideoDetail extends Video {
  resources: VideoResourceDetail[]
  actresses: Actress[]
  tags: VideoTag[]
  assets: VideoAsset[]
  external_stats: VideoExternalStats[]
  resolved_duration_seconds?: number | null
}

export type StoredVideoDetail = Omit<VideoDetail, 'resources'> & {
  resources: VideoResource[]
}

export interface VideoQuery {
  search?: string
  scrapedStatus?: ScrapedStatus | 'all'
  minRating?: number
  year?: number | 'all'
  actressId?: number
  tagId?: number
  tagIds?: number[]
  maker?: string
  publisher?: string
  series?: string
  director?: string
  codePrefix?: string
  /** OR filter; `none` matches videos with zero resource rows. */
  resourceKinds?: VideoResourceFilter[]
  sortBy?: 'add_time' | 'release_date' | 'rating' | 'code'
  sortDir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface VideoEditInput {
  title?: string | null
  summary?: string | null
  release_date?: string | null
  maker?: string | null
  publisher?: string | null
  series?: string | null
  director?: string | null
  duration_seconds?: number | null
  rating?: number
  tags?: string[]
  actressesFemale?: string[]
  actressesMale?: string[]
  coverSourcePath?: string
}

export interface VideoListResult {
  items: Video[]
  total: number
}

export interface CorrectImportResult {
  code: string
  previousCode: string
  mergedIntoId?: number
}
