import type { NavigateFunction, Location } from 'react-router-dom'
import { matchPath } from 'react-router-dom'
import {
  actressDetailPath,
  actressVideoActressPath,
  actressVideoDetailPath,
  parseActressVideoPath
} from './actressRoutes'
import {
  facetListPath,
  directorDetailPath,
  directorVideoDetailPath,
  organizationDetailPath,
  organizationVideoDetailPath,
  parseOrganizationPath,
  parseDirectorPath,
  parseSeriesPath,
  seriesDetailPath,
  seriesVideoDetailPath
} from './facetRoutes'
import type { OrganizationRole } from '@shared/classificationTypes'
import {
  libraryVideoActressPath,
  libraryVideoDetailPath,
  parseLibraryVideoPath
} from './libraryRoutes'
import {
  parsePendingActressDetailPath,
  parsePendingVideoPath,
  pendingActressDetailPath,
  pendingVideoActressPath,
  pendingVideoDetailPath
} from './pendingRoutes'
import {
  parsePlaylistVideoPath,
  playlistDetailPath,
  playlistVideoDetailPath
} from './playlistRoutes'
import { patchSearchParams } from './listQueryParams'
import { ROUTE_PATH } from './routePaths'

/** Open video detail; nested under facet list when already in that flow. */
export function navigateToVideoDetail(
  navigate: NavigateFunction,
  location: Location,
  videoId: number,
  options?: { replace?: boolean }
): void {
  const pending = parsePendingVideoPath(location.pathname)
  if (pending || location.pathname === ROUTE_PATH.pending) {
    navigate(
      {
        pathname: pendingVideoDetailPath(videoId),
        search: location.search
      },
      { replace: options?.replace }
    )
    return
  }
  const series = parseSeriesPath(location.pathname)
  if (series) {
    navigate(
      {
        pathname: seriesVideoDetailPath(series.seriesId, videoId),
        search: location.search
      },
      { replace: options?.replace }
    )
    return
  }
  const director = parseDirectorPath(location.pathname)
  if (director) {
    navigate(
      {
        pathname: directorVideoDetailPath(director.directorId, videoId),
        search: location.search
      },
      { replace: options?.replace }
    )
    return
  }
  const organization = parseOrganizationPath(location.pathname)
  if (organization) {
    navigate(
      {
        pathname: organizationVideoDetailPath(
          organization.role,
          organization.organizationId,
          videoId
        ),
        search: location.search
      },
      { replace: options?.replace }
    )
    return
  }
  const playlist = parsePlaylistVideoPath(location.pathname)
  if (playlist) {
    navigate(
      {
        pathname: playlistVideoDetailPath(playlist.playlistId, videoId),
        search: location.search
      },
      { replace: options?.replace }
    )
    return
  }
  const actress = parseActressVideoPath(location.pathname)
  if (actress && actress.stackedActressId == null) {
    navigate(
      {
        pathname: actressVideoDetailPath(actress.actressId, videoId),
        search: location.search
      },
      { replace: options?.replace }
    )
    return
  }
  navigate(
    {
      pathname: libraryVideoDetailPath(videoId),
      search: location.search
    },
    { replace: options?.replace }
  )
}

/** Close video detail and return to the list surface it was opened from. */
export function navigateBackFromVideoDetail(
  navigate: NavigateFunction,
  location: Location,
  patch?: Record<string, string | null | undefined>
): void {
  const returnToSettings = (location.state as { returnToSettings?: unknown } | null)
    ?.returnToSettings
  if (typeof returnToSettings === 'string' && returnToSettings.startsWith('/settings/')) {
    navigate(returnToSettings, {
      state: { libraryFocus: 'scan-audit' },
      preventScrollReset: true
    })
    return
  }
  const pending = parsePendingVideoPath(location.pathname)
  if (pending?.videoId != null) {
    const nextSearch = patch
      ? patchSearchParams(new URLSearchParams(location.search), patch)
      : new URLSearchParams(location.search)
    navigate({
      pathname: ROUTE_PATH.pending,
      search: nextSearch.toString()
    })
    return
  }
  const series = parseSeriesPath(location.pathname)
  if (series?.videoId != null) {
    const nextSearch = patch
      ? patchSearchParams(new URLSearchParams(location.search), patch)
      : new URLSearchParams(location.search)
    navigate({
      pathname: seriesDetailPath(series.seriesId),
      search: nextSearch.toString()
    })
    return
  }
  const director = parseDirectorPath(location.pathname)
  if (director?.videoId != null) {
    const nextSearch = patch
      ? patchSearchParams(new URLSearchParams(location.search), patch)
      : new URLSearchParams(location.search)
    navigate({
      pathname: directorDetailPath(director.directorId),
      search: nextSearch.toString()
    })
    return
  }
  const organization = parseOrganizationPath(location.pathname)
  if (organization?.videoId != null) {
    const nextSearch = patch
      ? patchSearchParams(new URLSearchParams(location.search), patch)
      : new URLSearchParams(location.search)
    navigate({
      pathname: organizationDetailPath(organization.role, organization.organizationId),
      search: nextSearch.toString()
    })
    return
  }
  const playlist = parsePlaylistVideoPath(location.pathname)
  if (playlist?.videoId != null) {
    const nextSearch = patch
      ? patchSearchParams(new URLSearchParams(location.search), patch)
      : new URLSearchParams(location.search)
    navigate({
      pathname: playlistDetailPath(playlist.playlistId),
      search: nextSearch.toString()
    })
    return
  }
  const actress = parseActressVideoPath(location.pathname)
  if (actress?.videoId != null) {
    const nextSearch = patch
      ? patchSearchParams(new URLSearchParams(location.search), patch)
      : new URLSearchParams(location.search)
    navigate({
      pathname: actressDetailPath(actress.actressId),
      search: nextSearch.toString()
    })
    return
  }
  navigateToLibrary(navigate, location, patch)
}

