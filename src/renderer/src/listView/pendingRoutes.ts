import { generatePath, matchPath } from 'react-router-dom'
import { LIST_PARAM } from './listQueryParams'
import { ROUTE_PATH } from './routePaths'

export type PendingTab = 'scan' | 'scrape'

export function parsePendingCenterSearch(params: URLSearchParams): {
  tab: PendingTab
  itemId: number | null
  videoId: number | null
} {
  const itemId = Number(params.get(LIST_PARAM.pendingItemId))
  const videoId = Number(params.get(LIST_PARAM.pendingVideoId))
  return {
    tab: params.get(LIST_PARAM.pendingTab) === 'scrape' ? 'scrape' : 'scan',
    itemId: Number.isInteger(itemId) && itemId > 0 ? itemId : null,
    videoId: Number.isInteger(videoId) && videoId > 0 ? videoId : null
  }
}

export function pendingCenterPath(options: {
  tab?: PendingTab
  id?: number
  videoId?: number
} = {}): string {
  const params = new URLSearchParams()
  if (options.tab) params.set(LIST_PARAM.pendingTab, options.tab)
  if (options.id != null) params.set(LIST_PARAM.pendingItemId, String(options.id))
  if (options.videoId != null) params.set(LIST_PARAM.pendingVideoId, String(options.videoId))
  const query = params.toString()
  return query ? `${ROUTE_PATH.pending}?${query}` : ROUTE_PATH.pending
}

export function pendingVideoDetailPath(videoId: number): string {
  return generatePath(ROUTE_PATH.pendingVideoStack, { videoId: String(videoId) })
}

export function pendingVideoActressPath(videoId: number, actressId: number): string {
  return `${pendingVideoDetailPath(videoId)}/actress/${actressId}`
}

export function parsePendingVideoPath(pathname: string): {
  videoId: number
  actressId?: number
} | null {
  const stacked = matchPath({ path: ROUTE_PATH.pendingActressStack, end: true }, pathname)
  const detail = stacked ?? matchPath({ path: ROUTE_PATH.pendingVideoStack, end: true }, pathname)
  if (!detail) return null
  const params = detail.params as Record<string, string | undefined>
  const videoId = Number(params.videoId)
  if (!Number.isInteger(videoId) || videoId <= 0) return null
  const actressId = params.actressId == null ? undefined : Number(params.actressId)
  if (actressId != null && (!Number.isInteger(actressId) || actressId <= 0)) return null
  return { videoId, actressId }
}
