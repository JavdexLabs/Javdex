import { parseActressVideoPath } from './actressRoutes'
import { parseFacetVideoPath } from './facetRoutes'
import { parseLibraryVideoPath } from './libraryRoutes'
import { parsePlaylistVideoPath } from './playlistRoutes'

/** Scope key for detail poster backgrounds (actress:id / video:id). */
export function getDetailPosterScope(pathname: string): string | null {
  const library = parseLibraryVideoPath(pathname)
  if (library?.actressId != null) return `actress:${library.actressId}`
  if (library?.videoId != null) return `video:${library.videoId}`

  const actress = parseActressVideoPath(pathname)
  if (actress?.stackedActressId != null) return `actress:${actress.stackedActressId}`
  if (actress?.videoId != null) return `video:${actress.videoId}`
  if (actress?.actressId != null) return `actress:${actress.actressId}`

  const facet = parseFacetVideoPath(pathname)
  if (facet?.actressId != null) return `actress:${facet.actressId}`
  if (facet?.videoId != null) return `video:${facet.videoId}`

  const playlist = parsePlaylistVideoPath(pathname)
  if (playlist?.actressId != null) return `actress:${playlist.actressId}`
  if (playlist?.videoId != null) return `video:${playlist.videoId}`

  return null
}
