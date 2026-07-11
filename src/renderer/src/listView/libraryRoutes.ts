import { generatePath, matchPath } from 'react-router-dom'
import { ROUTE_PATH } from './routePaths'

export function libraryVideoDetailPath(videoId: number): string {
  return generatePath(ROUTE_PATH.libraryDetail, { id: String(videoId) })
}

export function libraryVideoActressPath(videoId: number, actressId: number): string {
  return `${libraryVideoDetailPath(videoId)}/actress/${actressId}`
}

export function parseLibraryVideoPath(pathname: string): {
  videoId: number
  actressId?: number
} | null {
  const stacked = matchPath({ path: ROUTE_PATH.libraryActressStack, end: true }, pathname)
  const detail = stacked ?? matchPath({ path: ROUTE_PATH.libraryDetail, end: true }, pathname)
  if (!detail) return null
  const params = detail.params as Record<string, string | undefined>

  const videoId = Number(params.id)
  if (Number.isNaN(videoId)) return null

  const actressId = params.actressId ? Number(params.actressId) : undefined
  if (actressId != null && Number.isNaN(actressId)) return null

  return { videoId, actressId }
}
