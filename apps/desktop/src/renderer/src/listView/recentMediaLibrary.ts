import { parsePositiveRouteId } from './routeIds'

const RECENT_MEDIA_LIBRARY_KEY = 'javdex.recentMediaLibraryId'

interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Last library that successfully rendered an active catalog surface or detail. */
export function readRecentMediaLibraryId(
  storage: KeyValueStorage | null = browserStorage()
): number | null {
  if (!storage) return null
  try {
    return parsePositiveRouteId(storage.getItem(RECENT_MEDIA_LIBRARY_KEY) ?? undefined)
  } catch {
    return null
  }
}

export function rememberRecentMediaLibraryId(
  libraryId: number,
  storage: KeyValueStorage | null = browserStorage()
): void {
  if (!Number.isSafeInteger(libraryId) || libraryId <= 0 || !storage) return
  try {
    storage.setItem(RECENT_MEDIA_LIBRARY_KEY, String(libraryId))
  } catch {
    // Navigation remains usable when storage is unavailable.
  }
}

export const RECENT_MEDIA_LIBRARY_STORAGE_KEY = RECENT_MEDIA_LIBRARY_KEY
