import ListDetailShell from './ListDetailShell'
import { ROUTE_MATCH } from '../listView/routePaths'
import PlaylistsPage from '../pages/PlaylistsPage'

const PLAYLIST_LIST = <PlaylistsPage />

export default function PlaylistShell(): JSX.Element {
  return (
    <ListDetailShell
      list={PLAYLIST_LIST}
      detailMatchPath={ROUTE_MATCH.playlistDetailOpen}
      detailMatchEnd={false}
    />
  )
}
