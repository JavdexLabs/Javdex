import path from 'node:path'
import fs from 'node:fs'
import { getSettings } from '../../settings/settingsStore'
import { encryptPlain, decryptBlob, isEncryptedBlob, mimeFromExt } from '../assetCrypto'
import { invalidateAssetCache } from '../assetCache'
import { ensureMediaAssetDirsAt, resolveMediaAssetsRoot } from '../assetStoragePaths'
import {
  buildActressAssetSeed,
  buildOpaqueAssetBase,
  buildReadableAssetBase
} from '../assetPathNaming'
import { setPathAlias } from '../assetPathAliases'
import {
  avatarSourceFingerprint,
  detectImageExtensionFromBuffer
} from './imageBytes'
import type { ImageAssetSubdir } from './types'

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']

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

function importImageFromFile(subdir: ImageAssetSubdir, seed: string, sourcePath: string): string {
  if (!fs.existsSync(sourcePath)) throw new Error('图片文件不存在')
  const ext = extFromPath(sourcePath)
  const buf = fs.readFileSync(sourcePath)
  const urlKey = `${sourcePath}:${Date.now()}`
  const rel = writeImageAsset(subdir, seed, urlKey, ext, buf)
  invalidateAssetCache(rel)
  return rel
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
  const fingerprint = avatarSourceFingerprint(data)
  const detectedExt = detectImageExtensionFromBuffer(data)
  const normalizedExt =
    detectedExt ?? (IMAGE_EXTENSIONS.includes(ext.toLowerCase()) ? ext.toLowerCase() : '.jpg')
  const urlKey = `avatar-source:${fingerprint}`
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
  const urlKey = `avatar-display:${actressId}:${Date.now()}`
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
