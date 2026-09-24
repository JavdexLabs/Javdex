import { generatePath, matchPath } from 'react-router-dom'
import { ROUTE_PATH } from './routePaths'

export function playlistDetailPath(playlistId: number): string {
  return generatePath(ROUTE_PATH.playlistDetail, { playlistId: String(playlistId) })
}

export function playlistVideoDetailPath(playlistId: number, videoId: number): string {
  return generatePath(ROUTE_PATH.playlistVideoStack, {
    playlistId: String(playlistId),
    id: String(videoId)
  })
}

export function parsePlaylistVideoPath(pathname: string): {
  playlistId: number
  videoId?: number
  actressId?: number
} | null {
  const m =
    matchPath({ path: ROUTE_PATH.playlistActressStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.playlistVideoStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.playlistDetail, end: true }, pathname)
  if (!m) return null
  const params = m.params as Record<string, string | undefined>
  const playlistId = Number(params.playlistId)
  if (Number.isNaN(playlistId)) return null
  const videoId = params.id ? Number(params.id) : undefined
  const actressId = params.actressId ? Number(params.actressId) : undefined
  return {
    playlistId,
    videoId: videoId != null && !Number.isNaN(videoId) ? videoId : undefined,
    actressId: actressId != null && !Number.isNaN(actressId) ? actressId : undefined
  }
}
