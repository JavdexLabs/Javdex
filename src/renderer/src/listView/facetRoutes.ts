/** Encode a facet label for a URL path segment (HashRouter-safe). */
export function encodeFacetValueKey(value: string): string {
  return encodeURIComponent(value)
}

export function decodeFacetValueKey(valueKey: string | undefined): string {
  if (!valueKey) return ''
  try {
    return decodeURIComponent(valueKey)
  } catch {
    return valueKey
  }
}

export function facetVideoListPath(facetType: string, value: string): string {
  return generatePath(ROUTE_PATH.facetDetail, {
    type: facetType,
    valueKey: encodeFacetValueKey(value)
  })
}

export function facetListPath(facetType: string): string {
  return generatePath(ROUTE_PATH.facetList, { type: facetType })
}

export function facetVideoDetailPath(facetType: string, value: string, videoId: number): string {
  return `${facetVideoListPath(facetType, value)}/${videoId}`
}

export function parseFacetVideoPath(pathname: string): {
  facetType: string
  valueKey: string
  videoId?: number
  actressId?: number
} | null {
  const m =
    matchPath({ path: ROUTE_PATH.facetActressStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.facetVideoStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.facetDetail, end: true }, pathname)
  if (!m) return null
  const params = m.params as Record<string, string | undefined>
  const videoId = params.id ? Number(params.id) : undefined
  const actressId = params.actressId ? Number(params.actressId) : undefined
  return {
    facetType: params.type ?? '',
    valueKey: params.valueKey ?? '',
    videoId: videoId != null && !Number.isNaN(videoId) ? videoId : undefined,
    actressId: actressId != null && !Number.isNaN(actressId) ? actressId : undefined
  }
}
import { generatePath, matchPath } from 'react-router-dom'
import { ROUTE_PATH } from './routePaths'
