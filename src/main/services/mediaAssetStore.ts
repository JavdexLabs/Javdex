import fs from 'node:fs'
import path from 'node:path'
import {
  assetsRoot,
  deleteAssetOrThrow,
  ensureAssetDirs,
  importAvatarDisplayFromBuffer,
  importAvatarFromFile,
  importAvatarSourceFromBuffer,
  importActressGalleryFromFile,
  importCoverFromFile,
  importPlaylistCoverFromFile,
  importSampleFromFile,
  readAssetBytes,
  readAssetForServe,
  resolveAssetPath
} from './mediaAssetStore/filesystem'
import {
  avatarSourceFingerprint,
  detectImageExtensionFromBuffer,
  inspectImageAsset,
  isUsableImageAsset,
  isUsableImageBuffer,
  readImageDimensionsFromBuffer,
  readImageDimensionsFromPath,
  readImageDimensionsFromRelPath
} from './mediaAssetStore/inspection'
import {
  cleanupActressScrapeStagingPaths as cleanupActressScrapeStagingPathsImpl,
  cleanupOrphanedActressScrapeStaging as cleanupOrphanedActressScrapeStagingImpl,
  downloadActressGalleryImage as downloadActressGalleryImageImpl,
  downloadAvatar as downloadAvatarImpl,
  downloadCover as downloadCoverImpl,
  downloadSamples as downloadSamplesImpl,
  readActressScrapeStagedImage as readActressScrapeStagedImageImpl,
  stageActressScrapeImages as stageActressScrapeImagesImpl,
  storeScrapedActressAvatar as storeScrapedActressAvatarImpl,
  storeScrapedActressGalleryImage as storeScrapedActressGalleryImageImpl,
  type ActressScrapeStagingInput,
  type StagedActressScrapeImage
} from './mediaAssetStore/download'
import type { AssetFetcher, DownloadedImageAsset } from './mediaAssetStore/types'
import { mimeFromExt } from './assetCrypto'

export type { AssetFetcher, DownloadedImageAsset }
export type { ActressScrapeStagingInput, StagedActressScrapeImage }

/** Stable media-asset layout directories under the media root. */
export type MediaAssetSubdir =
  | 'covers'
  | 'avatars'
  | 'actress_gallery'
  | 'samples'
  | 'playlist_covers'

const MEDIA_ASSET_SUBDIRS = new Set<MediaAssetSubdir>([
  'covers',
  'avatars',
  'actress_gallery',
  'samples',
  'playlist_covers'
])

/**
 * Deep module for media files owned by Javdex.
 *
 * Callers only learn the resource lifecycle and domain imports. Filesystem,
 * inspection, and download/staging live as private internal adapters.
 */
export class MediaAssetStore {
  private activeChange: { created: Set<string>; obsolete: Set<string> } | null = null

  ensureReady(): void {
    ensureAssetDirs()
  }

  rootPath(): string {
    return assetsRoot()
  }

  subdirPath(kind: MediaAssetSubdir): string {
    if (!MEDIA_ASSET_SUBDIRS.has(kind)) {
      throw new Error(`Unknown media asset subdirectory: ${kind}`)
    }
    return path.join(this.rootPath(), kind)
  }

  resolve(storedPath: string): string {
    return resolveAssetPath(storedPath)
  }

  inspectImage = inspectImageAsset
  isUsableImage = isUsableImageAsset
  isUsableImageBuffer = isUsableImageBuffer
  readBytes = readAssetBytes
  readForServe = readAssetForServe
  fingerprint = avatarSourceFingerprint
  detectImageExtension = detectImageExtensionFromBuffer
  readImageDimensions = readImageDimensionsFromBuffer
  readImageDimensionsAtPath = readImageDimensionsFromPath
  readStoredImageDimensions = readImageDimensionsFromRelPath
  mimeFromExtension = mimeFromExt

  importAvatarDisplay(name: string, actressId: number, data: Buffer): string {
    const storedPath = importAvatarDisplayFromBuffer(name, actressId, data)
    this.activeChange?.created.add(storedPath)
    return storedPath
  }

  importAvatarSource(
    name: string,
    actressId: number,
    data: Buffer,
    extension?: string
  ): { relPath: string; fingerprint: string } {
    const result = importAvatarSourceFromBuffer(name, actressId, data, extension)
    this.activeChange?.created.add(result.relPath)
    return result
  }

  importAvatarFile(name: string, sourcePath: string, actressId?: number | null): string {
    const storedPath = importAvatarFromFile(name, sourcePath, actressId)
    this.activeChange?.created.add(storedPath)
    return storedPath
  }

  private registerCreated<T extends string | null>(storedPath: T): T {
    if (storedPath) this.activeChange?.created.add(storedPath)
    return storedPath
  }

  importCover(code: string, sourcePath: string): string {
    return this.registerCreated(importCoverFromFile(code, sourcePath))
  }

  importPlaylistCover(name: string, sourcePath: string): string {
    return this.registerCreated(importPlaylistCoverFromFile(name, sourcePath))
  }

