import ListDetailShell from './ListDetailShell'
import { ROUTE_MATCH } from '../listView/routePaths'
import PendingCenterPage from '../pages/PendingCenterPage'

const PENDING_CENTER_LIST = <PendingCenterPage />

/** Preserve the pending workbench while inspecting one candidate's video detail. */
export default function PendingCenterShell(): JSX.Element {
  return (
    <ListDetailShell
      list={PENDING_CENTER_LIST}
      detailMatchPath={ROUTE_MATCH.pendingVideoStack}
      detailMatchEnd={false}
    />
  )
}
