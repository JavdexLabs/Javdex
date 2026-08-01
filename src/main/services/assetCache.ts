/** In-memory caches for stored media bytes and derived image inspection results. */

interface CacheEntry {
  body: Buffer
  mime: string
  mtimeMs: number
  bytes: number
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
  mtimeMs: number
): { body: Buffer; mime: string } | null {
  const entry = cache.get(relPath)
  if (!entry || entry.mtimeMs !== mtimeMs) return null
  cache.delete(relPath)
  cache.set(relPath, entry)
  return { body: entry.body, mime: entry.mime }
}

export function setCachedAsset(
  relPath: string,
  mtimeMs: number,
  body: Buffer,
  mime: string
): void {
  const prev = cache.get(relPath)
  if (prev) totalBytes -= prev.bytes

  cache.set(relPath, { body, mime, mtimeMs, bytes: body.byteLength })
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
  if (!relPath) {
    cache.clear()
    imageInspectionCache.clear()
    totalBytes = 0
    return
  }
  const entry = cache.get(relPath)
  if (entry) {
    cache.delete(relPath)
    totalBytes -= entry.bytes
  }
  imageInspectionCache.delete(relPath)
}
