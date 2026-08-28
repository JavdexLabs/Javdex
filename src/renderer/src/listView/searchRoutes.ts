import { generatePath, matchPath } from 'react-router-dom'
import { formatPositiveRouteId, parsePositiveRouteId } from './routeIds'
import { ROUTE_PATH } from './routePaths'

export interface SearchVideoRoute {
  videoId: number
  actressId?: number
}

export function searchVideoDetailPath(videoId: number): string {
  return generatePath(ROUTE_PATH.searchVideoStack, {
    videoId: formatPositiveRouteId(videoId, 'videoId')
  })
}

export function searchVideoActressPath(videoId: number, actressId: number): string {
  return generatePath(ROUTE_PATH.searchActressStack, {
    videoId: formatPositiveRouteId(videoId, 'videoId'),
    actressId: formatPositiveRouteId(actressId, 'actressId')
  })
}

export function parseSearchVideoPath(pathname: string): SearchVideoRoute | null {
  const match =
    matchPath({ path: ROUTE_PATH.searchActressStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.searchVideoStack, end: true }, pathname)
  if (!match) return null
  const params = match.params as Record<string, string | undefined>

  const videoId = parsePositiveRouteId(params.videoId)
  if (videoId == null) return null
  const actressId = params.actressId ? parsePositiveRouteId(params.actressId) : undefined
  if (params.actressId != null && actressId == null) return null

  return actressId == null ? { videoId } : { videoId, actressId }
}
