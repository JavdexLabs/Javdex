import ListDetailShell from './ListDetailShell'
import { ROUTE_MATCH } from '../listView/routePaths'
import PendingCenterPage from '../pages/PendingCenterPage'
import TaskCenterFrame from '../tasks/TaskCenterFrame'

const PENDING_CENTER_LIST = <TaskCenterFrame tab="pending"><PendingCenterPage embedded /></TaskCenterFrame>

/** Preserve the pending workbench while inspecting a video or actress overlay. */
export default function PendingCenterShell(): JSX.Element {
  return (
    <ListDetailShell
      list={PENDING_CENTER_LIST}
      detailMatchPath={[ROUTE_MATCH.pendingVideoStack, ROUTE_MATCH.pendingActressDetail]}
      detailMatchEnd={false}
    />
  )
}
