import type { Playlist } from '@shared/playlistTypes'
import type { ImageThumbnailSize } from '@shared/imageVariants'
import { assetUrl } from '../api'
import favoritesCover from '../assets/playlist-favorites.png'
import watchLaterCover from '../assets/playlist-watch-later.png'
import recentCover from '../assets/playlist-recently-played.png'

export type PlaylistCoverData = Partial<Pick<Playlist, 'cover_path' | 'system_kind'>> & {
  preview_cover_path?: string | null
  local_kind?: 'recently_played'
}

/** Built-in artwork is a renderer asset, never a catalog path or a database default. */
export function playlistCoverSource(playlist: PlaylistCoverData, size?: ImageThumbnailSize): {
  url: string | null
  kind: 'custom' | 'builtin' | 'automatic' | 'empty'
} {
  if (playlist.cover_path) return { url: assetUrl(playlist.cover_path, size), kind: 'custom' }
  if (playlist.local_kind === 'recently_played') return { url: recentCover, kind: 'builtin' }
  if (playlist.system_kind === 'favorites') return { url: favoritesCover, kind: 'builtin' }
  if (playlist.system_kind === 'watch_later') return { url: watchLaterCover, kind: 'builtin' }
  const url = assetUrl(playlist.preview_cover_path, size)
  return { url, kind: url ? 'automatic' : 'empty' }
}
