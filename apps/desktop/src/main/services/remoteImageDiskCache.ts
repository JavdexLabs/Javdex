import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const REMOTE_IMAGE_CACHE_DIR = 'remote-image-cache'
export const DEFAULT_REMOTE_IMAGE_CACHE_MAX_ENTRIES = 512
export const DEFAULT_REMOTE_IMAGE_CACHE_MAX_BYTES = 256 * 1024 * 1024

export interface RemoteImageDiskCacheOptions {
  userDataPath: string
  catalogId: string
  maxEntries?: number
  maxBytes?: number
}

export interface CachedRemoteImage {
  body: Buffer
  mime: string
}

interface IndexEntry {
  key: string
  file: string
  mime: string
  bytes: number
  atime: number
}

interface IndexRecord {
  version: 1
  catalogId: string
  entries: IndexEntry[]
}

function cacheKey(relPath: string, size?: number): string {
  return crypto.createHash('sha256').update(JSON.stringify([relPath, size ?? null])).digest('hex')
}

export function remoteImageCacheCatalogDir(userDataPath: string, catalogId: string): string {
  const catalogDir = crypto.createHash('sha256').update(catalogId).digest('hex').slice(0, 32)
  return path.join(userDataPath, REMOTE_IMAGE_CACHE_DIR, catalogDir)
}

function loadIndex(indexPath: string, catalogId: string): IndexRecord {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as IndexRecord
    if (parsed.version === 1 && parsed.catalogId === catalogId && Array.isArray(parsed.entries)) {
      return parsed
    }
  } catch {
    // Missing or corrupt index starts empty; files without index entries are ignored.
  }
  return { version: 1, catalogId, entries: [] }
}

export interface RemoteImageDiskCache {
  readonly catalogId: string
  readonly directory: string
  get(relPath: string, size?: number): CachedRemoteImage | null
  set(relPath: string, mime: string, body: Buffer, size?: number): void
  clear(): void
}

/**
 * Temporary per-catalog LRU for remote manage images. Not an offline library:
 * misses still require a live session, and catalog identity isolates entries.
 */
export function openRemoteImageDiskCache(options: RemoteImageDiskCacheOptions): RemoteImageDiskCache {
  const maxEntries = options.maxEntries ?? DEFAULT_REMOTE_IMAGE_CACHE_MAX_ENTRIES
  const maxBytes = options.maxBytes ?? DEFAULT_REMOTE_IMAGE_CACHE_MAX_BYTES
  const directory = remoteImageCacheCatalogDir(options.userDataPath, options.catalogId)
  fs.mkdirSync(directory, { recursive: true })
  const indexPath = path.join(directory, 'index.json')
  let record = loadIndex(indexPath, options.catalogId)
  let clock = record.entries.reduce((max, entry) => Math.max(max, entry.atime), 0)

  const persist = (): void => {
    fs.writeFileSync(indexPath, JSON.stringify(record))
  }

  const touch = (): number => {
    clock += 1
    return clock
  }

  const evict = (): void => {
    record.entries.sort((left, right) => left.atime - right.atime)
    let total = record.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    while (record.entries.length > maxEntries || total > maxBytes) {
      const oldest = record.entries.shift()
      if (!oldest) break
      total -= oldest.bytes
      fs.rmSync(path.join(directory, oldest.file), { force: true })
    }
  }

  const drop = (key: string): void => {
    const existing = record.entries.find((entry) => entry.key === key)
    record.entries = record.entries.filter((entry) => entry.key !== key)
    if (existing) fs.rmSync(path.join(directory, existing.file), { force: true })
  }

  return {
    catalogId: options.catalogId,
    directory,
    get(relPath, size) {
      const key = cacheKey(relPath, size)
      const entry = record.entries.find((item) => item.key === key)
      if (!entry) return null
      try {
        const body = fs.readFileSync(path.join(directory, entry.file))
        if (body.byteLength !== entry.bytes) {
          drop(key)
          persist()
          return null
        }
        entry.atime = touch()
        persist()
        return { body: Buffer.from(body), mime: entry.mime }
      } catch {
        drop(key)
        persist()
        return null
      }
    },
    set(relPath, mime, body, size) {
      if (body.byteLength > maxBytes) return
      const key = cacheKey(relPath, size)
      const file = `${key}.bin`
      const abs = path.join(directory, file)
      const tmp = `${abs}.tmp`
      fs.writeFileSync(tmp, body)
      fs.renameSync(tmp, abs)
      record.entries = record.entries.filter((entry) => entry.key !== key)
      record.entries.push({
        key,
        file,
        mime,
        bytes: body.byteLength,
        atime: touch()
      })
      evict()
      persist()
    },
    clear() {
      fs.rmSync(directory, { recursive: true, force: true })
      fs.mkdirSync(directory, { recursive: true })
      record = { version: 1, catalogId: options.catalogId, entries: [] }
      persist()
    }
  }
}
