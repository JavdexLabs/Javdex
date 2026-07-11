import { generatePath, matchPath } from 'react-router-dom'
import { ROUTE_PATH } from './routePaths'

export function actressDetailPath(actressId: number): string {
  return generatePath(ROUTE_PATH.actressDetail, { id: String(actressId) })
}

export function actressVideoDetailPath(actressId: number, videoId: number): string {
  return generatePath(ROUTE_PATH.actressVideoStack, {
    id: String(actressId),
    videoId: String(videoId)
  })
}

export function actressVideoActressPath(
  actressId: number,
  videoId: number,
  stackedActressId: number
): string {
  return generatePath(ROUTE_PATH.actressActressStack, {
    id: String(actressId),
    videoId: String(videoId),
    actressId: String(stackedActressId)
  })
}

export function parseActressVideoPath(pathname: string): {
  actressId: number
  videoId?: number
  stackedActressId?: number
} | null {
  const match =
    matchPath({ path: ROUTE_PATH.actressActressStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.actressVideoStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.actressDetail, end: true }, pathname)
  if (!match) return null
  const params = match.params as Record<string, string | undefined>

  const actressId = Number(params.id)
  if (Number.isNaN(actressId)) return null

  const videoId = params.videoId ? Number(params.videoId) : undefined
  if (videoId != null && Number.isNaN(videoId)) return null

  const stackedActressId = params.actressId ? Number(params.actressId) : undefined
  if (stackedActressId != null && Number.isNaN(stackedActressId)) return null

  return { actressId, videoId, stackedActressId }
}
