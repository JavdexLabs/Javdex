import type { NavigateFunction, Location } from 'react-router-dom'
import {
  actressDetailPath,
  actressVideoActressPath,
  actressVideoDetailPath,
  parseActressVideoPath
} from './actressRoutes'
import { facetListPath, facetVideoDetailPath, facetVideoListPath, parseFacetVideoPath } from './facetRoutes'
import { libraryVideoActressPath, libraryVideoDetailPath } from './libraryRoutes'
import {
  parsePlaylistVideoPath,
  playlistDetailPath,
  playlistVideoDetailPath
} from './playlistRoutes'
import { patchSearchParams } from './listQueryParams'

/** Open video detail; nested under facet list when already in that flow. */
export function navigateToVideoDetail(
  navigate: NavigateFunction,
  location: Location,
  videoId: number,
  options?: { replace?: boolean }
): void {
  const facet = parseFacetVideoPath(location.pathname)
  if (facet) {
    const value = decodeURIComponent(facet.valueKey)
    navigate(
      {
        pathname: facetVideoDetailPath(facet.facetType, value, videoId),
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
  const facet = parseFacetVideoPath(location.pathname)
  if (facet?.videoId != null) {
    const nextSearch = patch
      ? patchSearchParams(new URLSearchParams(location.search), patch)
      : new URLSearchParams(location.search)
    navigate({
      pathname: facetVideoListPath(
        facet.facetType,
        decodeURIComponent(facet.valueKey)
      ),
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
  const facet = parseFacetVideoPath(location.pathname)
  if (facet?.videoId != null) {
    const value = decodeURIComponent(facet.valueKey)
    navigate({
      pathname: `${facetVideoDetailPath(facet.facetType, value, videoId)}/actress/${actressId}`,
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

/** Actress detail from the actress list (separate route tree). */
export function navigateToActressDetail(
  navigate: NavigateFunction,
  location: Location,
  actressId: number
): void {
  navigate({
    pathname: `/actresses/${actressId}`,
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
    pathname: '/actresses',
    search: nextSearch.toString()
  })
}

/** Facet video list for one maker/publisher/series/director. */
export function navigateToFacetDetail(
  navigate: NavigateFunction,
  facetType: string,
  value: string
): void {
  navigate(facetVideoListPath(facetType, value))
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
    pathname: `/playlists/${playlistId}`,
    search: location.search
  })
}

export function navigateToPlaylistList(
  navigate: NavigateFunction,
  location: Location
): void {
  navigate({
    pathname: '/playlists',
    search: location.search
  })
}
