import type { PlaylistCreateInput, PlaylistUpdateInput } from '@shared/playlistTypes'
import {
  createPlaylistRecord,
  deletePlaylistRecord,
  getPlaylistById,
  updatePlaylistRecord
} from '@library/db/playlistRepo'
import { mediaAssetStore } from './mediaAssetStore'

export function createPlaylist(input: PlaylistCreateInput): number {
  const name = input.name.trim()
  if (!name) throw new Error('清单名称不能为空')
  const normalized: PlaylistCreateInput = {
    ...input,
    name,
    description: input.description?.trim() || null
  }
  return mediaAssetStore.coordinateDatabaseChange(() => {
    const coverRelPath = normalized.coverSourcePath
      ? mediaAssetStore.importPlaylistCover(normalized.name, normalized.coverSourcePath)
      : null
    return createPlaylistRecord(normalized, coverRelPath)
  })
}

export function updatePlaylist(id: number, input: PlaylistUpdateInput): void {
  const name = input.name.trim()
  if (!name) throw new Error('清单名称不能为空')
  const normalized: PlaylistUpdateInput = {
    ...input,
    name,
    description: input.description?.trim() || null
  }
  mediaAssetStore.coordinateDatabaseChange(() => {
    const coverRelPath = normalized.coverSourcePath
      ? mediaAssetStore.importPlaylistCover(normalized.name, normalized.coverSourcePath)
      : undefined
    const oldCoverPath = updatePlaylistRecord(id, normalized, coverRelPath)
    if (oldCoverPath && oldCoverPath !== coverRelPath) {
      mediaAssetStore.deleteBestEffort(oldCoverPath)
    }
  })
}

export function deletePlaylist(id: number): void {
  mediaAssetStore.coordinateDatabaseChange(() => {
    const playlist = getPlaylistById(id)
    if (!playlist) return
    const coverPath = deletePlaylistRecord(id)
    mediaAssetStore.deleteBestEffort(coverPath)
  })
}
