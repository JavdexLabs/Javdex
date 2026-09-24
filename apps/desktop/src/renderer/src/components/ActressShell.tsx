import ListDetailShell from './ListDetailShell'
import { ROUTE_MATCH } from '../listView/routePaths'
import ActressesPage from '../pages/ActressesPage'

const ACTRESS_LIST = <ActressesPage />

export default function ActressShell(): JSX.Element {
  return (
    <ListDetailShell
      list={ACTRESS_LIST}
      detailMatchPath={ROUTE_MATCH.actressDetailOpen}
      detailMatchEnd={false}
    />
  )
}
