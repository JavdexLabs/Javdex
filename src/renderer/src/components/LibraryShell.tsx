import ListDetailShell from './ListDetailShell'
import { ROUTE_MATCH } from '../listView/routePaths'
import LibraryPage from '../pages/LibraryPage'

/** Stable element so route transitions do not remount the list (scroll + filters). */
const LIBRARY_LIST = <LibraryPage />

/** Keeps the library mounted while viewing a video detail page. */
export default function LibraryShell(): JSX.Element {
  return (
    <ListDetailShell
      list={LIBRARY_LIST}
      detailMatchPath={ROUTE_MATCH.libraryDetailOpen}
      detailMatchEnd={false}
    />
  )
}
