/** In-memory caches for stored media bytes and derived image inspection results. */

interface CacheEntry {
  relPath: string
  body: Buffer
  mime: string
  signature: AssetByteSignature
  bytes: number
}

export interface AssetByteSignature extends ImageAssetSignature {
  device: number
  inode: number
}

export function sameAssetByteSignature(a: AssetByteSignature, b: AssetByteSignature): boolean {
  return a.resolvedPath === b.resolvedPath && a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs && a.size === b.size && a.device === b.device && a.inode === b.inode
}

export interface ImageAssetSignature {
  resolvedPath: string
  mtimeMs: number
  ctimeMs: number
  size: number
}

export interface ImageAssetInspection {
  usable: boolean
  fingerprint: string | null
}

interface ImageInspectionCacheEntry extends ImageAssetSignature {
  inspection: ImageAssetInspection
}

const MAX_ENTRIES = 256
const MAX_BYTES = 96 * 1024 * 1024

const cache = new Map<string, CacheEntry>()
const imageInspectionCache = new Map<string, ImageInspectionCacheEntry>()
let totalBytes = 0
let revision = 0

export function getAssetCacheRevision(): number { return revision }

function evictOne(): void {
  const oldest = cache.keys().next().value as string | undefined
  if (!oldest) return
  const entry = cache.get(oldest)
  cache.delete(oldest)
  if (entry) totalBytes -= entry.bytes
}

function trim(): void {
  while (cache.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    if (cache.size === 0) break
    evictOne()
  }
}

export function getCachedAsset(
  relPath: string,
  signature: AssetByteSignature,
  variant = 'original'
): { body: Buffer; mime: string } | null {
  const key = JSON.stringify([relPath, variant])
  const entry = cache.get(key)
  if (!entry || !sameAssetByteSignature(entry.signature, signature)) return null
  cache.delete(key)
  cache.set(key, entry)
  return { body: Buffer.from(entry.body), mime: entry.mime }
}

export function setCachedAsset(
  relPath: string,
  signature: AssetByteSignature,
  body: Buffer,
  mime: string,
  variant = 'original'
): void {
  const key = JSON.stringify([relPath, variant])
  const prev = cache.get(key)
  if (prev) totalBytes -= prev.bytes
  cache.delete(key)
  if (body.byteLength > MAX_BYTES) return
  cache.set(key, { relPath, body: Buffer.from(body), mime, signature: { ...signature }, bytes: body.byteLength })
  totalBytes += body.byteLength
  trim()
}

export function getOrLoadImageInspection(
  relPath: string,
  signature: ImageAssetSignature,
  load: () => ImageAssetInspection
): ImageAssetInspection {
  const cached = imageInspectionCache.get(relPath)
  if (
    cached &&
    cached.resolvedPath === signature.resolvedPath &&
    cached.mtimeMs === signature.mtimeMs &&
    cached.ctimeMs === signature.ctimeMs &&
    cached.size === signature.size
  ) {
    imageInspectionCache.delete(relPath)
    imageInspectionCache.set(relPath, cached)
    return cached.inspection
  }

  const inspection = load()
  imageInspectionCache.delete(relPath)
  imageInspectionCache.set(relPath, { ...signature, inspection })
  while (imageInspectionCache.size > MAX_ENTRIES) {
    const oldest = imageInspectionCache.keys().next().value as string | undefined
    if (!oldest) break
    imageInspectionCache.delete(oldest)
  }
  return inspection
}

export function invalidateAssetCache(relPath?: string): void {
  revision++
  if (!relPath) {
    cache.clear()
    imageInspectionCache.clear()
    totalBytes = 0
    return
  }
  for (const [key, entry] of cache) {
    if (entry.relPath === relPath) {
      cache.delete(key)
      totalBytes -= entry.bytes
    }
  }
  imageInspectionCache.delete(relPath)
}
