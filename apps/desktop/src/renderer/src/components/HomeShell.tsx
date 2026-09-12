import HomePage from '../pages/HomePage'
import { ROUTE_MATCH } from '../listView/routePaths'
import ListDetailShell from './ListDetailShell'

/** Stable home surface; its discovery batch and scroll survive detail navigation. */
const HOME_LIST = <HomePage />

export default function HomeShell(): JSX.Element {
  return (
    <ListDetailShell
      list={HOME_LIST}
      detailMatchPath={ROUTE_MATCH.homeVideoOpen}
      detailMatchEnd={false}
    />
  )
}
