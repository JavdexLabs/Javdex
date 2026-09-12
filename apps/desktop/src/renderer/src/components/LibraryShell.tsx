import { Navigate, useParams } from 'react-router-dom'
import ListDetailShell from './ListDetailShell'
import { ROUTE_MATCH, ROUTE_PATH } from '../listView/routePaths'
import LibraryPage from '../pages/LibraryPage'
import { parsePositiveRouteId } from '../listView/routeIds'

/** Keeps one parameterized library mounted while viewing its video detail stack. */
export default function LibraryShell(): JSX.Element {
  const { libraryId: rawLibraryId } = useParams()
  const libraryId = parsePositiveRouteId(rawLibraryId)
  if (libraryId == null) return <Navigate to={ROUTE_PATH.home} replace />

  return (
    <ListDetailShell
      list={<LibraryPage key={libraryId} libraryId={libraryId} />}
      detailMatchPath={[
        ROUTE_MATCH.mediaLibraryVideoOpen,
        ROUTE_MATCH.mediaLibrarySettings
      ]}
      detailMatchEnd={false}
    />
  )
}
