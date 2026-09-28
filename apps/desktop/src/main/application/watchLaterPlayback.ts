import type { CatalogBackend } from './catalogBackend'
import { ipcPlaylistMutation } from './mutationContext'
import { expectedPlaylistVersion } from '@shared/protocol/versions'

/** Called only after the player successfully accepted a playback request. */
export async function removePlayedWatchLater(backend: CatalogBackend, videoId: number): Promise<void> {
  const playlists = await backend.playlists.listForVideo({ videoId })
  const playlist = playlists.find(p => p.system_kind === 'watch_later' && p.remove_after_play === 1 && p.contains_video)
  if (!playlist) return
  await backend.playlists.removeVideo({ playlistId: playlist.id, videoId }, await ipcPlaylistMutation(backend, playlist.id, expectedPlaylistVersion(playlist)))
}
