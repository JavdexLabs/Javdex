import type { PlaylistCreateInput, PlaylistUpdateInput } from '@shared/types'
import {
  createPlaylistRecord,
  deletePlaylistRecord,
  getPlaylistById,
  updatePlaylistRecord
} from '../db/playlistRepo'
import { deleteAsset, importPlaylistCoverFromFile } from './assetService'

export function createPlaylist(input: PlaylistCreateInput): number {
  const name = input.name.trim()
  if (!name) throw new Error('清单名称不能为空')
  const normalized: PlaylistCreateInput = {
    ...input,
    name,
    description: input.description?.trim() || null
  }
  const coverRelPath = normalized.coverSourcePath
    ? importPlaylistCoverFromFile(normalized.name, normalized.coverSourcePath)
    : null
  return createPlaylistRecord(normalized, coverRelPath)
}

export function updatePlaylist(id: number, input: PlaylistUpdateInput): void {
  const name = input.name.trim()
  if (!name) throw new Error('娓呭崟鍚嶇О涓嶈兘涓虹┖')
  const normalized: PlaylistUpdateInput = {
    ...input,
    name,
    description: input.description?.trim() || null
  }
  const coverRelPath = normalized.coverSourcePath
    ? importPlaylistCoverFromFile(normalized.name, normalized.coverSourcePath)
    : undefined
  const oldCoverPath = updatePlaylistRecord(id, normalized, coverRelPath)
  if (oldCoverPath && oldCoverPath !== coverRelPath) deleteAsset(oldCoverPath)
}

export function deletePlaylist(id: number): void {
  const playlist = getPlaylistById(id)
  if (!playlist) return
  const coverPath = deletePlaylistRecord(id)
  deleteAsset(coverPath)
}
