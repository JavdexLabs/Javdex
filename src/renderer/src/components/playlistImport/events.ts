const PLAYLIST_IMPORT_COMPLETED_EVENT = 'javdex:playlist-import-completed'

interface PlaylistImportCompletedDetail {
  playlistId: number
}

export function notifyPlaylistImportCompleted(playlistId: number): void {
  window.dispatchEvent(
    new CustomEvent<PlaylistImportCompletedDetail>(PLAYLIST_IMPORT_COMPLETED_EVENT, {
      detail: { playlistId }
    })
  )
}

export function onPlaylistImportCompleted(
  listener: (playlistId: number) => void
): () => void {
  const handle = (event: Event): void => {
    const detail = (event as CustomEvent<Partial<PlaylistImportCompletedDetail>>).detail
    if (typeof detail?.playlistId === 'number') listener(detail.playlistId)
  }
  window.addEventListener(PLAYLIST_IMPORT_COMPLETED_EVENT, handle)
  return () => window.removeEventListener(PLAYLIST_IMPORT_COMPLETED_EVENT, handle)
}
