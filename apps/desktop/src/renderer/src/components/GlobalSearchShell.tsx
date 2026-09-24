import GlobalSearchPage from '../pages/GlobalSearchPage'
import { ROUTE_MATCH } from '../listView/routePaths'
import ListDetailShell from './ListDetailShell'

/** Stable result surface; query cache and scroll survive its detail stack. */
const SEARCH_LIST = <GlobalSearchPage />

export default function GlobalSearchShell(): JSX.Element {
  return (
    <ListDetailShell
      list={SEARCH_LIST}
      detailMatchPath={ROUTE_MATCH.searchVideoOpen}
      detailMatchEnd={false}
    />
  )
}
