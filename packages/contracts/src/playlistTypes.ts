import type { z } from 'zod'
import type {
  playlistSchema,
  playlistDetailSchema,
  playlistMetadataSchema,
  playlistVideosPageSchema,
  playlistPageSchema,
  playlistBrowseItemSchema,
  playlistListPageSchema
} from './playlistSchemas'
import type { VideoResourceFilter } from './videoTypes'
import type { RelatedLinkInput } from './relatedLinkTypes'

export type Playlist = z.infer<typeof playlistSchema>

export interface PlaylistListItem extends Playlist {
  video_count: number
  preview_cover_path: string | null
}

export type PlaylistDetail = z.infer<typeof playlistDetailSchema>

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

export type PlaylistMetadata = z.infer<typeof playlistMetadataSchema>

export type PlaylistVideosPage = z.infer<typeof playlistVideosPageSchema>

export type PlaylistPage = z.infer<typeof playlistPageSchema>

/** Display-only fields; mutations use IDs or the caller's full create/edit input. */
export type PlaylistBrowseItem = z.infer<typeof playlistBrowseItemSchema>
export interface PlaylistListQuery {
  search?: string
  limit?: number
  offset?: number
  videoId?: number
  /** Picker search historically used locale folding; list-page search did not. */
  locale?: string
}
export type PlaylistListPage = z.infer<typeof playlistListPageSchema>
