import type { Video } from './videoTypes'
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
