import { shell } from 'electron'
import fs from 'node:fs'
import {
  getPrimaryVideoResource,
  getVideoById,
  getVideoResourceById
} from '../db/videoRepo'
import type { PlayResult } from '@shared/libraryTypes'
import type { VideoResource } from '@shared/videoTypes'

interface PlayerServiceDependencies {
  getVideoById: typeof getVideoById
  getPrimaryVideoResource: typeof getPrimaryVideoResource
  getVideoResourceById: typeof getVideoResourceById
  fileExists: (filePath: string) => boolean
  openPath: (filePath: string) => Promise<string>
  openExternal: (url: string) => Promise<void>
  showItemInFolder: (filePath: string) => void
}

export interface PlayerService {
  playVideo(videoId: number): Promise<PlayResult>
  openResource(resourceId: number): Promise<PlayResult>
  revealVideo(videoId: number): PlayResult
  revealResource(resourceId: number): PlayResult
}

export function createPlayerService(
  dependencies: Partial<PlayerServiceDependencies> = {}
): PlayerService {
  const readVideo = dependencies.getVideoById ?? getVideoById
  const readPrimaryResource = dependencies.getPrimaryVideoResource ?? getPrimaryVideoResource
  const readResource = dependencies.getVideoResourceById ?? getVideoResourceById
  const fileExists = dependencies.fileExists ?? fs.existsSync
  const openPath = dependencies.openPath ?? ((filePath) => shell.openPath(filePath))
  const openExternal = dependencies.openExternal ?? ((url) => shell.openExternal(url))
  const showItemInFolder =
    dependencies.showItemInFolder ?? ((filePath) => shell.showItemInFolder(filePath))

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
    } catch (error) {
      return { ok: false, error: (error as Error).message || '系统无法打开该资源' }
    }
  }

  function revealResource(resource: VideoResource | null): PlayResult {
    if (!resource || resource.kind !== 'local') {
      return { ok: false, error: '该资源不是本地文件' }
    }
    if (!fileExists(resource.locator)) {
      return { ok: false, fileMissing: true, error: '文件不存在' }
    }
    showItemInFolder(resource.locator)
    return { ok: true }
  }

  return {
    async playVideo(videoId): Promise<PlayResult> {
      if (!readVideo(videoId)) return { ok: false, error: '视频记录不存在' }
      const resource = readPrimaryResource(videoId)
      if (!resource) return { ok: false, error: '影片没有可打开的资源' }
      return openResource(resource)
    },
    async openResource(resourceId): Promise<PlayResult> {
      const resource = readResource(resourceId)
      if (!resource) return { ok: false, error: '资源记录不存在' }
      return openResource(resource)
    },
    revealVideo(videoId): PlayResult {
      if (!readVideo(videoId)) return { ok: false, error: '视频记录不存在' }
      return revealResource(readPrimaryResource(videoId))
    },
    revealResource(resourceId): PlayResult {
      return revealResource(readResource(resourceId))
    }
  }
}

const playerService = createPlayerService()

export const playVideo = playerService.playVideo
export const openVideoResource = playerService.openResource
export const revealVideo = playerService.revealVideo
export const revealVideoResource = playerService.revealResource
