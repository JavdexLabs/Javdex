import { generatePath, matchPath } from 'react-router-dom'
import { LIST_PARAM } from './listQueryParams'
import { ROUTE_PATH } from './routePaths'

/** Decision domains sharing the pending inbox; order drives rail section order. */
export const PENDING_DOMAINS = ['scan', 'scrape', 'actress'] as const

export type PendingDomain = (typeof PENDING_DOMAINS)[number]

/** `all` keeps every domain in one queue and is never written to the URL. */
export type PendingTypeFilter = PendingDomain | 'all'

/**
 * Queue items are only unique per domain: scan groups and scrape snapshots use
 * numeric ids while actress conflicts are keyed by normalized name.
 */
export interface PendingItemKey {
  domain: PendingDomain
  id: string
}

function isPendingDomain(raw: string | null): raw is PendingDomain {
  return PENDING_DOMAINS.includes(raw as PendingDomain)
}

export function pendingItemKey(domain: PendingDomain, id: string | number): PendingItemKey {
  return { domain, id: String(id) }
}

export function formatPendingItemKey(key: PendingItemKey): string {
  return `${key.domain}:${key.id}`
}

export function parsePendingItemKey(raw: string | null): PendingItemKey | null {
  if (!raw) return null
  const separator = raw.indexOf(':')
  if (separator <= 0) return null
  const domain = raw.slice(0, separator)
  const id = raw.slice(separator + 1)
  if (!id || !isPendingDomain(domain)) return null
  return { domain, id }
}

export function samePendingItemKey(
  left: PendingItemKey | null,
  right: PendingItemKey | null
): boolean {
  if (!left || !right) return left === right
  return left.domain === right.domain && left.id === right.id
}

export function parsePendingCenterSearch(params: URLSearchParams): {
  type: PendingTypeFilter
  item: PendingItemKey | null
  videoId: number | null
  libraryId: number | null
} {
  const rawType = params.get(LIST_PARAM.pendingType)
  const videoId = Number(params.get(LIST_PARAM.pendingVideoId))
  const libraryId = Number(params.get(LIST_PARAM.pendingLibraryId))
  return {
    type: isPendingDomain(rawType) ? rawType : 'all',
    item: parsePendingItemKey(params.get(LIST_PARAM.pendingItem)),
    videoId: Number.isInteger(videoId) && videoId > 0 ? videoId : null,
    libraryId: Number.isSafeInteger(libraryId) && libraryId > 0 ? libraryId : null
  }
}

export function pendingCenterPath(
  options: {
    type?: PendingTypeFilter
    item?: PendingItemKey | null
    videoId?: number
    libraryId?: number
  } = {}
): string {
  const params = new URLSearchParams()
  if (options.type && options.type !== 'all') params.set(LIST_PARAM.pendingType, options.type)
  if (options.item) params.set(LIST_PARAM.pendingItem, formatPendingItemKey(options.item))
  if (options.videoId != null) params.set(LIST_PARAM.pendingVideoId, String(options.videoId))
  if (options.libraryId != null) {
    params.set(LIST_PARAM.pendingLibraryId, String(options.libraryId))
  }
  const query = params.toString()
  return query ? `${ROUTE_PATH.pending}?${query}` : ROUTE_PATH.pending
}

export function pendingVideoDetailPath(videoId: number): string {
  return generatePath(ROUTE_PATH.pendingVideoStack, { videoId: String(videoId) })
}

export function pendingVideoActressPath(videoId: number, actressId: number): string {
  return `${pendingVideoDetailPath(videoId)}/actress/${actressId}`
}

export function pendingActressDetailPath(actressId: number): string {
  return generatePath(ROUTE_PATH.pendingActressDetail, { actressId: String(actressId) })
}

export function parsePendingActressDetailPath(pathname: string): { actressId: number } | null {
  const match = matchPath({ path: ROUTE_PATH.pendingActressDetail, end: true }, pathname)
  if (!match) return null
  const actressId = Number(match.params.actressId)
  if (!Number.isInteger(actressId) || actressId <= 0) return null
  return { actressId }
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
