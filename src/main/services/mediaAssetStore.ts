import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import path from 'node:path'
import {
  assetsRoot,
  deleteAssetOrThrow,
  ensureAssetDirs,
  importAvatarDisplayFromBuffer,
  importAvatarSourceFromBuffer,
  importActressGalleryFromFile,
  importClassificationImageFromBuffer,
  importClassificationImageFromFile,
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
  isUsableImageBuffer as isUsableImageBufferImpl,
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
import {
  clearPathAliases as clearPathAliasesImpl,
  decryptStoredAsset as decryptStoredAssetImpl,
  encryptStoredAsset as encryptStoredAssetImpl,
  listStoredImageAssetRels as listStoredImageAssetRelsImpl
} from './mediaAssetStore/cryptoMigration'
import type { AssetFetcher, DownloadedImageAsset, StoredAssetPathRewrite } from './mediaAssetStore/types'
import { mimeFromExt } from './assetCrypto'

export type { StoredAssetPathRewrite }

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

interface CoordinatedChange {
  created: Set<string>
  obsolete: Set<string>
  parent: CoordinatedChange | null
  finished: boolean
}

/**
 * Deep module for media files owned by Javdex.
 *
 * Callers only learn the resource lifecycle and domain imports. Filesystem,
 * inspection, and download/staging live as private internal adapters.
 *
 * Coordinated changes bind one ledger per AsyncLocalStorage context. Nested
 * work enters its own context (with a parent link), so an un-awaited nested
 * async coordinator does not steal registrations from the caller. Successful
 * nested commits promote created and obsolete paths to the parent; obsolete
 * deletes stay deferred until the root commits. Isolated coordinators never
 * nest under a parent (for independently committed DB units). Unrelated work
 * that starts outside the async chain remains an independent root.
 */
export class MediaAssetStore {
  private readonly changeStorage = new AsyncLocalStorage<CoordinatedChange>()

  private activeChange(): CoordinatedChange | null {
    return this.changeStorage.getStore() ?? null
  }

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

  inspectImage(relPath: string | null | undefined) {
    return inspectImageAsset(relPath)
  }

  isUsableImage(relPath: string | null | undefined): boolean {
    return isUsableImageAsset(relPath)
  }

  isUsableImageBuffer(body: Buffer): boolean {
    return isUsableImageBufferImpl(body)
  }

  readBytes(relPath: string): Buffer {
    return readAssetBytes(relPath)
  }

  readForServe(relPath: string): { body: Buffer; mime: string } {
    return readAssetForServe(relPath)
  }

  fingerprint(data: Buffer): string {
    return avatarSourceFingerprint(data)
  }

  detectImageExtension(buf: Buffer): string | null {
    return detectImageExtensionFromBuffer(buf)
  }

  readImageDimensions(data: Buffer) {
    return readImageDimensionsFromBuffer(data)
  }

  readImageDimensionsAtPath(filePath: string) {
    return readImageDimensionsFromPath(filePath)
  }

  readStoredImageDimensions(relPath: string | null | undefined) {
    return readImageDimensionsFromRelPath(relPath)
  }

  mimeFromExtension(ext: string): string {
    return mimeFromExt(ext)
  }

  importAvatarDisplay(name: string, actressId: number, data: Buffer): string {
    return this.registerCreated(importAvatarDisplayFromBuffer(name, actressId, data))
  }

  importAvatarSource(
    name: string,
    actressId: number,
    data: Buffer,
    extension?: string
  ): { relPath: string; fingerprint: string } {
    const result = importAvatarSourceFromBuffer(name, actressId, data, extension)
    this.registerCreated(result.relPath)
    return result
  }

  private registerCreated<T extends string | null>(storedPath: T): T {
    if (storedPath) this.activeChange()?.created.add(storedPath)
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

  importClassificationImage(
    kind: 'organization' | 'director' | 'series',
    id: number,
    name: string,
    sourcePath: string
  ): string {
    return this.registerCreated(importClassificationImageFromFile(kind, id, name, sourcePath))
  }

  storeClassificationImage(
    kind: 'organization' | 'director' | 'series',
    id: number,
    name: string,
    data: Buffer
  ): string {
    return this.registerCreated(importClassificationImageFromBuffer(kind, id, name, data))
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
    const staged = stageActressScrapeImagesImpl(resources)
    for (const item of staged) this.registerCreated(item.stagedPath)
    return staged
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

  /** List posix relative paths under the stable image subdirectories (excludes staging). */
  listStoredImageAssetRels(): string[] {
    return listStoredImageAssetRelsImpl()
  }

  /**
   * Encrypt one stored plain asset in place. Returns a path rewrite when callers
   * must remap DB references; null when no remap is needed.
   */
  encryptStoredAsset(rel: string): StoredAssetPathRewrite | null {
    return encryptStoredAssetImpl(rel)
  }

  /**
   * Decrypt one stored encrypted asset in place. Returns a path rewrite when
   * callers must remap DB references; null when skipped or unchanged.
   */
  decryptStoredAsset(rel: string): StoredAssetPathRewrite | null {
    return decryptStoredAssetImpl(rel)
  }

  clearPathAliases(): void {
    clearPathAliasesImpl()
  }

  delete(storedPath: string | null | undefined): void {
    deleteAssetOrThrow(storedPath)
  }

  deleteBestEffort(storedPath: string | null | undefined): void {
    if (!storedPath) return
    const active = this.activeChange()
    if (active) {
      active.obsolete.add(storedPath)
      return
    }
    this.deleteImmediateBestEffort(storedPath)
  }

  private deleteImmediateBestEffort(storedPath: string | null | undefined): void {
    if (!storedPath) return
    try {
      this.delete(storedPath)
    } catch (error) {
      console.error('Failed to delete media asset:', storedPath, error)
    }
  }

  /**
   * Coordinate resource changes around one database use case.
   * Accepts sync or async operations. New files are compensated when the
   * operation fails; obsolete files are removed only after it succeeds.
   * Nested coordinated changes use an independent ledger; on success their
   * created and obsolete paths are promoted to the parent change.
   */
  coordinateDatabaseChange<T>(operation: () => T): T
  coordinateDatabaseChange<T>(operation: () => Promise<T>): Promise<T>
  coordinateDatabaseChange<T>(operation: () => T | Promise<T>): T | Promise<T> {
    return this.runCoordinatedChange(operation)
  }

  /**
   * Join the active coordinated change when one exists; otherwise start a root
   * change. Use for helpers that may run alone or inside a larger shared use
   * case (for example setActressAvatarBundle inside editActress).
   */
  runInCoordinatedChange<T>(operation: () => T): T {
    if (this.activeChange()) return operation()
    return this.coordinateDatabaseChange(operation)
  }

  /**
   * Start a root coordinated change that never nests under an active parent.
   * Use when this unit commits its own database changes independently of the
   * caller's media ledger (for example cast-avatar adopt during video scrape).
   */
  coordinateDatabaseChangeIsolated<T>(operation: () => T): T {
    return this.runCoordinatedChange(operation, null) as T
  }

  private runCoordinatedChange<T>(operation: () => T): T
  private runCoordinatedChange<T>(operation: () => Promise<T>): Promise<T>
  private runCoordinatedChange<T>(
    operation: () => T | Promise<T>,
    parentOverride?: CoordinatedChange | null
  ): T | Promise<T>
  private runCoordinatedChange<T>(
    operation: () => T | Promise<T>,
    parentOverride?: CoordinatedChange | null
  ): T | Promise<T> {
    const change: CoordinatedChange = {
      created: new Set(),
      obsolete: new Set(),
      parent: parentOverride === undefined ? this.activeChange() : parentOverride,
      finished: false
    }
    return this.changeStorage.run(change, () => {
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
    })
  }

  private finishCoordinatedChange(
    change: CoordinatedChange,
    outcome: 'commit' | 'rollback'
  ): void {
    if (change.finished) {
      throw new Error('MediaAssetStore coordinated change finished more than once')
    }
    change.finished = true

    if (outcome === 'rollback') {
      for (const storedPath of change.created) this.deleteImmediateBestEffort(storedPath)
      return
    }

    const parent = change.parent
    if (parent) {
      // Promote both sets so parent rollback can still compensate nested creates,
      // while obsolete deletes of pre-existing files stay deferred until root commit.
      for (const storedPath of change.created) parent.created.add(storedPath)
      for (const storedPath of change.obsolete) parent.obsolete.add(storedPath)
      return
    }

    for (const storedPath of change.obsolete) this.deleteImmediateBestEffort(storedPath)
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
