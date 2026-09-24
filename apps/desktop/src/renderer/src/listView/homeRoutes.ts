import { generatePath, matchPath } from 'react-router-dom'
import { formatPositiveRouteId, parsePositiveRouteId } from './routeIds'
import { ROUTE_PATH } from './routePaths'

export interface HomeVideoRoute {
  videoId: number
  actressId?: number
}

export function homeVideoDetailPath(videoId: number): string {
  return generatePath(ROUTE_PATH.homeVideoStack, {
    videoId: formatPositiveRouteId(videoId, 'videoId')
  })
}

export function homeVideoActressPath(videoId: number, actressId: number): string {
  return generatePath(ROUTE_PATH.homeActressStack, {
    videoId: formatPositiveRouteId(videoId, 'videoId'),
    actressId: formatPositiveRouteId(actressId, 'actressId')
  })
}

export function parseHomeVideoPath(pathname: string): HomeVideoRoute | null {
  const match =
    matchPath({ path: ROUTE_PATH.homeActressStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.homeVideoStack, end: true }, pathname)
  if (!match) return null
  const params = match.params as Record<string, string | undefined>

  const videoId = parsePositiveRouteId(params.videoId)
  if (videoId == null) return null
  const actressId = params.actressId ? parsePositiveRouteId(params.actressId) : undefined
  if (params.actressId != null && actressId == null) return null

  return actressId == null ? { videoId } : { videoId, actressId }
}
