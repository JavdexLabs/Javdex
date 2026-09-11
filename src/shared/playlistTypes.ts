import type { Video, VideoCard, VideoResourceFilter } from './videoTypes'
import type { RelatedLink, RelatedLinkInput } from './relatedLinkTypes'

export interface Playlist {
  id: number
  name: string
  description: string | null
  cover_path: string | null
  created_at: string
  updated_at: string | null
}

export interface PlaylistListItem extends Playlist {
  video_count: number
  preview_cover_path: string | null
}

export interface PlaylistDetail extends Playlist {
  videos: Video[]
  links: RelatedLink[]
}

export type PlaylistVideoSortBy = 'added_at' | 'release_date'

export interface PlaylistVideoMembership extends PlaylistListItem {
  contains_video: boolean
}

export interface PlaylistCreateInput {
  name: string
  description?: string | null
  /** Absolute path to a local image file to import as playlist cover. */
  coverSourcePath?: string | null
  links?: RelatedLinkInput[]
}

export interface PlaylistUpdateInput extends PlaylistCreateInput {
  /** Remove the custom playlist cover and fall back to the first video cover. */
  removeCover?: boolean
}


export interface PlaylistPageQuery {
  sortBy?: PlaylistVideoSortBy
  sortDir?: 'asc' | 'desc'
  resourceKinds?: VideoResourceFilter[]
  limit?: number
  offset?: number
}

export interface PlaylistMetadata extends Playlist {
  links: RelatedLink[]
  preview_cover_path: string | null
}

export interface PlaylistVideosPage {
  videos: VideoCard[]
  total: number
  filteredTotal: number
  limit: number
  offset: number
}

export interface PlaylistPage extends PlaylistMetadata, PlaylistVideosPage {}

/** Display-only fields; mutations use IDs or the caller's full create/edit input. */
export interface PlaylistBrowseItem {
  id: number
  name: string
  description: string | null
  preview_cover_path: string | null
  video_count: number
  contains_video: boolean
}
export interface PlaylistListQuery {
  search?: string
  limit?: number
  offset?: number
  videoId?: number
  /** Picker search historically used locale folding; list-page search did not. */
  locale?: string
}
export interface PlaylistListPage {
  items: PlaylistBrowseItem[]
  total: number
  offset: number
  limit: number
  hasExactName: boolean
}
