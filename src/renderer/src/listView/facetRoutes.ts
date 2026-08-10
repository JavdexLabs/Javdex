import type { OrganizationRole } from '@shared/classificationTypes'
import { generatePath, matchPath } from 'react-router-dom'
import { ROUTE_PATH } from './routePaths'

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

export function organizationDetailPath(role: OrganizationRole, organizationId: number): string {
  return generatePath(ROUTE_PATH.organizationDetail, {
    type: role,
    organizationId: String(organizationId)
  })
}

export function organizationVideoDetailPath(
  role: OrganizationRole,
  organizationId: number,
  videoId: number
): string {
  return `${organizationDetailPath(role, organizationId)}/${videoId}`
}

export function directorDetailPath(directorId: number): string {
  return generatePath(ROUTE_PATH.directorDetail, { directorId: String(directorId) })
}

export function directorVideoDetailPath(directorId: number, videoId: number): string {
  return `${directorDetailPath(directorId)}/${videoId}`
}

export function seriesDetailPath(seriesId: number): string {
  return generatePath(ROUTE_PATH.seriesDetail, { seriesId: String(seriesId) })
}

export function seriesVideoDetailPath(seriesId: number, videoId: number): string {
  return `${seriesDetailPath(seriesId)}/${videoId}`
}

export function parseSeriesPath(pathname: string): {
  seriesId: number
  videoId?: number
  actressId?: number
} | null {
  const match =
    matchPath({ path: ROUTE_PATH.seriesActressStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.seriesVideoStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.seriesDetail, end: true }, pathname)
  if (!match) return null
  const params = match.params as Record<string, string | undefined>
  const seriesId = Number(params.seriesId)
  const videoId = params.id ? Number(params.id) : undefined
  const actressId = params.actressId ? Number(params.actressId) : undefined
  if (!Number.isInteger(seriesId) || seriesId <= 0) return null
  if (videoId !== undefined && (!Number.isInteger(videoId) || videoId <= 0)) return null
  if (actressId !== undefined && (!Number.isInteger(actressId) || actressId <= 0)) return null
  return { seriesId, videoId, actressId }
}

export function parseDirectorPath(pathname: string): {
  directorId: number
  videoId?: number
  actressId?: number
} | null {
  const match =
    matchPath({ path: ROUTE_PATH.directorActressStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.directorVideoStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.directorDetail, end: true }, pathname)
  if (!match) return null
  const params = match.params as Record<string, string | undefined>
  const directorId = Number(params.directorId)
  const videoId = params.id ? Number(params.id) : undefined
  const actressId = params.actressId ? Number(params.actressId) : undefined
  if (!Number.isInteger(directorId) || directorId <= 0) return null
  if (videoId !== undefined && (!Number.isInteger(videoId) || videoId <= 0)) return null
  if (actressId !== undefined && (!Number.isInteger(actressId) || actressId <= 0)) return null
  return { directorId, videoId, actressId }
}

export function parseOrganizationPath(pathname: string): {
  role: OrganizationRole
  organizationId: number
  videoId?: number
  actressId?: number
} | null {
  const match =
    matchPath({ path: ROUTE_PATH.organizationActressStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.organizationVideoStack, end: true }, pathname) ??
    matchPath({ path: ROUTE_PATH.organizationDetail, end: true }, pathname)
  if (!match) return null
  const params = match.params as Record<string, string | undefined>
  if (params.type !== 'maker' && params.type !== 'publisher') return null
  const organizationId = Number(params.organizationId)
  const videoId = params.id ? Number(params.id) : undefined
  const actressId = params.actressId ? Number(params.actressId) : undefined
  if (!Number.isInteger(organizationId) || organizationId <= 0) return null
  if (videoId !== undefined && (!Number.isInteger(videoId) || videoId <= 0)) return null
  if (actressId !== undefined && (!Number.isInteger(actressId) || actressId <= 0)) return null
  return { role: params.type, organizationId, videoId, actressId }
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
