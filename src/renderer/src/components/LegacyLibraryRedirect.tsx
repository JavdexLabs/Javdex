import { useQuery } from '@tanstack/react-query'
import { Navigate, useLocation } from 'react-router-dom'
import EmptyState from './EmptyState'
import { api } from '../api'
import {
  mediaLibraryPath,
  mediaLibraryVideoActressPath,
  mediaLibraryVideoDetailPath
} from '../listView/mediaLibraryRoutes'
import { parseLibraryVideoPath } from '../listView/libraryRoutes'
import { ROUTE_PATH } from '../listView/routePaths'
import {
  loadLegacyDetailForRedirect,
  parseVideoDetailLibraryId,
  stripVideoDetailSearchParams
} from '../listView/videoDetailContext'
import { mediaLibraryKeys } from '../query/queryKeys'
import { readRecentMediaLibraryId } from '../listView/recentMediaLibrary'

export default function LegacyLibraryRedirect({ detail = false }: { detail?: boolean }): JSX.Element {
  const location = useLocation()
  const legacyRoute = detail ? parseLibraryVideoPath(location.pathname) : null
  const videoId = legacyRoute?.videoId ?? null
  const actressId = legacyRoute?.actressId
  const requestedLibraryId = parseVideoDetailLibraryId(new URLSearchParams(location.search))
  const recentLibraryId = readRecentMediaLibraryId()
  const librariesQuery = useQuery({
    queryKey: mediaLibraryKeys.activeList(),
    queryFn: () => api.mediaLibraries.list(),
    enabled: !detail
  })
  const videoQuery = useQuery({
    queryKey: ['videos', 'legacy-detail', videoId, requestedLibraryId, recentLibraryId],
    queryFn: () =>
      loadLegacyDetailForRedirect(
        videoId as number,
        requestedLibraryId,
        (scope, id) => api.videos.get(scope, id),
        recentLibraryId
      ),
    enabled: detail && videoId != null
  })

  if (detail && videoId == null) {
    return <Navigate to={ROUTE_PATH.home} replace state={location.state} />
  }
  if ((!detail && librariesQuery.isLoading) || (detail && videoQuery.isLoading)) {
    return <EmptyState loading title="正在打开媒体库…" />
  }

  const libraryId = detail
    ? videoQuery.data?.activeLibraryId
    : (librariesQuery.data?.find((library) => library.isDefault) ?? librariesQuery.data?.[0])?.id
  if (libraryId == null) {
    return <Navigate to={ROUTE_PATH.home} replace state={location.state} />
  }

  const search = stripVideoDetailSearchParams(new URLSearchParams(location.search)).toString()
  const pathname = detail
    ? actressId == null
      ? mediaLibraryVideoDetailPath(libraryId, videoId as number)
      : mediaLibraryVideoActressPath(libraryId, videoId as number, actressId)
    : mediaLibraryPath(libraryId)
  return <Navigate to={{ pathname, search }} replace state={location.state} />
}
