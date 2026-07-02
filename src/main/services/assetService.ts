import { app, nativeImage } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { getSettings } from '../settings/settingsStore'
import { encryptPlain, decryptBlob, isEncryptedBlob, mimeFromExt } from './assetCrypto'
import { getCachedAsset, setCachedAsset, invalidateAssetCache } from './assetCache'
import {
  ensureMediaAssetDirsAt,
  resolveMediaAssetsRoot
} from './assetStoragePaths'
import {
  buildOpaqueAssetBase,
  buildReadableAssetBase
} from './assetPathNaming'
import { setPathAlias } from './assetPathAliases'

/** A function that downloads a URL into a Buffer (session-aware). */
export type AssetFetcher = (url: string) => Promise<Buffer>

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
  return path.join(assetsRoot(), relPath)
}

function writeAtomic(abs: string, data: Buffer): void {
  const tmp = `${abs}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, abs)
}

/** Read an asset for media:// serving; decrypts .enc blobs when needed. */
export function readAssetForServe(relPath: string): { body: Buffer; mime: string } {
  const abs = resolveAssetPath(relPath)
  if (!fs.existsSync(abs)) throw new Error('Asset not found')
  const raw = fs.readFileSync(abs)
  if (relPath.endsWith('.enc') || isEncryptedBlob(raw)) {
    const { data, ext } = decryptBlob(raw)
    return { body: data, mime: mimeFromExt(ext) }
  }
  return { body: raw, mime: mimeFromExt(path.extname(relPath)) }
}

function hasImageMagicBytes(buf: Buffer): boolean {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return true
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return true
  }
  return false
}

/** True when a stored relative asset path resolves to a readable non-empty image. */
export function isUsableImageAsset(relPath: string | null | undefined): boolean {
  if (!relPath?.trim()) return false
  try {
    const abs = resolveAssetPath(relPath.trim())
    if (!fs.existsSync(abs)) return false
    const { body } = readAssetForServe(relPath.trim())
    if (body.length === 0) return false
    if (body[0] === 0x3c || body[0] === 0x7b) return false

    if (typeof nativeImage?.createFromBuffer === 'function') {
      const img = nativeImage.createFromBuffer(body)
      if (!img.isEmpty()) {
        const { width, height } = img.getSize()
        if (width > 0 && height > 0) return true
      }
    }

    return hasImageMagicBytes(body)
  } catch {
    return false
  }
}

/** Delete a stored asset by its relative path. Silently ignores errors. */
export function deleteAsset(relPath: string | null | undefined): void {
  if (!relPath) return
  try {
    const abs = resolveAssetPath(relPath)
    const root = assetsRoot()
    if (abs.startsWith(root) && fs.existsSync(abs)) {
      fs.unlinkSync(abs)
    }
  } catch (err) {
    console.error('deleteAsset failed:', relPath, (err as Error).message)
  }
}

function extFromUrl(url: string): string {
  const clean = url.split('?')[0]
  const ext = path.extname(clean).toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(ext)) return ext
  return '.jpg'
}

type ImageAssetSubdir = 'covers' | 'avatars' | 'actress_gallery' | 'samples' | 'playlist_covers'

function writeImageAsset(
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

function imageAssetDir(subdir: ImageAssetSubdir): string {
  if (subdir === 'covers') return coversDir()
  if (subdir === 'avatars') return avatarsDir()
  if (subdir === 'actress_gallery') return actressGalleryDir()
  if (subdir === 'samples') return samplesDir()
  return playlistCoversDir()
}

/** Pixel dimensions read from an image file or buffer. */
export interface ImageDimensions {
  width: number
  height: number
}

export interface DownloadedImageAsset {
  localPath: string
  width: number | null
  height: number | null
}

function readNativeImageSize(img: Electron.NativeImage): ImageDimensions | null {
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

function readJpegExifOrientation(data: Buffer): number | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null

  let offset = 2
  while (offset + 4 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = data[offset + 1]
    if (marker === 0xd9) break
    const segmentLength = data.readUInt16BE(offset + 2)
    if (segmentLength < 2 || offset + 2 + segmentLength > data.length) break

    if (marker === 0xe1 && segmentLength >= 8) {
      const exifHeader = data.toString('ascii', offset + 4, offset + 10)
      if (exifHeader === 'Exif\0\0') {
        const tiffStart = offset + 10
        if (tiffStart + 8 <= data.length) {
          const littleEndian = data[tiffStart] === 0x49 && data[tiffStart + 1] === 0x49
          const readU16 = littleEndian
            ? (pos: number) => data.readUInt16LE(pos)
            : (pos: number) => data.readUInt16BE(pos)
          const readU32 = littleEndian
            ? (pos: number) => data.readUInt32LE(pos)
            : (pos: number) => data.readUInt32BE(pos)
          const ifd0Offset = tiffStart + readU32(tiffStart + 4)
          if (ifd0Offset + 2 <= data.length) {
            const entryCount = readU16(ifd0Offset)
            for (let i = 0; i < entryCount; i++) {
              const entry = ifd0Offset + 2 + i * 12
              if (entry + 12 > data.length) break
              if (readU16(entry) === 0x0112) {
                return readU16(entry + 8)
              }
            }
          }
        }
      }
    }

    offset += 2 + segmentLength
  }

  return null
}

function applyExifOrientation(width: number, height: number, orientation: number | null): ImageDimensions {
  if (orientation != null && orientation >= 5 && orientation <= 8) {
    return { width: height, height: width }
  }
  return { width, height }
}

function readImageDimensionsFromBufferFallback(data: Buffer): ImageDimensions | null {
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    const width = data.readUInt32BE(16)
    const height = data.readUInt32BE(20)
    if (width > 0 && height > 0) return { width, height }
    return null
  }

  if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    const width = data.readUInt16LE(6)
    const height = data.readUInt16LE(8)
    if (width > 0 && height > 0) return { width, height }
    return null
  }

  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    const orientation = readJpegExifOrientation(data)
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = data[offset + 1]
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2
        continue
      }
      const segmentLength = data.readUInt16BE(offset + 2)
      if (segmentLength < 2 || offset + 2 + segmentLength > data.length) break
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = data.readUInt16BE(offset + 5)
        const width = data.readUInt16BE(offset + 7)
        if (width > 0 && height > 0) {
          return applyExifOrientation(width, height, orientation)
        }
        return null
      }
      offset += 2 + segmentLength
    }
  }

  return null
}

/** Read image dimensions from a local file without loading it into the renderer. */
export function readImageDimensionsFromPath(filePath: string): ImageDimensions | null {
  try {
    if (!fs.existsSync(filePath)) return null
    if (typeof nativeImage?.createFromPath === 'function') {
      const fromNative = readNativeImageSize(nativeImage.createFromPath(filePath))
      if (fromNative) return fromNative
    }
    return readImageDimensionsFromBufferFallback(fs.readFileSync(filePath))
  } catch {
    return null
  }
}

/** Read image dimensions from an in-memory image buffer. */
export function readImageDimensionsFromBuffer(data: Buffer): ImageDimensions | null {
  try {
    if (typeof nativeImage?.createFromBuffer === 'function') {
      const fromNative = readNativeImageSize(nativeImage.createFromBuffer(data))
      if (fromNative) return fromNative
    }
  } catch {
    // fall through to header parsing
  }
  return readImageDimensionsFromBufferFallback(data)
}

/** Read image dimensions from a stored relative asset path (supports encrypted assets). */
export function readImageDimensionsFromRelPath(relPath: string | null | undefined): ImageDimensions | null {
  if (!relPath?.trim()) return null
  try {
    const { body } = readAssetForServe(relPath.trim())
    return readImageDimensionsFromBuffer(body)
  } catch {
    return null
  }
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']

function extFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (IMAGE_EXTENSIONS.includes(ext)) return ext
  throw new Error('不支持的图片格式')
}

function importImageFromFile(subdir: ImageAssetSubdir, seed: string, sourcePath: string): string {
  if (!fs.existsSync(sourcePath)) throw new Error('图片文件不存在')
  const ext = extFromPath(sourcePath)
  const buf = fs.readFileSync(sourcePath)
  const urlKey = `${sourcePath}:${Date.now()}`
  const rel = writeImageAsset(subdir, seed, urlKey, ext, buf)
  invalidateAssetCache(rel)
  return rel
}

/** Import a local image file as a video cover. Returns relative asset path. */
export function importCoverFromFile(code: string, sourcePath: string): string {
  return importImageFromFile('covers', code, sourcePath)
}

/** Import a local image file as a playlist cover. Returns relative asset path. */
export function importPlaylistCoverFromFile(name: string, sourcePath: string): string {
  return importImageFromFile('playlist_covers', name, sourcePath)
}

/** Import a local image file as a video sample still. Returns relative asset path. */
export function importSampleFromFile(code: string, sourcePath: string): string {
  return importImageFromFile('samples', code, sourcePath)
}

/** Import a local image file as an actress avatar. Returns relative asset path. */
export function importAvatarFromFile(name: string, sourcePath: string): string {
  return importImageFromFile('avatars', name, sourcePath)
}

/** Import a local image file as an actress gallery image. Returns relative asset path. */
export function importActressGalleryFromFile(name: string, sourcePath: string): string {
  return importImageFromFile('actress_gallery', name, sourcePath)
}

/** Import cropped avatar bytes (JPEG). Returns relative asset path. */
export function importAvatarFromBuffer(name: string, data: Buffer): string {
  const urlKey = `crop:${Date.now()}`
  const rel = writeImageAsset('avatars', name, urlKey, '.jpg', data)
  invalidateAssetCache(rel)
  return rel
}

/**
 * Download an image to the covers/ dir. Returns the *relative* path
 * (e.g. "covers/IPX-535_ab12cd34.jpg", or "covers/{opaque}.enc" when encryption is on)
 * or null on failure.
 */
export async function downloadCover(
  code: string,
  url: string,
  fetcher: AssetFetcher
): Promise<string | null> {
  try {
    const ext = extFromUrl(url)
    const buf = await fetcher(url)
    return writeImageAsset('covers', code, url, ext, buf)
  } catch (err) {
    console.error('downloadCover failed:', code, url, (err as Error).message)
    return null
  }
}

/** Download an actress avatar. Returns relative path or null. */
export async function downloadAvatar(
  name: string,
  url: string,
  fetcher: AssetFetcher
): Promise<string | null> {
  try {
    const ext = extFromUrl(url)
    const buf = await fetcher(url)
    return writeImageAsset('avatars', name, url, ext, buf)
  } catch (err) {
    console.error('downloadAvatar failed:', name, url, (err as Error).message)
    return null
  }
}

/** Download an actress gallery image. Returns relative path and dimensions, or null. */
export async function downloadActressGalleryImage(
  name: string,
  url: string,
  fetcher: AssetFetcher
): Promise<DownloadedImageAsset | null> {
  try {
    const ext = extFromUrl(url)
    const buf = await fetcher(url)
    const localPath = writeImageAsset('actress_gallery', name, url, ext, buf)
    const dims =
      readImageDimensionsFromRelPath(localPath) ?? readImageDimensionsFromBuffer(buf)
    return {
      localPath,
      width: dims?.width ?? null,
      height: dims?.height ?? null
    }
  } catch (err) {
    console.error('downloadActressGalleryImage failed:', name, url, (err as Error).message)
    return null
  }
}

/**
 * Download preview stills to samples/ (e.g. samples/MILK-181_0_ab12cd34.jpg).
 * Uses code + position in the filename seed, same hashing scheme as covers.
 */
export async function downloadSamples(
  code: string,
  urls: string[],
  fetcher: AssetFetcher
): Promise<Array<string | null>> {
  const out: Array<string | null> = []
  for (let index = 0; index < urls.length; index++) {
    const url = urls[index]
    try {
      const ext = extFromUrl(url)
      const buf = await fetcher(url)
      out.push(writeImageAsset('samples', `${code}_${index}`, url, ext, buf))
    } catch (err) {
      console.error('downloadSamples failed:', code, index, url, (err as Error).message)
      out.push(null)
    }
  }
  return out
}
