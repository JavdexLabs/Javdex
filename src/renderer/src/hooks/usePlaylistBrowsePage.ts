import type { PlaylistListQuery } from '@shared/playlistTypes'
import { api } from '../api'
import { useContinuousPage } from './useContinuousPage'

export function usePlaylistBrowsePage(query: PlaylistListQuery, enabled = true) {
  const scope = JSON.stringify([query.search ?? '', query.limit ?? 60, query.videoId, query.locale])
  const result = useContinuousPage(scope, query.limit ?? 60,
    offset => api.playlists.listPage({ ...query, offset }), enabled, query.offset ?? 0)
  return { ...result, data: result.page ? { ...result.page, items: result.items, total: result.total } : undefined }
}
