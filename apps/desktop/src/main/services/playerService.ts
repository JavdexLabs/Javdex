import { shell } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  getPrimaryVideoResource,
  getVideoById,
  getVideoResourceInLibrary
} from '@library/db/videoRepo'
import { getMediaLibrary } from '@library/db/mediaLibraryRepo'
import { resourceLocatorRevision } from '@library/catalog/catalogPlay'
import type { PlayResult } from '@shared/libraryTypes'
import type { VideoResource } from '@shared/videoTypes'
import type { PlayGrant } from '@shared/protocol/play'
import { isStructuredError } from '@shared/protocol/errors'
import type { CatalogBackend } from '../application/catalogBackend'

interface PlayerServiceDependencies {
  getMediaLibrary: typeof getMediaLibrary
  getVideoById: typeof getVideoById
  getPrimaryVideoResource: typeof getPrimaryVideoResource
  getVideoResourceInLibrary: typeof getVideoResourceInLibrary
  fileExists: (filePath: string) => boolean
  openPath: (filePath: string) => Promise<string>
  openExternal: (url: string) => Promise<void>
  showItemInFolder: (filePath: string) => void
  catalog?: CatalogBackend
  readPlayerPath?: () => Promise<string | null>
  spawnPlayer?: (program: string, args: string[]) => Promise<PlayResult>
}

export interface PlayerService {
  playVideo(libraryId: number, videoId: number): Promise<PlayResult>
  openResource(libraryId: number, resourceId: number, videoId?: number): Promise<PlayResult>
  revealVideo(libraryId: number, videoId: number): PlayResult | Promise<PlayResult>
  revealResource(libraryId: number, resourceId: number): PlayResult | Promise<PlayResult>
}

function spawnPlayerProgram(program: string, args: string[]): Promise<PlayResult> {
  if (!path.isAbsolute(program)) {
    return Promise.resolve({ ok: false, error: '播放器路径必须是绝对路径' })
  }
  if (!fs.existsSync(program)) {
    return Promise.resolve({ ok: false, error: '找不到播放器程序' })
  }
  const isMacApp = process.platform === 'darwin' && program.toLowerCase().endsWith('.app')
  if (isMacApp && !fs.statSync(program).isDirectory()) {
    return Promise.resolve({ ok: false, error: '所选路径不是应用程序' })
  }
  return new Promise((resolve) => {
    const child = spawn(isMacApp ? '/usr/bin/open' : program, isMacApp ? ['-a', program, ...args] : args, {
      shell: false,
      stdio: 'ignore',
      detached: true
    })
    child.once('error', (error) => resolve({ ok: false, error: error.message }))
    child.once('spawn', () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}

function playError(error: unknown, fallback: string): PlayResult {
  if (isStructuredError(error)) return { ok: false, error: error.message }
  return { ok: false, error: error instanceof Error ? error.message : fallback }
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
  const spawnPlayer = dependencies.spawnPlayer ?? spawnPlayerProgram
  const catalog = dependencies.catalog

  function requireActiveMediaLibrary(libraryId: number): PlayResult | null {
    const library = readMediaLibrary(libraryId)
    if (!library) return { ok: false, error: '媒体库不存在' }
    if (library.status !== 'active') {
      return { ok: false, error: '已归档媒体库必须恢复后才能播放或定位资源' }
    }
    return null
  }

  async function openLocalOrExternal(resource: VideoResource): Promise<PlayResult> {
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

  async function openRemoteResource(
    libraryId: number,
    videoId: number,
    resource: VideoResource & { locatorRevision?: string }
  ): Promise<PlayResult> {
    if (resource.kind === 'web' || resource.kind === 'magnet' || resource.kind === 'ed2k') {
      try {
        await openExternal(resource.locator)
        return { ok: true }
      } catch {
        return { ok: false, error: '系统无法打开该资源' }
      }
    }
    if (resource.kind === 'direct') {
      const playerPath = (await dependencies.readPlayerPath?.()) ?? null
      if (playerPath) return spawnPlayer(playerPath, [resource.locator])
      try {
        await openExternal(resource.locator)
        return { ok: true }
      } catch {
        return { ok: false, error: '系统无法打开该资源' }
      }
    }
    const playerPath = (await dependencies.readPlayerPath?.()) ?? null
    if (!playerPath) {
      return { ok: false, error: '请在此电脑设置中指定播放器程序（例如 mpv）' }
    }
    if (!catalog) return { ok: false, error: '远程播放未装配资料库后端' }
    try {
      const grant = (await catalog.assets.grantPlayback({
        libraryId,
        videoId,
        resourceId: resource.id,
        locatorRevision: resource.locatorRevision ?? resourceLocatorRevision(resource)
      })) as PlayGrant
      return spawnPlayer(playerPath, [grant.playbackHandle])
    } catch (error) {
      return playError(error, '无法签发播放凭据')
    }
  }

  function revealResource(resource: VideoResource | null): PlayResult {
    if (catalog?.mode === 'remote') {
      return { ok: false, error: '远程模式不能在本机显示文件位置' }
    }
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
      if (catalog?.mode === 'remote') {
        try {
          const detail = (await catalog.queries.getVideo({
            scope: { kind: 'library', libraryId },
            videoId
          })) as { resources?: Array<VideoResource & { locatorRevision?: string }> } | null
          const primary =
            detail?.resources?.find((resource) => resource.is_primary === 1) ?? detail?.resources?.[0]
          if (!primary) return { ok: false, error: '影片没有可打开的资源' }
          const resource = ((await catalog.queries.getResource({
            libraryId,
            videoId,
            resourceId: primary.id
          })) ?? primary) as VideoResource & { locatorRevision?: string }
          return openRemoteResource(libraryId, videoId, resource)
        } catch (error) {
          return playError(error, '无法读取远程影片资源')
        }
      }
      const libraryError = requireActiveMediaLibrary(libraryId)
      if (libraryError) return libraryError
      if (!readVideo(videoId)) return { ok: false, error: '视频记录不存在' }
      const resource = readPrimaryResource(libraryId, videoId)
      if (!resource) return { ok: false, error: '影片没有可打开的资源' }
      return openLocalOrExternal(resource)
    },
    async openResource(libraryId, resourceId, videoId): Promise<PlayResult> {
      if (catalog?.mode === 'remote') {
        if (videoId == null) return { ok: false, error: '缺少影片编号' }
        try {
          const resource = (await catalog.queries.getResource({
            libraryId,
            videoId,
            resourceId
          })) as (VideoResource & { locatorRevision?: string }) | null
          if (!resource) return { ok: false, error: '资源记录不存在' }
          return openRemoteResource(libraryId, videoId, resource)
        } catch (error) {
          return playError(error, '无法读取远程影片资源')
        }
      }
      const libraryError = requireActiveMediaLibrary(libraryId)
      if (libraryError) return libraryError
      const resource = readResource(libraryId, resourceId)
      if (!resource) return { ok: false, error: '资源记录不存在' }
      return openLocalOrExternal(resource)
    },
    revealVideo(libraryId, videoId): PlayResult {
      if (catalog?.mode === 'remote') {
        return { ok: false, error: '远程模式不能在本机显示文件位置' }
      }
      const libraryError = requireActiveMediaLibrary(libraryId)
      if (libraryError) return libraryError
      if (!readVideo(videoId)) return { ok: false, error: '视频记录不存在' }
      return revealResource(readPrimaryResource(libraryId, videoId))
    },
    revealResource(libraryId, resourceId): PlayResult {
      if (catalog?.mode === 'remote') {
        return { ok: false, error: '远程模式不能在本机显示文件位置' }
      }
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
