import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  assetsRoot,
  avatarSourceFingerprint,
  downloadActressGalleryImage,
  downloadAvatar,
  downloadCover,
  downloadSamples,
  deleteAssetOrThrow,
  detectImageExtensionFromBuffer,
  importAvatarDisplayFromBuffer,
  importAvatarFromFile,
  importAvatarSourceFromBuffer,
  importActressGalleryFromFile,
  importCoverFromFile,
  importSampleFromFile,
  inspectImageAsset,
  isUsableImageBuffer,
  isUsableImageAsset,
  readAssetBytes,
  readAssetForServe,
  readImageDimensionsFromBuffer,
  readImageDimensionsFromPath,
  readImageDimensionsFromRelPath,
  resolveAssetPath,
  storeScrapedActressAvatar,
  storeScrapedActressGalleryImage,
  type AssetFetcher,
  type DownloadedImageAsset
} from './assetService'
import { mimeFromExt } from './assetCrypto'

const ACTRESS_SCRAPE_STAGING_DIRNAME = '.actress_scrape_staging'
const DEFAULT_STAGING_ORPHAN_SAFETY_AGE_MS = 24 * 60 * 60 * 1000

export interface ActressScrapeStagingInput {
  field: 'avatar' | 'gallery'
  position: number
  remoteUrl?: string
  data: Buffer
  width?: number | null
  height?: number | null
}

export interface StagedActressScrapeImage {
  field: 'avatar' | 'gallery'
  position: number
  remoteUrl?: string
  stagedPath: string
  width: number | null
  height: number | null
}

/**
 * Concrete boundary for media files owned by Javdex.
 *
 * Database repositories receive this capability through a port and therefore
 * never resolve paths or touch the file system directly. Application services
 * remain responsible for deciding when resource work happens relative to a
 * database transaction.
 */
export class MediaAssetStore {
  private activeChange: { created: Set<string>; obsolete: Set<string> } | null = null

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

  importSample(code: string, sourcePath: string): string {
    return this.registerCreated(importSampleFromFile(code, sourcePath))
  }

  importActressGallery(name: string, sourcePath: string, actressId?: number | null): string {
    return this.registerCreated(importActressGalleryFromFile(name, sourcePath, actressId))
  }

  async downloadCover(code: string, url: string, fetcher: AssetFetcher): Promise<string | null> {
    return this.registerCreated(await downloadCover(code, url, fetcher))
  }

  async downloadAvatar(name: string, url: string, fetcher: AssetFetcher): Promise<string | null> {
    return this.registerCreated(await downloadAvatar(name, url, fetcher))
  }

  async downloadSamples(
    code: string,
    urls: string[],
    fetcher: AssetFetcher
  ): Promise<Array<string | null>> {
    const paths = await downloadSamples(code, urls, fetcher)
    for (const storedPath of paths) this.registerCreated(storedPath)
    return paths
  }

  storeScrapedActressAvatar(name: string, url: string, data: Buffer): string {
    return this.registerCreated(storeScrapedActressAvatar(name, url, data))
  }

  storeScrapedActressGalleryImage(
    name: string,
    actressId: number,
    url: string,
    data: Buffer
  ): DownloadedImageAsset {
    const result = storeScrapedActressGalleryImage(name, actressId, url, data)
    this.registerCreated(result.localPath)
    return result
  }

  async downloadActressGalleryImage(
    name: string,
    url: string,
    fetcher: AssetFetcher,
    actressId?: number | null
  ): Promise<DownloadedImageAsset | null> {
    const result = await downloadActressGalleryImage(name, url, fetcher, actressId)
    if (result) this.registerCreated(result.localPath)
    return result
  }

  private actressScrapeStagingRoot(): string {
    return path.resolve(assetsRoot(), ACTRESS_SCRAPE_STAGING_DIRNAME)
  }

  private resolveActressScrapeStagedPath(stagedPath: string): string {
    const stagingRoot = this.actressScrapeStagingRoot()
    const absolutePath = path.resolve(assetsRoot(), stagedPath)
    const relative = path.relative(stagingRoot, absolutePath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('待确认暂存资源路径无效')
    }
    return absolutePath
  }

