import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { parseActressVideoPath } from './actressRoutes'
import { facetListPath, parseFacetVideoPath } from './facetRoutes'
import { parseLibraryVideoPath } from './libraryRoutes'
import { clearAllListViewMemory } from './listViewMemory'
import { parsePlaylistVideoPath } from './playlistRoutes'

function reloadListTarget(pathname: string): string | null {
  if (parseLibraryVideoPath(pathname)) return '/'
  if (parseActressVideoPath(pathname)) return '/actresses'
  if (parsePlaylistVideoPath(pathname)) return '/playlists'

  const facet = parseFacetVideoPath(pathname)
  if (facet) return facetListPath(facet.facetType)

  return null
}

/**
 * On browser/Electron reload, drop URL filters and in-memory scroll (product choice).
 * In-session SPA navigation keeps state via URL + memory.
 */
export default function ResetListStateOnReload(): null {
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    const entry = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined
    if (entry?.type !== 'reload') return

    clearAllListViewMemory()

    const path = location.pathname
    const target = reloadListTarget(path)
    if (target) {
      navigate(target, { replace: true })
      return
    }
    if (location.search) {
      navigate({ pathname: path, search: '' }, { replace: true })
    }
  }, [])

  return null
}
