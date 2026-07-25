/**
 * URL-keyed LRU for image bodies captured from the scraper BrowserWindow
 * (CDP Network.getResponseBody). Used so fetchBuffer can reuse page-loaded
 * images without a second HTTP download.
 */

export const DEFAULT_IMAGE_CACHE_MAX_ENTRIES = 96
export const DEFAULT_IMAGE_CACHE_MAX_BYTES = 200 * 1024 * 1024

export function normalizeNetworkUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    parsed.hostname = parsed.hostname.toLowerCase()
    return parsed.href
  } catch {
    return null
  }
}

/** Origin + pathname only (no search/hash), for weak unique matching. */
export function networkUrlPathKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname}`
  } catch {
    return null
  }
}

export class ImageBodyLruCache {
  private readonly bodies = new Map<string, Buffer>()
  private readonly aliases = new Map<string, string>()
  private readonly order: string[] = []
  private bytes = 0

  constructor(
    private readonly maxEntries = DEFAULT_IMAGE_CACHE_MAX_ENTRIES,
    private readonly maxBytes = DEFAULT_IMAGE_CACHE_MAX_BYTES
  ) {}

  get size(): number {
    return this.bodies.size
  }

  get byteSize(): number {
    return this.bytes
  }

  clear(): void {
    this.bodies.clear()
    this.aliases.clear()
    this.order.length = 0
    this.bytes = 0
  }

  set(urls: Iterable<string>, body: Buffer): void {
    if (!body.length) return

    const keys: string[] = []
    for (const url of urls) {
      const key = normalizeNetworkUrl(url)
      if (key) keys.push(key)
    }
    if (!keys.length) return

    const primary = keys[0]!
    for (const key of keys) {
      this.removeKey(key)
    }

    this.bodies.set(primary, body)
    this.bytes += body.length
    for (const key of keys) {
      this.aliases.set(key, primary)
    }
    this.order.push(primary)
    this.evict()
  }

  get(url: string): Buffer | null {
    const key = normalizeNetworkUrl(url)
    if (!key) return null

    const primary = this.aliases.get(key)
    if (primary) {
      const body = this.bodies.get(primary)
      if (body) {
        this.touch(primary)
        return body
      }
    }

    const direct = this.bodies.get(key)
    if (direct) {
      this.touch(key)
      return direct
    }

    return this.getByUniquePath(key)
  }

  private getByUniquePath(normalizedUrl: string): Buffer | null {
    const pathKey = networkUrlPathKey(normalizedUrl)
    if (!pathKey) return null

    const matches: Buffer[] = []
    const seen = new Set<Buffer>()
    for (const [alias, primary] of this.aliases) {
      if (networkUrlPathKey(alias) !== pathKey) continue
      const body = this.bodies.get(primary)
      if (!body || seen.has(body)) continue
      seen.add(body)
      matches.push(body)
    }
    for (const [primary, body] of this.bodies) {
      if (networkUrlPathKey(primary) !== pathKey || seen.has(body)) continue
      seen.add(body)
      matches.push(body)
    }

    if (matches.length === 1) {
      return matches[0]!
    }
    if (matches.length > 1 && matches.every((buf) => buf.equals(matches[0]!))) {
      return matches[0]!
    }
    return null
  }

  private removeKey(key: string): void {
    const primary = this.aliases.get(key) ?? (this.bodies.has(key) ? key : null)
    if (!primary) {
      this.aliases.delete(key)
      return
    }

    const body = this.bodies.get(primary)
    if (body) {
      this.bytes -= body.length
      this.bodies.delete(primary)
    }
    for (const [alias, target] of [...this.aliases]) {
      if (target === primary) this.aliases.delete(alias)
    }
    const idx = this.order.indexOf(primary)
    if (idx >= 0) this.order.splice(idx, 1)
  }

  private touch(primary: string): void {
    const idx = this.order.indexOf(primary)
    if (idx >= 0) this.order.splice(idx, 1)
    this.order.push(primary)
  }

  private evict(): void {
    while (
      this.order.length > 0 &&
      (this.order.length > this.maxEntries || this.bytes > this.maxBytes)
    ) {
      const oldest = this.order[0]
      if (!oldest) break
      this.removeKey(oldest)
    }
  }
}

export function isImageNetworkResource(params: {
  type?: string
  mimeType?: string
  status?: number
}): boolean {
  const status = params.status ?? 0
  if (status > 0 && (status < 200 || status >= 400)) return false
  if (params.type === 'Image') return true
  const mime = (params.mimeType ?? '').toLowerCase()
  return mime.startsWith('image/')
}

/** Minimal magic-byte check so we do not cache HTML/JSON error bodies. */
export function hasImageMagicBytes(buf: Buffer): boolean {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return true
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return true
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return true
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return true
  }
  if (buf.length >= 16 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brands = buf.toString('ascii', 8, Math.min(buf.length, 40))
    if (brands.includes('avif') || brands.includes('avis')) return true
  }
  return false
}
