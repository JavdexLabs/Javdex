export const NFO_DIRECTORY_CACHE_MAX_SCOPES = 64
export const NFO_DIRECTORY_CACHE_MAX_BYTES = 1024 * 1024

const encodedBytes = (value: string): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** Per-instance/per-layer request cache, non-evicting: anchors may retain admitted values.
 * Production anchor snapshots and collect lookups each have these limits (combined
 * at most 128 scopes / 2 MiB encoded cache strings). This excludes caller-provided
 * maps, uncached anchor summaries, transient listings, and JS object overhead.
 * Callers must not mutate admitted maps; provided caller-owned maps bypass this cache.
 */
export class NfoDirectoryCache<T> {
  private readonly values = new Map<string, T>()
  private bytes = 0

  get(key: string): T | undefined { return this.values.get(key) }

  admit(key: string, value: T, sidecars: ReadonlyMap<string, string>, normalizedCode?: string | null): boolean {
    if (this.values.has(key) || this.values.size >= NFO_DIRECTORY_CACHE_MAX_SCOPES) return false
    let bytes = encodedBytes(key) + (normalizedCode == null ? 0 : encodedBytes(normalizedCode))
    for (const [name, filename] of sidecars) {
      bytes += encodedBytes(name) + encodedBytes(filename)
      if (bytes > NFO_DIRECTORY_CACHE_MAX_BYTES - this.bytes) return false
    }
    if (bytes > NFO_DIRECTORY_CACHE_MAX_BYTES - this.bytes) return false
    this.values.set(key, value)
    this.bytes += bytes
    return true
  }
}
