import { IPC } from '@shared/ipc-channels'
import type {
  PlaylistCreateInput,
  PlaylistDetail,
  PlaylistListItem,
  PlaylistUpdateInput,
  PlaylistVideoSortBy,
  PlaylistVideoSortDir,
  PlaylistVideoMembership
} from '@shared/types'
import {
  addVideoToPlaylist,
  getPlaylistDetail,
  listPlaylists,
  listPlaylistsForVideo,
  removeVideoFromPlaylist
} from '../db/playlistRepo'
import { createPlaylist, deletePlaylist, updatePlaylist } from '../services/playlistService'
import { registerHandler } from './shared'

export function registerPlaylistHandlers(): void {
  registerHandler(IPC.PLAYLIST_LIST, (): PlaylistListItem[] => listPlaylists())

  registerHandler(
    IPC.PLAYLIST_GET,
    (
      _e,
      id: number,
      sortBy?: PlaylistVideoSortBy,
      sortDir?: PlaylistVideoSortDir
    ): PlaylistDetail | null => getPlaylistDetail(id, { sortBy, sortDir })
  )

  registerHandler(IPC.PLAYLIST_CREATE, (_e, input: PlaylistCreateInput): number =>
    createPlaylist(input)
  )

  registerHandler(IPC.PLAYLIST_UPDATE, (_e, id: number, input: PlaylistUpdateInput): boolean => {
    updatePlaylist(id, input)
    return true
  })

  registerHandler(IPC.PLAYLIST_DELETE, (_e, id: number): boolean => {
    deletePlaylist(id)
    return true
  })

  registerHandler(IPC.PLAYLIST_LIST_FOR_VIDEO, (_e, videoId: number): PlaylistVideoMembership[] =>
    listPlaylistsForVideo(videoId)
  )

  registerHandler(IPC.PLAYLIST_ADD_VIDEO, (_e, playlistId: number, videoId: number): boolean =>
    addVideoToPlaylist({ playlistId, videoId })
  )

  registerHandler(IPC.PLAYLIST_REMOVE_VIDEO, (_e, playlistId: number, videoId: number): boolean =>
    removeVideoFromPlaylist({ playlistId, videoId })
  )
}
