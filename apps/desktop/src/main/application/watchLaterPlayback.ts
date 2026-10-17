import type { CatalogBackend } from './catalogBackend'
import { ipcPlaylistMutation } from './mutationContext'
import { expectedPlaylistVersion } from '@shared/protocol/versions'

/** Called only after the player successfully accepted a playback request. */
export async function removePlayedWatchLater(backend: CatalogBackend, videoId: number, current = (): boolean => true): Promise<void> {
  const identity = JSON.stringify(backend.identity), generation = backend.generation
  const valid = (): boolean => current() && generation === backend.generation && identity === JSON.stringify(backend.identity)
  if (!valid()) return
  const playlists = await backend.playlists.listForVideo({ videoId })
  if (!valid()) return
  const playlist = playlists.find(p => p.system_kind === 'watch_later' && p.remove_after_play === 1 && p.contains_video)
  if (!playlist) return
  const mutation = await ipcPlaylistMutation(backend, playlist.id, expectedPlaylistVersion(playlist))
  if (valid()) await backend.playlists.removeVideo({ playlistId: playlist.id, videoId }, mutation)
}
