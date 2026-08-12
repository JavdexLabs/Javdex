import { ROUTE_PATH } from './routePaths'

export type PendingTab = 'scan' | 'scrape'

export const PENDING_PARAM = {
  tab: 'tab',
  id: 'id',
  videoId: 'videoId'
} as const

export function pendingCenterPath(options: {
  tab?: PendingTab
  id?: number
  videoId?: number
} = {}): string {
  const params = new URLSearchParams()
  if (options.tab) params.set(PENDING_PARAM.tab, options.tab)
  if (options.id != null) params.set(PENDING_PARAM.id, String(options.id))
  if (options.videoId != null) params.set(PENDING_PARAM.videoId, String(options.videoId))
  const query = params.toString()
  return query ? `${ROUTE_PATH.pending}?${query}` : ROUTE_PATH.pending
}
