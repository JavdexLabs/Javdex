import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { getSettings } from '../../settings/settingsStore'
import { encryptPlain, decryptBlob, decryptBlobAsync, isEncryptedBlob, mimeFromExt } from '../assetCrypto'
import {
  getAssetCacheRevision, getCachedAsset, setCachedAsset, sameAssetByteSignature,
  invalidateAssetCache, type AssetByteSignature
} from '../assetCache'
import { ensureMediaAssetDirsAt, resolveMediaAssetsRoot } from '../assetStoragePaths'
import {
  buildActressAssetSeed,
  buildOpaqueAssetBase,
  buildReadableAssetBase
} from '../assetPathNaming'
import { setPathAlias } from '../assetPathAliases'
import {
  avatarSourceFingerprint,
  detectImageExtensionFromBuffer,
  isUsableImageBuffer
} from './imageBytes'
import type { ImageAssetSubdir } from './types'
import { AssetReadQueue } from './readQueue'
import { AssetReadFlights } from './readFlights'
import { AssetReadTooLargeError, MAX_ASSET_READ_BYTES, readBoundedAssetFile } from './boundedRead'
import { inspectServedImage } from './pixelBudget'
import { createAssetThumbnail } from './thumbnail'
import { parseImageThumbnailSize, type ImageThumbnailSize } from '@shared/imageVariants'

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']
const serveReads = new AssetReadQueue()
const serveFlights = new AssetReadFlights()

/** Root directory for downloaded media assets. */
export function assetsRoot(): string {
  return resolveMediaAssetsRoot()
}

export function coversDir(): string {
  return path.join(assetsRoot(), 'covers')
}

export function avatarsDir(): string {
  return path.join(assetsRoot(), 'avatars')
}

export function actressGalleryDir(): string {
  return path.join(assetsRoot(), 'actress_gallery')
}

export function samplesDir(): string {
  return path.join(assetsRoot(), 'samples')
}

export function playlistCoversDir(): string {
  return path.join(assetsRoot(), 'playlist_covers')
}

export function ensureAssetDirs(): void {
  ensureMediaAssetDirsAt(assetsRoot())
}

/** Resolve a stored relative asset path to an absolute path. */
export function resolveAssetPath(relPath: string): string {
  const root = path.resolve(assetsRoot())
  const resolved = path.resolve(root, relPath)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Asset path escapes media root: ${relPath}`)
  }
  return resolved
}

export function writeAtomic(abs: string, data: Buffer): void {
  const tmp = `${abs}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, abs)
}

async function readAssetSignature(filePath: string): Promise<AssetByteSignature> {
  const stat = await fs.promises.stat(filePath)
  return { resolvedPath: filePath, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    size: stat.size, device: stat.dev, inode: stat.ino }
}

/** Read an asset for media:// serving; decrypts .enc blobs when needed. */
export function readAssetForServe(relPath: string): { body: Buffer; mime: string } {
  const abs = resolveAssetPath(relPath)
  if (!fs.existsSync(abs)) throw new Error('Asset not found')
  const raw = fs.readFileSync(abs)
  return decodeAssetForServe(relPath, raw)
}

/** Asynchronous disk read for request handlers; synchronous business readers remain explicit. */
export async function readAssetForServeAsync(
  relPath: string,
  signal?: AbortSignal,
  size?: ImageThumbnailSize
): Promise<{ body: Buffer; mime: string }> {
  signal?.throwIfAborted()
  parseImageThumbnailSize(size === undefined ? null : String(size))
  const variant = size === undefined ? 'original' : `thumbnail-v1-${size}`
  const abs = resolveAssetPath(relPath)
  return serveReads.run(() => serveFlights.run(JSON.stringify([abs, variant, getAssetCacheRevision()]), async (signal) => {
    const revision = getAssetCacheRevision()
    let before: AssetByteSignature
    try { before = await readAssetSignature(abs) } catch (error) {
      invalidateAssetCache(relPath)
      throw error
    }
    signal?.throwIfAborted()
    if (before.size > MAX_ASSET_READ_BYTES) throw new AssetReadTooLargeError()
    const cached = getCachedAsset(relPath, before, variant)
    if (cached) return cached
    const raw = await readBoundedAssetFile(abs, signal)
    signal?.throwIfAborted()
    let image: { body: Buffer; mime: string }
    if (relPath.endsWith('.enc') || isEncryptedBlob(raw)) {
      const { data, ext } = await decryptBlobAsync(raw, signal)
      image = { body: data, mime: mimeFromExt(ext) }
    } else image = decodeAssetForServe(relPath, raw)
    image.mime = await inspectServedImage(image.body, signal)
    if (size !== undefined) image = { body: await createAssetThumbnail(image.body, size, signal), mime: 'image/webp' }
    const after = await readAssetSignature(abs)
    signal?.throwIfAborted()
    if (!sameAssetByteSignature(before, after)) throw new Error('Asset changed while reading')
    if (getAssetCacheRevision() === revision) setCachedAsset(relPath, after, image.body, image.mime, variant)
    return image
  }, signal), signal)
}

function decodeAssetForServe(relPath: string, raw: Buffer): { body: Buffer; mime: string } {
  if (relPath.endsWith('.enc') || isEncryptedBlob(raw)) {
    const { data, ext } = decryptBlob(raw)
    return { body: data, mime: mimeFromExt(ext) }
  }
  return { body: raw, mime: mimeFromExt(path.extname(relPath)) }
}

/** Read plaintext bytes for a stored relative asset path. */
export function readAssetBytes(relPath: string): Buffer {
  return readAssetForServe(relPath).body
}

