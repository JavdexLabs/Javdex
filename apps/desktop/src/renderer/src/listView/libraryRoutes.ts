import { generatePath, matchPath } from 'react-router-dom'
import { ROUTE_PATH } from './routePaths'
import { formatPositiveRouteId, parsePositiveRouteId } from './routeIds'

/** @deprecated Use `mediaLibraryVideoDetailPath(libraryId, videoId)` for new routes. */
export function libraryVideoDetailPath(videoId: number): string {
  return generatePath(ROUTE_PATH.libraryDetail, {
    id: formatPositiveRouteId(videoId, 'videoId')
  })
}

/** @deprecated Use `mediaLibraryVideoActressPath` for new routes. */
export function libraryVideoActressPath(videoId: number, actressId: number): string {
  return `${libraryVideoDetailPath(videoId)}/actress/${formatPositiveRouteId(
    actressId,
    'actressId'
  )}`
}

/** @deprecated Parser for the former single-library detail stack. */
export function parseLibraryVideoPath(pathname: string): {
  videoId: number
  actressId?: number
} | null {
  const stacked = matchPath({ path: ROUTE_PATH.libraryActressStack, end: true }, pathname)
  const detail = stacked ?? matchPath({ path: ROUTE_PATH.libraryDetail, end: true }, pathname)
  if (!detail) return null
  const params = detail.params as Record<string, string | undefined>

  const videoId = parsePositiveRouteId(params.id)
  if (videoId == null) return null

  const actressId = params.actressId
    ? parsePositiveRouteId(params.actressId) ?? undefined
    : undefined
  if (params.actressId != null && actressId == null) return null

  return { videoId, actressId }
}
