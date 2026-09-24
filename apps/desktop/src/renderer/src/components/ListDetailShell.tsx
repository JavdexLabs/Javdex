import { matchPath, Outlet, useLocation } from 'react-router-dom'
import { type ReactNode } from 'react'

interface ListDetailShellProps {
  list: ReactNode
  detailMatchPath: string | readonly string[]
  /** When false, matches nested paths (e.g. facet detail + video id). Default true. */
  detailMatchEnd?: boolean
}

/** Keeps the list view mounted (scroll + filter state) while a detail route is open. */
export default function ListDetailShell({
  list,
  detailMatchPath,
  detailMatchEnd = true
}: ListDetailShellProps): JSX.Element {
  const location = useLocation()
  const detailMatchPaths =
    typeof detailMatchPath === 'string' ? [detailMatchPath] : detailMatchPath
  const detailOpen = detailMatchPaths.some((path) =>
    Boolean(matchPath({ path, end: detailMatchEnd }, location.pathname))
  )

  return (
    <div className={`list-detail-shell${detailOpen ? ' list-detail-shell--detail' : ''}`}>
      <div className="list-detail-shell-main">{list}</div>
      {detailOpen && (
        <div className="list-detail-shell-detail">
          <Outlet />
        </div>
      )}
    </div>
  )
}
