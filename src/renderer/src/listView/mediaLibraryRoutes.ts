import { generatePath, matchPath } from 'react-router-dom'
import { formatPositiveRouteId, parsePositiveRouteId } from './routeIds'
import { ROUTE_PATH } from './routePaths'

export const MEDIA_LIBRARY_SETTINGS_TABS = [
  'general',
  'sources',
  'scan',
  'scraping',
  'display',
  'danger'
] as const

export type MediaLibrarySettingsTab = (typeof MEDIA_LIBRARY_SETTINGS_TABS)[number]

export type MediaLibraryRoute =
  | { kind: 'list'; libraryId: number }
  | { kind: 'video'; libraryId: number; videoId: number; actressId?: number }
  | { kind: 'settings'; libraryId: number; tab: MediaLibrarySettingsTab }

function isMediaLibrarySettingsTab(raw: string | undefined): raw is MediaLibrarySettingsTab {
  return MEDIA_LIBRARY_SETTINGS_TABS.includes(raw as MediaLibrarySettingsTab)
}

export function mediaLibraryPath(libraryId: number): string {
  return generatePath(ROUTE_PATH.mediaLibrary, {
    libraryId: formatPositiveRouteId(libraryId, 'libraryId')
  })
}

export function mediaLibraryVideoDetailPath(libraryId: number, videoId: number): string {
  return generatePath(ROUTE_PATH.mediaLibraryVideoStack, {
    libraryId: formatPositiveRouteId(libraryId, 'libraryId'),
    videoId: formatPositiveRouteId(videoId, 'videoId')
  })
}

export function mediaLibraryVideoActressPath(
  libraryId: number,
  videoId: number,
  actressId: number
): string {
  return generatePath(ROUTE_PATH.mediaLibraryActressStack, {
    libraryId: formatPositiveRouteId(libraryId, 'libraryId'),
    videoId: formatPositiveRouteId(videoId, 'videoId'),
    actressId: formatPositiveRouteId(actressId, 'actressId')
  })
}

export function mediaLibrarySettingsPath(
  libraryId: number,
  tab: MediaLibrarySettingsTab
): string {
  if (!isMediaLibrarySettingsTab(tab)) {
    throw new RangeError(`不支持的媒体库设置页签：${String(tab)}`)
  }
  return generatePath(ROUTE_PATH.mediaLibrarySettings, {
    libraryId: formatPositiveRouteId(libraryId, 'libraryId'),
    tab
  })
}

export function parseMediaLibraryRoute(pathname: string): MediaLibraryRoute | null {
  const actressMatch = matchPath(
    { path: ROUTE_PATH.mediaLibraryActressStack, end: true },
    pathname
  )
  const videoMatch =
    actressMatch ??
    matchPath({ path: ROUTE_PATH.mediaLibraryVideoStack, end: true }, pathname)
  if (videoMatch) {
    const params = videoMatch.params as Record<string, string | undefined>
    const libraryId = parsePositiveRouteId(params.libraryId)
    const videoId = parsePositiveRouteId(params.videoId)
    if (libraryId == null || videoId == null) return null
    const actressId = params.actressId ? parsePositiveRouteId(params.actressId) : undefined
    if (params.actressId != null && actressId == null) return null
    return actressId == null
      ? { kind: 'video', libraryId, videoId }
      : { kind: 'video', libraryId, videoId, actressId }
  }

  const settingsMatch = matchPath(
    { path: ROUTE_PATH.mediaLibrarySettings, end: true },
    pathname
  )
  if (settingsMatch) {
    const libraryId = parsePositiveRouteId(settingsMatch.params.libraryId)
    if (libraryId == null || !isMediaLibrarySettingsTab(settingsMatch.params.tab)) return null
    return { kind: 'settings', libraryId, tab: settingsMatch.params.tab }
  }

  const listMatch = matchPath({ path: ROUTE_PATH.mediaLibrary, end: true }, pathname)
  if (!listMatch) return null
  const libraryId = parsePositiveRouteId(listMatch.params.libraryId)
  return libraryId == null ? null : { kind: 'list', libraryId }
}

export function parseMediaLibraryVideoPath(pathname: string): {
  libraryId: number
  videoId: number
  actressId?: number
} | null {
  const route = parseMediaLibraryRoute(pathname)
  if (route?.kind !== 'video') return null
  const { libraryId, videoId, actressId } = route
  return actressId == null ? { libraryId, videoId } : { libraryId, videoId, actressId }
}

export function parseMediaLibrarySettingsPath(pathname: string): {
  libraryId: number
  tab: MediaLibrarySettingsTab
} | null {
  const route = parseMediaLibraryRoute(pathname)
  return route?.kind === 'settings' ? { libraryId: route.libraryId, tab: route.tab } : null
}
