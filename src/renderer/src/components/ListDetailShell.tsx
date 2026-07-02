import { Outlet, useMatch } from 'react-router-dom'
import { type ReactNode } from 'react'

interface ListDetailShellProps {
  list: ReactNode
  detailMatchPath: string
  /** When false, matches nested paths (e.g. facet detail + video id). Default true. */
  detailMatchEnd?: boolean
}

/** Keeps the list view mounted (scroll + filter state) while a detail route is open. */
export default function ListDetailShell({
  list,
  detailMatchPath,
  detailMatchEnd = true
}: ListDetailShellProps): JSX.Element {
  const detailMatch = useMatch({ path: detailMatchPath, end: detailMatchEnd })
  const detailOpen = Boolean(detailMatch)

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
