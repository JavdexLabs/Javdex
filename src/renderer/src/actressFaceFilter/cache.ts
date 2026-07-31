import type { ActressListItem } from '@shared/types'

export type ActressFaceScanStatus = 'has-face' | 'without-face'

export interface ActressFaceScanCacheEntry {
  fingerprint: string
  status: ActressFaceScanStatus
}

export type ActressFaceScanCache = Map<number, ActressFaceScanCacheEntry>

export function getCachedActressFaceStatus(
  cache: ActressFaceScanCache,
  actressId: number,
  fingerprint: string
): ActressFaceScanStatus | null {
  const entry = cache.get(actressId)
  if (!entry || entry.fingerprint !== fingerprint) return null
  return entry.status
}

export function cacheActressFaceStatus(
  cache: ActressFaceScanCache,
  actressId: number,
  fingerprint: string,
  status: ActressFaceScanStatus
): void {
  cache.set(actressId, { fingerprint, status })
}

export function actressesWithoutFace(
  items: ActressListItem[],
  cache: ActressFaceScanCache
): ActressListItem[] {
  return items.filter((item) => {
    const fingerprint = item.avatar_fingerprint?.trim()
    if (!fingerprint) return false
    return getCachedActressFaceStatus(cache, item.id, fingerprint) === 'without-face'
  })
}

/** Stable identity for current rows whose face result is missing or stale. */
export function uncachedActressFaceScanIdentity(
  items: ActressListItem[],
  cache: ActressFaceScanCache
): string {
  return items
    .filter((item) => {
      const fingerprint = item.avatar_fingerprint?.trim()
      return Boolean(fingerprint && !getCachedActressFaceStatus(cache, item.id, fingerprint))
    })
    .map((item) => `${item.id}:${item.avatar_fingerprint}`)
    .join('|')
}
