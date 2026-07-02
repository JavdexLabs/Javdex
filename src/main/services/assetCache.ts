/** In-memory LRU cache for decrypted/plain asset bytes served via media:// */

interface CacheEntry {
  body: Buffer
  mime: string
  mtimeMs: number
  bytes: number
}

const MAX_ENTRIES = 256
const MAX_BYTES = 96 * 1024 * 1024

const cache = new Map<string, CacheEntry>()
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

export function invalidateAssetCache(relPath?: string): void {
  if (!relPath) {
    cache.clear()
    totalBytes = 0
    return
  }
  const entry = cache.get(relPath)
  if (entry) {
    cache.delete(relPath)
    totalBytes -= entry.bytes
  }
}