  stageActressScrapeImages(resources: ActressScrapeStagingInput[]): StagedActressScrapeImage[] {
    if (resources.length === 0) return []
    const token = crypto.randomUUID()
    const relativeDir = path.posix.join(ACTRESS_SCRAPE_STAGING_DIRNAME, token)
    const absoluteDir = path.join(this.actressScrapeStagingRoot(), token)
    fs.mkdirSync(absoluteDir, { recursive: true })
    const staged: StagedActressScrapeImage[] = []
    try {
      for (const resource of resources) {
        if (!this.isUsableImageBuffer(resource.data)) throw new Error('暂存资源不是可用图片')
        const extension = this.detectImageExtension(resource.data) ?? '.jpg'
        const filename = `${resource.field}-${resource.position}${extension}`
        fs.writeFileSync(path.join(absoluteDir, filename), resource.data)
        staged.push({
          field: resource.field,
          position: resource.position,
          ...(resource.remoteUrl?.trim() ? { remoteUrl: resource.remoteUrl.trim() } : {}),
          stagedPath: path.posix.join(relativeDir, filename),
          width: resource.width ?? null,
          height: resource.height ?? null
        })
      }
      return staged
    } catch (error) {
      fs.rmSync(absoluteDir, { recursive: true, force: true })
      throw error
    }
  }

  readActressScrapeStagedImage(stagedPath: string): Buffer {
    const data = fs.readFileSync(this.resolveActressScrapeStagedPath(stagedPath))
    if (!this.isUsableImageBuffer(data)) throw new Error('待确认暂存资源不可用')
    return data
  }

  cleanupActressScrapeStagingPaths(stagedPaths: string[]): void {
    const directories = new Set<string>()
    for (const stagedPath of stagedPaths) {
      try {
        directories.add(path.dirname(this.resolveActressScrapeStagedPath(stagedPath)))
      } catch {
        continue
      }
    }
    for (const directory of directories) {
      try {
        fs.rmSync(directory, { recursive: true, force: true })
      } catch (error) {
        console.error('cleanup staged actress scrape resources failed:', (error as Error).message)
      }
    }
  }

  cleanupOrphanedActressScrapeStaging(
    referencedPaths: string[],
    options?: { now?: number; olderThanMs?: number }
  ): number {
    const stagingRoot = this.actressScrapeStagingRoot()
    if (!fs.existsSync(stagingRoot)) return 0
    const referencedDirectories = new Set<string>()
    for (const stagedPath of referencedPaths) {
      try {
        referencedDirectories.add(path.dirname(this.resolveActressScrapeStagedPath(stagedPath)))
      } catch {
        continue
      }
    }
    const now = options?.now ?? Date.now()
    const olderThanMs = options?.olderThanMs ?? DEFAULT_STAGING_ORPHAN_SAFETY_AGE_MS
    let removed = 0
    for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = path.resolve(stagingRoot, entry.name)
      const relative = path.relative(stagingRoot, directory)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
      if (referencedDirectories.has(directory)) continue
      if (now - fs.statSync(directory).mtimeMs < olderThanMs) continue
      fs.rmSync(directory, { recursive: true, force: true })
      removed += 1
    }
    return removed
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
   * Coordinate resource changes around one synchronous database use case.
   * New files are compensated when the database operation fails; obsolete
   * files are removed only after the operation commits successfully.
   */
  coordinateDatabaseChange<T>(operation: () => T): T {
    if (this.activeChange) return operation()
    const change = { created: new Set<string>(), obsolete: new Set<string>() }
    this.activeChange = change
    try {
      const result = operation()
      this.activeChange = null
      for (const storedPath of change.obsolete) {
        if (!change.created.has(storedPath)) this.deleteBestEffort(storedPath)
      }
      return result
    } catch (error) {
      this.activeChange = null
      for (const storedPath of change.created) this.deleteBestEffort(storedPath)
      throw error
    }
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
