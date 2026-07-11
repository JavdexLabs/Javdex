import { LIST_PARAM } from './listQueryParams'
import { matchPath } from 'react-router-dom'
import { ROUTE_PATH } from './routePaths'

const listSearchByRoot = new Map<string, string>()

/** Tracks the last observed list root so we only persist search when leaving it. */
let prevRoot: string | null = null
let prevSearch = ''

const SEARCH_KEYS_BY_ROOT: Record<string, readonly string[]> = {
  '/': [
    LIST_PARAM.q,
    LIST_PARAM.sort,
    LIST_PARAM.dir,
    LIST_PARAM.tags,
    LIST_PARAM.prefix,
    LIST_PARAM.status,
    LIST_PARAM.year
  ],
  '/actresses': [LIST_PARAM.q, LIST_PARAM.gender, LIST_PARAM.sort, LIST_PARAM.dir],
  '/playlists': [LIST_PARAM.q]
}

function facetRoot(pathname: string): string | null {
  const match = matchPath({ path: ROUTE_PATH.facetTree, end: false }, pathname)
  const type = match?.params.type
  return type && ['director', 'maker', 'publisher', 'series'].includes(type)
    ? `/facet/${type}`
    : null
}

export function primaryListRoot(pathname: string): string | null {
  if (
    pathname === ROUTE_PATH.library ||
    matchPath({ path: ROUTE_PATH.libraryDetailOpen, end: false }, pathname)
  ) {
    return ROUTE_PATH.library
  }
  if (matchPath({ path: ROUTE_PATH.actressTree, end: false }, pathname)) {
    return ROUTE_PATH.actresses
  }
  if (matchPath({ path: ROUTE_PATH.playlistTree, end: false }, pathname)) {
    return ROUTE_PATH.playlists
  }
  return facetRoot(pathname)
}

function scopedSearch(root: string, search: string): string {
  const allowedKeys = root.startsWith('/facet/') ? [LIST_PARAM.q] : SEARCH_KEYS_BY_ROOT[root]
  if (!allowedKeys) return ''
  const source = new URLSearchParams(search)
  const next = new URLSearchParams()
  for (const key of allowedKeys) {
    const value = source.get(key)
    if (value != null && value !== '') next.set(key, value)
  }
  const value = next.toString()
  return value ? `?${value}` : ''
}

function resolveRoot(pathnameOrRoot: string): string | null {
  return primaryListRoot(pathnameOrRoot) ?? (SEARCH_KEYS_BY_ROOT[pathnameOrRoot] ? pathnameOrRoot : null)
}

/** Persist scoped search for a list root (tests and explicit writes). */
export function rememberPrimaryListLocation(pathnameOrRoot: string, search: string): void {
  const root = resolveRoot(pathnameOrRoot)
  if (!root) return
  listSearchByRoot.set(root, scopedSearch(root, search))
}

/**
 * Call on every location change. Writes the previous list root's search only when
 * leaving that root (including leaving into settings where root is null).
 */
export function syncPrimaryNavigationMemory(pathname: string, search: string): void {
  const root = primaryListRoot(pathname)
  if (prevRoot != null && root !== prevRoot) {
    listSearchByRoot.set(prevRoot, scopedSearch(prevRoot, prevSearch))
  }
  prevRoot = root
  prevSearch = search
}

export function primaryNavigationTarget(to: string): { pathname: string; search?: string } {
  const search = listSearchByRoot.get(to)
  return search ? { pathname: to, search } : { pathname: to }
}

/**
 * Resolve sidebar primary-nav click destination.
 * - Same list root, already on root → null (no-op; caller may still clear scroll)
 * - Same list root, in detail stack → list root + current search
 * - Cross list root → remembered search for the destination
 */
export function resolvePrimaryNavTarget(
  itemTo: string,
  pathname: string,
  search: string
): { pathname: string; search?: string } | null {
  const activeRoot = primaryListRoot(pathname)
  if (activeRoot === itemTo) {
    if (pathname === itemTo) return null
    return search ? { pathname: itemTo, search } : { pathname: itemTo }
  }
  return primaryNavigationTarget(itemTo)
}

/** Href for a sidebar item: current search when active, else remembered target. */
export function primaryNavLinkTo(
  itemTo: string,
  pathname: string,
  search: string
): { pathname: string; search?: string } {
  const activeRoot = primaryListRoot(pathname)
  if (activeRoot === itemTo) {
    return search ? { pathname: itemTo, search } : { pathname: itemTo }
  }
  return primaryNavigationTarget(itemTo)
}

export function forgetPrimaryListLocation(root: string): void {
  listSearchByRoot.delete(root)
}

export function clearPrimaryNavigationMemory(): void {
  listSearchByRoot.clear()
  prevRoot = null
  prevSearch = ''
}
