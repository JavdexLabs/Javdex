import { matchPath, Outlet, useLocation } from 'react-router-dom'
import { type ReactNode } from 'react'
import styles from './ListDetailShell.module.css'

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
    <div className={styles.root} data-detail-open={detailOpen || undefined}>
      <div className={styles.main}>{list}</div>
      {detailOpen && (
        <div className={styles.detail} data-list-detail-overlay>
          <Outlet />
        </div>
      )}
    </div>
  )
}