/** Return to library list (closes detail) preserving or replacing search params. */
export function navigateToLibrary(
  navigate: NavigateFunction,
  location: Location,
  patch?: Record<string, string | null | undefined>,
  options?: { replace?: boolean; tagLabel?: { id: number; name: string } }
): void {
  const nextSearch = patch
    ? patchSearchParams(new URLSearchParams(location.search), patch)
    : new URLSearchParams(location.search)
  const prevState = (location.state ?? {}) as Record<string, unknown>
  const nextState =
    options?.tagLabel != null
      ? {
          ...prevState,
          tagLabels: {
            ...((prevState.tagLabels as Record<number, string> | undefined) ?? {}),
            [options.tagLabel.id]: options.tagLabel.name
          }
        }
      : location.state
  navigate(
    {
      pathname: '/',
      search: nextSearch.toString()
    },
    { replace: options?.replace ?? false, preventScrollReset: true, state: nextState }
  )
}

/** Actress detail nested under video detail (stays in current list route tree). */
export function navigateToActressFromVideoDetail(
  navigate: NavigateFunction,
  location: Location,
  videoId: number,
  actressId: number
): void {
  const pending = parsePendingVideoPath(location.pathname)
  if (pending?.videoId != null) {
    navigate({
      pathname: pendingVideoActressPath(videoId, actressId),
      search: location.search
    })
    return
  }
  const series = parseSeriesPath(location.pathname)
  if (series?.videoId != null) {
    navigate({
      pathname: `${seriesVideoDetailPath(series.seriesId, videoId)}/actress/${actressId}`,
      search: location.search
    })
    return
  }
  const director = parseDirectorPath(location.pathname)
  if (director?.videoId != null) {
    navigate({
      pathname: `${directorVideoDetailPath(director.directorId, videoId)}/actress/${actressId}`,
      search: location.search
    })
    return
  }
  const organization = parseOrganizationPath(location.pathname)
  if (organization?.videoId != null) {
    navigate({
      pathname: `${organizationVideoDetailPath(
        organization.role,
        organization.organizationId,
        videoId
      )}/actress/${actressId}`,
      search: location.search
    })
    return
  }
  const playlist = parsePlaylistVideoPath(location.pathname)
  if (playlist?.videoId != null) {
    navigate({
      pathname: `${playlistVideoDetailPath(playlist.playlistId, videoId)}/actress/${actressId}`,
      search: location.search
    })
    return
  }
  const actress = parseActressVideoPath(location.pathname)
  if (actress?.videoId != null) {
    navigate({
      pathname: actressVideoActressPath(actress.actressId, videoId, actressId),
      search: location.search
    })
    return
  }
  navigate({
    pathname: libraryVideoActressPath(videoId, actressId),
    search: location.search
  })
}