  importSample(code: string, sourcePath: string): string {
    return this.registerCreated(importSampleFromFile(code, sourcePath))
  }

  importActressGallery(name: string, sourcePath: string, actressId?: number | null): string {
    return this.registerCreated(importActressGalleryFromFile(name, sourcePath, actressId))
  }

  async downloadCover(code: string, url: string, fetcher: AssetFetcher): Promise<string | null> {
    return this.registerCreated(await downloadCoverImpl(code, url, fetcher))
  }

  async downloadAvatar(name: string, url: string, fetcher: AssetFetcher): Promise<string | null> {
    return this.registerCreated(await downloadAvatarImpl(name, url, fetcher))
  }

  async downloadSamples(
    code: string,
    urls: string[],
    fetcher: AssetFetcher
  ): Promise<Array<string | null>> {
    const paths = await downloadSamplesImpl(code, urls, fetcher)
    for (const storedPath of paths) this.registerCreated(storedPath)
    return paths
  }

  storeScrapedActressAvatar(name: string, url: string, data: Buffer): string {
    return this.registerCreated(storeScrapedActressAvatarImpl(name, url, data))
  }

  storeScrapedActressGalleryImage(
    name: string,
    actressId: number,
    url: string,
    data: Buffer
  ): DownloadedImageAsset {
    const result = storeScrapedActressGalleryImageImpl(name, actressId, url, data)
    this.registerCreated(result.localPath)
    return result
  }

  async downloadActressGalleryImage(
    name: string,
    url: string,
    fetcher: AssetFetcher,
    actressId?: number | null
  ): Promise<DownloadedImageAsset | null> {
    const result = await downloadActressGalleryImageImpl(name, url, fetcher, actressId)
    if (result) this.registerCreated(result.localPath)
    return result
  }

  stageActressScrapeImages(resources: ActressScrapeStagingInput[]): StagedActressScrapeImage[] {
    return stageActressScrapeImagesImpl(resources)
  }

  readActressScrapeStagedImage(stagedPath: string): Buffer {
    return readActressScrapeStagedImageImpl(stagedPath)
  }

  cleanupActressScrapeStagingPaths(stagedPaths: string[]): void {
    cleanupActressScrapeStagingPathsImpl(stagedPaths)
  }

  cleanupOrphanedActressScrapeStaging(
    referencedPaths: string[],
    options?: { now?: number; olderThanMs?: number }
  ): number {
    return cleanupOrphanedActressScrapeStagingImpl(referencedPaths, options)
  }

  delete(storedPath: string | null | undefined): void {
    deleteAssetOrThrow(storedPath)
  }

  deleteBestEffort(storedPath: string | null | undefined): void {
    if (!storedPath) return
    if (this.activeChange) {
      this.activeChange.obsolete.add(storedPath)
      return
    }
    try {
      this.delete(storedPath)
    } catch (error) {
      console.error('Failed to delete media asset:', storedPath, error)
    }
  }

  /**
   * Coordinate resource changes around one database use case.
   * New files are compensated when the database operation fails; obsolete
   * files are removed only after the operation commits successfully.
   */
  coordinateDatabaseChange<T>(operation: () => T): T {
    return this.runCoordinatedChange(operation)
  }

  async coordinateDatabaseChangeAsync<T>(operation: () => Promise<T>): Promise<T> {
    return this.runCoordinatedChange(operation)
  }

  private runCoordinatedChange<T>(operation: () => T): T
  private runCoordinatedChange<T>(operation: () => Promise<T>): Promise<T>
  private runCoordinatedChange<T>(operation: () => T | Promise<T>): T | Promise<T> {
    if (this.activeChange) return operation()
    const change = { created: new Set<string>(), obsolete: new Set<string>() }
    this.activeChange = change
    try {
      const result = operation()
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            this.finishCoordinatedChange(change, 'commit')
            return value
          },
          (error) => {
            this.finishCoordinatedChange(change, 'rollback')
            throw error
          }
        )
      }
      this.finishCoordinatedChange(change, 'commit')
      return result
    } catch (error) {
      this.finishCoordinatedChange(change, 'rollback')
      throw error
    }
  }

  private finishCoordinatedChange(
    change: { created: Set<string>; obsolete: Set<string> },
    outcome: 'commit' | 'rollback'
  ): void {
    if (this.activeChange === change) this.activeChange = null
    if (outcome === 'commit') {
      for (const storedPath of change.obsolete) {
        if (!change.created.has(storedPath)) this.deleteBestEffort(storedPath)
      }
      return
    }
    for (const storedPath of change.created) this.deleteBestEffort(storedPath)
  }

  readExternalFile(filePath: string): Buffer {
    if (!fs.existsSync(filePath)) throw new Error('头像原图文件不存在')
    return fs.readFileSync(filePath)
  }

  extensionOf(filePath: string, fallback = '.jpg'): string {
    return path.extname(filePath).toLowerCase() || fallback
  }
}

export const mediaAssetStore = new MediaAssetStore()
