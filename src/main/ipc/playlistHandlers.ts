import { IPC } from '@shared/ipc-channels'
import type { SortDir } from '@shared/commonTypes'
import type { PlaylistDetail, PlaylistListItem, PlaylistVideoSortBy, PlaylistVideoMembership } from '@shared/playlistTypes'
import {
  addVideoToPlaylist,
  getPlaylistDetail,
  listPlaylists,
  listPlaylistsForVideo,
  removeVideoFromPlaylist
} from '../db/playlistRepo'
import { createPlaylist, deletePlaylist, updatePlaylist } from '../services/playlistService'
import { appCommandAdapter } from './appContractAdapter'

export function registerPlaylistHandlers(): void {
  appCommandAdapter.register(IPC.PLAYLIST_LIST, (): PlaylistListItem[] => listPlaylists())

  appCommandAdapter.register(
    IPC.PLAYLIST_GET,
    (
      id: number,
      sortBy?: PlaylistVideoSortBy,
      sortDir?: SortDir
    ): PlaylistDetail | null => getPlaylistDetail(id, { sortBy, sortDir })
  )

  appCommandAdapter.register(IPC.PLAYLIST_CREATE, (input): number =>
    createPlaylist(input)
  )

  appCommandAdapter.register(IPC.PLAYLIST_UPDATE, (id, input): boolean => {
    updatePlaylist(id, input)
    return true
  })

  appCommandAdapter.register(IPC.PLAYLIST_DELETE, (id): boolean => {
    deletePlaylist(id)
    return true
  })

  appCommandAdapter.register(IPC.PLAYLIST_LIST_FOR_VIDEO, (videoId): PlaylistVideoMembership[] =>
    listPlaylistsForVideo(videoId)
  )

  appCommandAdapter.register(IPC.PLAYLIST_ADD_VIDEO, (playlistId, videoId): boolean =>
    addVideoToPlaylist({ playlistId, videoId })
  )

  appCommandAdapter.register(IPC.PLAYLIST_REMOVE_VIDEO, (playlistId, videoId): boolean =>
    removeVideoFromPlaylist({ playlistId, videoId })
  )
}