/** Delete a stored asset by its relative path and surface file-system errors to the caller. */
export function deleteAssetOrThrow(relPath: string | null | undefined): void {
  if (!relPath) return
  const abs = resolveAssetPath(relPath)
  const root = assetsRoot()
  if (abs.startsWith(root) && fs.existsSync(abs)) {
    fs.unlinkSync(abs)
    invalidateAssetCache(relPath)
  }
}

function imageAssetDir(subdir: ImageAssetSubdir): string {
  if (subdir === 'covers') return coversDir()
  if (subdir === 'avatars') return avatarsDir()
  if (subdir === 'actress_gallery') return actressGalleryDir()
  if (subdir === 'samples') return samplesDir()
  return playlistCoversDir()
}

export function writeImageAsset(
  subdir: ImageAssetSubdir,
  seed: string,
  urlKey: string,
  ext: string,
  buf: Buffer
): string {
  ensureAssetDirs()
  const dir = imageAssetDir(subdir)
  const readableBase = buildReadableAssetBase(seed, urlKey)
  if (getSettings().assetEncryption) {
    const plainRel = path.posix.join(subdir, `${readableBase}${ext}`)
    const opaqueBase = buildOpaqueAssetBase(seed, urlKey)
    const filename = `${opaqueBase}.enc`
    const encRel = path.posix.join(subdir, filename)
    setPathAlias(encRel, plainRel)
    writeAtomic(path.join(dir, filename), encryptPlain(buf, ext))
    return encRel
  }
  const filename = `${readableBase}${ext}`
  writeAtomic(path.join(dir, filename), buf)
  return path.posix.join(subdir, filename)
}

function extFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (IMAGE_EXTENSIONS.includes(ext)) return ext
  throw new Error('不支持的图片格式')
}

function assertUsableImageBuffer(data: Buffer, message: string): void {
  if (!isUsableImageBuffer(data)) throw new Error(message)
}

function importImageFromFile(subdir: ImageAssetSubdir, seed: string, sourcePath: string): string {
  if (!fs.existsSync(sourcePath)) throw new Error('图片文件不存在')
  const ext = extFromPath(sourcePath)
  const buf = fs.readFileSync(sourcePath)
  assertUsableImageBuffer(buf, '导入的图片不是可用图片')
  const urlKey = `${sourcePath}:${randomUUID()}`
  const rel = writeImageAsset(subdir, seed, urlKey, ext, buf)
  invalidateAssetCache(rel)
  return rel
}

type ClassificationImageKind = 'organization' | 'director' | 'series'

function classificationImageSubdir(kind: ClassificationImageKind): ImageAssetSubdir {
  return kind === 'director' ? 'avatars' : 'covers'
}

function classificationImageSeed(kind: ClassificationImageKind, id: number, name: string): string {
  return `classification-${kind}-${id}-${name}`
}

export function importClassificationImageFromBuffer(
  kind: ClassificationImageKind,
  id: number,
  name: string,
  data: Buffer
): string {
  assertUsableImageBuffer(data, '分类主图不是可用图片')
  const extension = detectImageExtensionFromBuffer(data) ?? '.jpg'
  return writeImageAsset(
    classificationImageSubdir(kind),
    classificationImageSeed(kind, id, name),
    `classification-image:${randomUUID()}`,
    extension,
    data
  )
}

export function importClassificationImageFromFile(
  kind: ClassificationImageKind,
  id: number,
  name: string,
  sourcePath: string
): string {
  if (!fs.existsSync(sourcePath)) throw new Error('图片文件不存在')
  return importClassificationImageFromBuffer(kind, id, name, fs.readFileSync(sourcePath))
}

export function importCoverFromFile(code: string, sourcePath: string): string {
  return importImageFromFile('covers', code, sourcePath)
}

export function importPlaylistCoverFromFile(name: string, sourcePath: string): string {
  return importImageFromFile('playlist_covers', name, sourcePath)
}

export function importSampleFromFile(code: string, sourcePath: string): string {
  return importImageFromFile('samples', code, sourcePath)
}

export function importActressGalleryFromFile(
  name: string,
  sourcePath: string,
  actressId?: number | null
): string {
  return importImageFromFile(
    'actress_gallery',
    buildActressAssetSeed(name, actressId),
    sourcePath
  )
}

export function importAvatarSourceFromBuffer(
  name: string,
  actressId: number,
  data: Buffer,
  ext = '.jpg'
): { relPath: string; fingerprint: string } {
  assertUsableImageBuffer(data, '头像不是可用图片')
  const fingerprint = avatarSourceFingerprint(data)
  const detectedExt = detectImageExtensionFromBuffer(data)
  const normalizedExt =
    detectedExt ?? (IMAGE_EXTENSIONS.includes(ext.toLowerCase()) ? ext.toLowerCase() : '.jpg')
  const urlKey = `avatar-source:${fingerprint}:${randomUUID()}`
  const rel = writeImageAsset(
    'avatars',
    buildActressAssetSeed(name, actressId),
    urlKey,
    normalizedExt,
    data
  )
  invalidateAssetCache(rel)
  return { relPath: rel, fingerprint }
}

export function importAvatarDisplayFromBuffer(
  name: string,
  actressId: number,
  data: Buffer
): string {
  assertUsableImageBuffer(data, '头像不是可用图片')
  const urlKey = `avatar-display:${actressId}:${randomUUID()}`
  const rel = writeImageAsset(
    'avatars',
    buildActressAssetSeed(name, actressId),
    urlKey,
    '.jpg',
    data
  )
  invalidateAssetCache(rel)
  return rel
}