/** Close an actress detail nested under video detail and restore its parent video. */
export function navigateBackFromActressDetail(
  navigate: NavigateFunction,
  location: Location
): void {
  const pending = parsePendingVideoPath(location.pathname)
  if (pending?.videoId != null && pending.actressId != null) {
    navigate({
      pathname: pendingVideoDetailPath(pending.videoId),
      search: location.search
    })
    return
  }
  if (parsePendingActressDetailPath(location.pathname)) {
    navigate({
      pathname: ROUTE_PATH.pending,
      search: location.search
    })
    return
  }
  const series = parseSeriesPath(location.pathname)
  if (series?.videoId != null && series.actressId != null) {
    navigate({
      pathname: seriesVideoDetailPath(series.seriesId, series.videoId),
      search: location.search
    })
    return
  }
  const director = parseDirectorPath(location.pathname)
  if (director?.videoId != null && director.actressId != null) {
    navigate({
      pathname: directorVideoDetailPath(director.directorId, director.videoId),
      search: location.search
    })
    return
  }
  const organization = parseOrganizationPath(location.pathname)
  if (organization?.videoId != null && organization.actressId != null) {
    navigate({
      pathname: organizationVideoDetailPath(
        organization.role,
        organization.organizationId,
        organization.videoId
      ),
      search: location.search
    })
    return
  }
  const playlist = parsePlaylistVideoPath(location.pathname)
  if (playlist?.videoId != null && playlist.actressId != null) {
    navigate({
      pathname: playlistVideoDetailPath(playlist.playlistId, playlist.videoId),
      search: location.search
    })
    return
  }
  const actress = parseActressVideoPath(location.pathname)
  if (actress?.videoId != null && actress.stackedActressId != null) {
    navigate({
      pathname: actressVideoDetailPath(actress.actressId, actress.videoId),
      search: location.search
    })
    return
  }
  const library = parseLibraryVideoPath(location.pathname)
  if (library?.actressId != null) {
    navigate({ pathname: libraryVideoDetailPath(library.videoId), search: location.search })
    return
  }
  navigateToActressList(navigate, location)
}

/** Actress detail from the current list context. */
export function navigateToActressDetail(
  navigate: NavigateFunction,
  location: Location,
  actressId: number
): void {
  const pendingVideo = parsePendingVideoPath(location.pathname)
  if (pendingVideo?.videoId != null) {
    navigate({
      pathname: pendingVideoActressPath(pendingVideo.videoId, actressId),
      search: location.search
    })
    return
  }
  if (
    location.pathname === ROUTE_PATH.pending ||
    parsePendingActressDetailPath(location.pathname)
  ) {
    navigate({
      pathname: pendingActressDetailPath(actressId),
      search: location.search
    })
    return
  }
  navigate({
    pathname: actressDetailPath(actressId),
    search: location.search
  })
}

export function navigateToActressList(
  navigate: NavigateFunction,
  location: Location,
  patch?: Record<string, string | null | undefined>
): void {
  const nextSearch = patch
    ? patchSearchParams(new URLSearchParams(location.search), patch)
    : new URLSearchParams(location.search)
  navigate({
    pathname: ROUTE_PATH.actresses,
    search: nextSearch.toString()
  })
}

export function navigateToOrganizationDetail(
  navigate: NavigateFunction,
  location: Location,
  role: OrganizationRole,
  organizationId: number
): void {
  const facetList = matchPath({ path: ROUTE_PATH.facetList, end: true }, location.pathname)
  const fromRoleList = facetList?.params.type === role
  const fromRoleStack = parseOrganizationPath(location.pathname)?.role === role
  navigate({
    pathname: organizationDetailPath(role, organizationId),
    search: fromRoleList || fromRoleStack ? location.search : ''
  })
}

export function navigateToDirectorDetail(
  navigate: NavigateFunction,
  location: Location,
  directorId: number
): void {
  const facetList = matchPath({ path: ROUTE_PATH.facetList, end: true }, location.pathname)
  const fromDirectorList = facetList?.params.type === 'director'
  const fromDirectorStack = parseDirectorPath(location.pathname) != null
  navigate({
    pathname: directorDetailPath(directorId),
    search: fromDirectorList || fromDirectorStack ? location.search : ''
  })
}

export function navigateToSeriesDetail(
  navigate: NavigateFunction,
  location: Location,
  seriesId: number
): void {
  const facetList = matchPath({ path: ROUTE_PATH.facetList, end: true }, location.pathname)
  const fromSeriesList = facetList?.params.type === 'series'
  const fromSeriesStack = parseSeriesPath(location.pathname) != null
  navigate({
    pathname: seriesDetailPath(seriesId),
    search: fromSeriesList || fromSeriesStack ? location.search : ''
  })
}

export function navigateToFacetList(
  navigate: NavigateFunction,
  location: Location,
  facetType: string,
  patch?: Record<string, string | null | undefined>
): void {
  const nextSearch = patch
    ? patchSearchParams(new URLSearchParams(location.search), patch)
    : new URLSearchParams(location.search)
  navigate({
    pathname: facetListPath(facetType),
    search: nextSearch.toString()
  })
}

export function navigateToPlaylistDetail(
  navigate: NavigateFunction,
  location: Location,
  playlistId: number
): void {
  navigate({
    pathname: playlistDetailPath(playlistId),
    search: location.search
  })
}

export function navigateToPlaylistList(
  navigate: NavigateFunction,
  location: Location
): void {
  navigate({
    pathname: ROUTE_PATH.playlists,
    search: location.search
  })
}
