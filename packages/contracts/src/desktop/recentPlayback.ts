import type { PlaylistBrowseItem, PlaylistMetadata, PlaylistPageQuery } from '../playlistTypes'

/** Desktop virtual list identity; never a catalog playlist ID or mutation target. */
export const RECENT_PLAYBACK_LIST_ID = 0
export type RecentPlaybackPageQuery = Pick<PlaylistPageQuery, 'resourceKinds' | 'limit' | 'offset'>
export type RecentPlaybackMetadata = PlaylistMetadata & PlaylistBrowseItem & { local_kind: 'recently_played' }
