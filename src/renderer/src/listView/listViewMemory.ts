import { parseMediaLibraryRoute } from './mediaLibraryRoutes'
import { ROUTE_PATH } from './routePaths'

/** In-memory list scroll (cleared on full reload; not written to storage). */

export interface ListScrollSnapshot {
  scrollTop: number
  visibleRowIndex: number
}

const scrollByKey = new Map<string, ListScrollSnapshot>()

export function getListScroll(memoryKey: string): ListScrollSnapshot | undefined {
  return scrollByKey.get(memoryKey)
}

export function setListScroll(memoryKey: string, patch: Partial<ListScrollSnapshot>): void {
  const prev = scrollByKey.get(memoryKey) ?? { scrollTop: 0, visibleRowIndex: 0 }
  scrollByKey.set(memoryKey, { ...prev, ...patch })
}

export function clearListScroll(memoryKey: string): void {
  scrollByKey.delete(memoryKey)
}

export function clearAllListViewMemory(): void {
  scrollByKey.clear()
}

/** Sidebar primary nav: do not restore scroll for the destination list. */
export function clearListScrollForPrimaryNav(pathname: string): void {
  const keys = [...scrollByKey.keys()]
  if (pathname === ROUTE_PATH.home) {
    for (const key of keys) {
      if (key.startsWith('home:')) scrollByKey.delete(key)
    }
    return
  }
  if (pathname === ROUTE_PATH.search) {
    for (const key of keys) {
      if (key.startsWith('global-search:')) scrollByKey.delete(key)
    }
    return
  }
  const libraryRoute = parseMediaLibraryRoute(pathname)
  if (libraryRoute?.kind === 'list') {
    for (const key of keys) {
      if (key.startsWith(`library:${libraryRoute.libraryId}:`)) scrollByKey.delete(key)
    }
    return
  }
  if (pathname === ROUTE_PATH.actresses) {
    for (const key of keys) {
      if (key.startsWith('actresses:')) scrollByKey.delete(key)
    }
    return
  }
  if (pathname === '/pending') {
    for (const key of keys) {
      if (key.startsWith('pending:')) scrollByKey.delete(key)
    }
    return
  }
  if (pathname.startsWith('/facet/') && !pathname.includes('/v/')) {
    for (const key of keys) {
      if (key.startsWith('facet:') && !key.startsWith('facet-detail:')) {
        scrollByKey.delete(key)
      }
    }
  }
}

/**
 * Filter/query change (key changes while grid stays mounted) → scroll to top.
 * Same key after remount (e.g. library → actress → back) → restore saved scrollTop.
 */
export function resolveScrollTopForKey(
  prevKey: string | undefined,
  memoryKey: string
): number {
  if (prevKey !== undefined && prevKey !== memoryKey) {
    setListScroll(memoryKey, { scrollTop: 0, visibleRowIndex: 0 })
    return 0
  }
  return getListScroll(memoryKey)?.scrollTop ?? 0
}
