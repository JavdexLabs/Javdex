import { IPC } from '@shared/ipc-channels'
import type { SortDir } from '@shared/commonTypes'
import type { PlaylistVideoSortBy } from '@shared/playlistTypes'
import type { CatalogBackend } from '../application/catalogBackend'
import { ipcMutation } from '../application/mutationContext'
import { appCommandAdapter } from './appContractAdapter'

export function registerPlaylistHandlers(backend: CatalogBackend): void {
  appCommandAdapter.register(IPC.PLAYLIST_LIST_PAGE, (query) =>
    backend.playlists.listPage(query)
  )
  appCommandAdapter.register(IPC.PLAYLIST_METADATA, (id, sortBy, sortDir) =>
    backend.playlists.metadata({
      playlistId: id,
      sortBy,
      sortDir
    } as never)
  )
  appCommandAdapter.register(IPC.PLAYLIST_VIDEO_PAGE, (id, query) =>
    backend.playlists.videoPage({ playlistId: id, ...query })
  )
  appCommandAdapter.register(IPC.PLAYLIST_GET_PAGE, (id, query) =>
    backend.playlists.getPage({ playlistId: id, ...query })
  )
  appCommandAdapter.register(IPC.PLAYLIST_LIST, () => backend.playlists.list({}))

  appCommandAdapter.register(
    IPC.PLAYLIST_GET,
    (id: number, sortBy?: PlaylistVideoSortBy, sortDir?: SortDir) =>
      backend.playlists.get({ playlistId: id, sortBy, sortDir } as never)
  )

  appCommandAdapter.register(IPC.PLAYLIST_CREATE, (input) =>
    backend.playlists.create(input as never, ipcMutation())
  )

  appCommandAdapter.register(IPC.PLAYLIST_UPDATE, (id, input) =>
    backend.playlists.update({ playlistId: id, ...input } as never, ipcMutation())
  )

  appCommandAdapter.register(IPC.PLAYLIST_DELETE, (id) =>
    backend.playlists.delete({ playlistId: id }, ipcMutation())
  )

  appCommandAdapter.register(IPC.PLAYLIST_LIST_FOR_VIDEO, (videoId) =>
    backend.playlists.listForVideo({ videoId })
  )

  appCommandAdapter.register(IPC.PLAYLIST_ADD_VIDEO, (playlistId, videoId) =>
    backend.playlists.addVideo({ playlistId, videoId }, ipcMutation())
  )

  appCommandAdapter.register(IPC.PLAYLIST_REMOVE_VIDEO, (playlistId, videoId) =>
    backend.playlists.removeVideo({ playlistId, videoId }, ipcMutation())
  )
}
