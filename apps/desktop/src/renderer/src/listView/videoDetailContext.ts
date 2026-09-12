import { parseHomeVideoPath } from './homeRoutes'
import { parseLibraryVideoPath } from './libraryRoutes'
import {
  mediaLibraryPath,
  parseMediaLibraryRoute,
  parseMediaLibraryVideoPath
} from './mediaLibraryRoutes'
import { formatPositiveRouteId, parsePositiveRouteId } from './routeIds'
import { ROUTE_PATH } from './routePaths'
import { parseSearchVideoPath } from './searchRoutes'
import type { ScopedVideoDetail } from '@shared/catalogTypes'
import type { CatalogScope } from '@shared/mediaLibraryTypes'
import { ALL_CATALOG_SCOPE, mediaLibraryCatalogScope } from '../query/catalogScopes'

/** Active media library for a detail reached from a global list surface. */
export const VIDEO_DETAIL_LIBRARY_PARAM = 'lib'

export type VideoDetailRouteSource =
  | 'home'
  | 'search'
  | 'media-library'
  | 'legacy-library'

export interface VideoDetailRouteContext {
  source: VideoDetailRouteSource
  listPath: string
  videoId: number
  actressId?: number
  libraryId: number | null
  libraryIdSource: 'path' | 'query' | null
}

type LegacyDetailLoader = (
  scope: CatalogScope,
  videoId: number
) => Promise<ScopedVideoDetail | null>

/**
 * Resolve a query-owned detail deterministically: explicit URL context, then the last
 * successfully visited library, then the catalog's stable global fallback.
 */
export async function loadDetailWithLibraryFallback(
  videoId: number,
  requestedLibraryId: number | null,
  recentLibraryId: number | null,
  load: LegacyDetailLoader
): Promise<ScopedVideoDetail | null> {
  const preferredIds = [...new Set([requestedLibraryId, recentLibraryId])].filter(
    (libraryId): libraryId is number => libraryId != null
  )
  for (const libraryId of preferredIds) {
    const detail = await load(mediaLibraryCatalogScope(libraryId), videoId)
    if (detail) return detail
  }
  return load(ALL_CATALOG_SCOPE, videoId)
}

/**
 * Prefer a valid library hint from an old bookmarked URL, then fall back to the
 * catalog-selected active membership. The redirect removes `lib` afterwards
 * because its destination path owns the resolved library scope.
 */
export async function loadLegacyDetailForRedirect(
  videoId: number,
  requestedLibraryId: number | null,
  load: LegacyDetailLoader,
  recentLibraryId: number | null = null
): Promise<ScopedVideoDetail | null> {
  return loadDetailWithLibraryFallback(
    videoId,
    requestedLibraryId,
    recentLibraryId,
    load
  )
}

export function parseVideoDetailLibraryId(params: URLSearchParams): number | null {
  return parsePositiveRouteId(params.get(VIDEO_DETAIL_LIBRARY_PARAM) ?? undefined)
}

/** Canonicalize `lib`, including duplicate removal, while preserving list query state. */
export function canonicalizeVideoDetailSearchParams(
  params: URLSearchParams
): URLSearchParams {
  const next = new URLSearchParams(params)
  const libraryId = parseVideoDetailLibraryId(params)
  if (libraryId == null) next.delete(VIDEO_DETAIL_LIBRARY_PARAM)
  else next.set(VIDEO_DETAIL_LIBRARY_PARAM, String(libraryId))
  return next
}

export function setVideoDetailLibraryId(
  params: URLSearchParams,
  libraryId: number
): URLSearchParams {
  const next = new URLSearchParams(params)
  next.set(
    VIDEO_DETAIL_LIBRARY_PARAM,
    formatPositiveRouteId(libraryId, 'libraryId')
  )
  return next
}

/** Remove detail-only query state before navigating back to a list surface. */
export function stripVideoDetailSearchParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete(VIDEO_DETAIL_LIBRARY_PARAM)
  return next
}

/**
 * Normalize a known video-detail location. Library routes own their scope in the
 * path, so any query `lib` is redundant and removed.
 */
export function canonicalizeVideoDetailLocationSearch(
  pathname: string,
  params: URLSearchParams
): URLSearchParams {
  const context = parseVideoDetailRouteContext(pathname, params)
  if (context?.libraryIdSource === 'path') return stripVideoDetailSearchParams(params)
  if (context) return canonicalizeVideoDetailSearchParams(params)

  if (
    pathname === ROUTE_PATH.home ||
    pathname === ROUTE_PATH.search ||
    parseMediaLibraryRoute(pathname)
  ) {
    return stripVideoDetailSearchParams(params)
  }
  return new URLSearchParams(params)
}

function queryOwnedContext(
  source: 'home' | 'search' | 'legacy-library',
  listPath: string,
  route: { videoId: number; actressId?: number },
  params: URLSearchParams
): VideoDetailRouteContext {
  const libraryId = parseVideoDetailLibraryId(params)
  return {
    source,
    listPath,
    videoId: route.videoId,
    ...(route.actressId == null ? {} : { actressId: route.actressId }),
    libraryId,
    libraryIdSource: libraryId == null ? null : 'query'
  }
}

/** Parse supported video stacks and resolve whether active-library scope is path- or query-owned. */
export function parseVideoDetailRouteContext(
  pathname: string,
  params: URLSearchParams
): VideoDetailRouteContext | null {
  const mediaLibrary = parseMediaLibraryVideoPath(pathname)
  if (mediaLibrary) {
    return {
      source: 'media-library',
      listPath: mediaLibraryPath(mediaLibrary.libraryId),
      videoId: mediaLibrary.videoId,
      ...(mediaLibrary.actressId == null ? {} : { actressId: mediaLibrary.actressId }),
      libraryId: mediaLibrary.libraryId,
      libraryIdSource: 'path'
    }
  }

  const home = parseHomeVideoPath(pathname)
  if (home) return queryOwnedContext('home', ROUTE_PATH.home, home, params)

  const search = parseSearchVideoPath(pathname)
  if (search) return queryOwnedContext('search', ROUTE_PATH.search, search, params)

  const legacy = parseLibraryVideoPath(pathname)
  if (legacy) return queryOwnedContext('legacy-library', ROUTE_PATH.home, legacy, params)

  return null
}
