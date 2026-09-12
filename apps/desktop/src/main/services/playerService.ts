import { shell } from 'electron'
import fs from 'node:fs'
import {
  getPrimaryVideoResource,
  getVideoById,
  getVideoResourceInLibrary
} from '../db/videoRepo'
import { getMediaLibrary } from '../db/mediaLibraryRepo'
import type { PlayResult } from '@shared/libraryTypes'
import type { VideoResource } from '@shared/videoTypes'

interface PlayerServiceDependencies {
  getMediaLibrary: typeof getMediaLibrary
  getVideoById: typeof getVideoById
  getPrimaryVideoResource: typeof getPrimaryVideoResource
  getVideoResourceInLibrary: typeof getVideoResourceInLibrary
  fileExists: (filePath: string) => boolean
  openPath: (filePath: string) => Promise<string>
  openExternal: (url: string) => Promise<void>
  showItemInFolder: (filePath: string) => void
}

export interface PlayerService {
  playVideo(libraryId: number, videoId: number): Promise<PlayResult>
  openResource(libraryId: number, resourceId: number): Promise<PlayResult>
  revealVideo(libraryId: number, videoId: number): PlayResult
  revealResource(libraryId: number, resourceId: number): PlayResult
}

export function createPlayerService(
  dependencies: Partial<PlayerServiceDependencies> = {}
): PlayerService {
  const readMediaLibrary = dependencies.getMediaLibrary ?? getMediaLibrary
  const readVideo = dependencies.getVideoById ?? getVideoById
  const readPrimaryResource = dependencies.getPrimaryVideoResource ?? getPrimaryVideoResource
  const readResource = dependencies.getVideoResourceInLibrary ?? getVideoResourceInLibrary
  const fileExists = dependencies.fileExists ?? fs.existsSync
  const openPath = dependencies.openPath ?? ((filePath) => shell.openPath(filePath))
  const openExternal = dependencies.openExternal ?? ((url) => shell.openExternal(url))
  const showItemInFolder =
    dependencies.showItemInFolder ?? ((filePath) => shell.showItemInFolder(filePath))

  function requireActiveMediaLibrary(libraryId: number): PlayResult | null {
    const library = readMediaLibrary(libraryId)
    if (!library) return { ok: false, error: '媒体库不存在' }
    if (library.status !== 'active') {
      return { ok: false, error: '已归档媒体库必须恢复后才能播放或定位资源' }
    }
    return null
  }

  async function openResource(resource: VideoResource): Promise<PlayResult> {
    if (resource.kind === 'local') {
      if (!fileExists(resource.locator)) {
        return { ok: false, fileMissing: true, error: '文件不存在' }
      }
      const error = await openPath(resource.locator)
      return error ? { ok: false, error } : { ok: true }
    }
    try {
      await openExternal(resource.locator)
      return { ok: true }
    } catch {
      return { ok: false, error: '系统无法打开该资源' }
    }
  }

  function revealResource(resource: VideoResource | null): PlayResult {
    if (!resource || (resource.kind !== 'local' && !resource.strm_source_path)) {
      return { ok: false, error: '该资源不是本地文件' }
    }
    const sourcePath = resource.kind === 'local' ? resource.locator : resource.strm_source_path
    if (!sourcePath || !fileExists(sourcePath)) {
      return { ok: false, fileMissing: true, error: '文件不存在' }
    }
    showItemInFolder(sourcePath)
    return { ok: true }
  }

  return {
    async playVideo(libraryId, videoId): Promise<PlayResult> {
      const libraryError = requireActiveMediaLibrary(libraryId)
      if (libraryError) return libraryError
      if (!readVideo(videoId)) return { ok: false, error: '视频记录不存在' }
      const resource = readPrimaryResource(libraryId, videoId)
      if (!resource) return { ok: false, error: '影片没有可打开的资源' }
      return openResource(resource)
    },
    async openResource(libraryId, resourceId): Promise<PlayResult> {
      const libraryError = requireActiveMediaLibrary(libraryId)
      if (libraryError) return libraryError
      const resource = readResource(libraryId, resourceId)
      if (!resource) return { ok: false, error: '资源记录不存在' }
      return openResource(resource)
    },
    revealVideo(libraryId, videoId): PlayResult {
      const libraryError = requireActiveMediaLibrary(libraryId)
      if (libraryError) return libraryError
      if (!readVideo(videoId)) return { ok: false, error: '视频记录不存在' }
      return revealResource(readPrimaryResource(libraryId, videoId))
    },
    revealResource(libraryId, resourceId): PlayResult {
      const libraryError = requireActiveMediaLibrary(libraryId)
      if (libraryError) return libraryError
      return revealResource(readResource(libraryId, resourceId))
    }
  }
}

const playerService = createPlayerService()

export const playVideo = playerService.playVideo
export const openVideoResource = playerService.openResource
export const revealVideo = playerService.revealVideo
export const revealVideoResource = playerService.revealResource
