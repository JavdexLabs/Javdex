import { IPC } from '@shared/ipc-channels'
import type { SortDir } from '@shared/commonTypes'
import type { PlaylistVideoSortBy } from '@shared/playlistTypes'
import type { CatalogBackend } from '../application/catalogBackend'
import { ipcMutation, ipcPlaylistMutation } from '../application/mutationContext'
import { structuredError } from '@shared/protocol/errors'
import { appCommandAdapter } from './appContractAdapter'
import { uploadCatalogImageSource } from '../application/remoteCatalogImage'

export function registerPlaylistHandlers(backend: CatalogBackend): void {
  appCommandAdapter.register(IPC.PLAYLIST_LIST_PAGE, (query) =>
    backend.playlists.listPage(query)
  )
  appCommandAdapter.register(IPC.PLAYLIST_METADATA, (id, sortBy, sortDir) =>
    backend.playlists.metadata({
      playlistId: id,
      sortBy,
      sortDir
    })
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
      backend.playlists.get({ playlistId: id, sortBy, sortDir })
  )

  appCommandAdapter.register(IPC.PLAYLIST_CREATE, async (input) => {
    if (backend.mode !== 'remote' || !input.coverSourcePath) {
      return backend.playlists.create(input, ipcMutation())
    }
    const { coverSourcePath, ...fields } = input
    const cover = await uploadCatalogImageSource(backend, 'playlistCover', {
      source: 'file',
      sourcePath: coverSourcePath
    })
    return backend.playlists.create({ ...fields, cover }, ipcMutation() as never)
  })

  appCommandAdapter.register(IPC.PLAYLIST_UPDATE, async (id, input, expectedVersions) => {
    if (backend.mode === 'remote' && !expectedVersions?.P) throw structuredError('INVALID_INPUT', '清单缺少版本信息，请刷新后重试')
    if (backend.mode !== 'remote') {
      return backend.playlists.update({ playlistId: id, ...input }, await ipcPlaylistMutation(backend, id, expectedVersions))
    }
    const { coverSourcePath, removeCover, ...fields } = input
    const cover = coverSourcePath
      ? await uploadCatalogImageSource(backend, 'playlistCover', { source: 'file', sourcePath: coverSourcePath })
      : removeCover ? { kind: 'clear' as const } : undefined
    return backend.playlists.update({
      playlistId: id,
      ...fields,
      ...(cover ? { cover } : {})
    }, await ipcPlaylistMutation(backend, id, expectedVersions) as never)
  })

  appCommandAdapter.register(IPC.PLAYLIST_DELETE, async (id, expectedVersions) => {
    if (backend.mode === 'remote' && !expectedVersions?.P) throw structuredError('INVALID_INPUT', '清单缺少版本信息，请刷新后重试')
    return backend.playlists.delete({ playlistId: id }, await ipcPlaylistMutation(backend, id, expectedVersions))
  })

  appCommandAdapter.register(IPC.PLAYLIST_LIST_FOR_VIDEO, (videoId) =>
    backend.playlists.listForVideo({ videoId })
  )

  appCommandAdapter.register(IPC.PLAYLIST_ADD_VIDEO, async (playlistId, videoId, expectedVersions) =>
    backend.playlists.addVideo({ playlistId, videoId }, await ipcPlaylistMutation(backend, playlistId, expectedVersions))
  )

  appCommandAdapter.register(IPC.PLAYLIST_REMOVE_VIDEO, async (playlistId, videoId, expectedVersions) =>
    backend.playlists.removeVideo({ playlistId, videoId }, await ipcPlaylistMutation(backend, playlistId, expectedVersions))
  )
}
