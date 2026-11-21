import type { PlaylistListQuery } from '@shared/playlistTypes'
import { useEffect } from 'react'
import { api } from '../api'
import { useContinuousPage } from './useContinuousPage'
import { useRecentPlayback } from './useRecentPlayback'

export function usePlaylistBrowsePage(query: PlaylistListQuery, enabled = true) {
  const scope = JSON.stringify([query.search ?? '', query.limit ?? 60, query.videoId, query.locale, query.kind])
  const result = useContinuousPage(scope, query.limit ?? 60,
    offset => api.playlists.listPage({ ...query, offset }), enabled, query.offset ?? 0)
  return { ...result, data: result.page ? { ...result.page, items: result.items, total: result.total } : undefined }
}

export function useBuiltinPlaylists(search = '') {
  const catalog = usePlaylistBrowsePage({ search, offset: 0, limit: 2, kind: 'builtin' })
  const recent = useRecentPlayback()
  const items = [...catalog.items].sort((a, b) => Number(b.system_kind === 'favorites') - Number(a.system_kind === 'favorites'))
  const history = recent.metadata
  const filteredHistory = history && `${history.name} ${history.description}`.toLowerCase().includes(search.trim().toLowerCase()) ? history : null
  if (filteredHistory) items.push(filteredHistory)

  const reload = catalog.reload
  useEffect(() => {
    window.addEventListener('builtin-playlist-changed', reload)
    return () => window.removeEventListener('builtin-playlist-changed', reload)
  }, [reload])

  return {
    items,
    total: catalog.known ? catalog.total + (filteredHistory ? 1 : 0) : undefined,
    loading: catalog.loading || Boolean(api.recentPlayback && !history && !recent.error),
    error: catalog.error,
    reload,
    recentError: recent.error,
    reloadRecent: recent.reload
  }
}
