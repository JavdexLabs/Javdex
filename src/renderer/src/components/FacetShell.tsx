import ListDetailShell from './ListDetailShell'
import { ROUTE_MATCH } from '../listView/routePaths'
import FacetListPage from '../pages/FacetListPage'

const FACET_LIST = <FacetListPage />

export default function FacetShell(): JSX.Element {
  return (
    <ListDetailShell
      list={FACET_LIST}
      detailMatchPath={ROUTE_MATCH.facetDetailOpen}
      detailMatchEnd={false}
    />
  )
}
