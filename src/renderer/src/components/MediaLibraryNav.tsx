import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, NavLink } from 'react-router-dom'
import { useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import { api } from '../api'
import { clearListScrollForPrimaryNav } from '../listView/listViewMemory'
import {
  mediaLibraryPath,
  mediaLibrarySettingsPath,
  parseMediaLibraryRoute
} from '../listView/mediaLibraryRoutes'
import {
  primaryListRoot,
  primaryNavLinkTo,
  resolvePrimaryNavTarget
} from '../listView/primaryNavigationMemory'
import { ROUTE_PATH } from '../listView/routePaths'
import { NavIcon } from './NavIcons'
import { usePluginDevLeaveGuard } from './pluginDev/PluginDevLeaveGuard'
import styles from './MediaLibraryNav.module.css'
import IconButton from './IconButton'
import { UI_ICON_SM } from './iconDefaults'
import MediaLibraryCreateModal from './MediaLibraryCreateModal'
import { useToast } from './Toast'
import { mediaLibraryKeys } from '../query/queryKeys'
import { invalidateAllLibraryQueries } from '../query/invalidateLibraryQueries'
import { mediaLibraryIdentityStyle } from './mediaLibraryIdentity'

export default function MediaLibraryNav(): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()
  const { requestLeave } = usePluginDevLeaveGuard()
  const [createOpen, setCreateOpen] = useState(false)
  const activeRoot = primaryListRoot(location.pathname)
  const activeLibrary = parseMediaLibraryRoute(location.pathname)
  const librariesQuery = useQuery({
    queryKey: mediaLibraryKeys.fullList(),
    queryFn: () => api.mediaLibraries.list({ includeArchived: true }),
    staleTime: 10_000
  })
  const activeLibraries = (librariesQuery.data ?? []).filter(
    (library) => library.status === 'active'
  )
  const archivedLibraries = (librariesQuery.data ?? []).filter(
    (library) => library.status === 'archived'
  )

  const handleCreated = (library: { id: number; name: string }, scanAfterCreate: boolean): void => {
    setCreateOpen(false)
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['media-libraries'] }),
      queryClient.invalidateQueries({ queryKey: ['home'] })
    ])
    toast.show(`媒体库“${library.name}”已创建`, 'success')
    const go = (): void => navigate(mediaLibraryPath(library.id))
    if (location.pathname === ROUTE_PATH.settingsPluginDev) requestLeave(go)
    else go()
    if (scanAfterCreate) {
      void api.scan
        .run(library.id)
        .then((result) => {
          toast.show(
            result.cancelled
              ? `媒体库“${library.name}”首次扫描已取消`
              : `媒体库“${library.name}”首次扫描完成：导入 ${result.imported} 部`,
            result.cancelled ? 'info' : 'success'
          )
        })
        .catch((error) => toast.show(String((error as Error).message ?? error), 'error'))
        .finally(() => invalidateAllLibraryQueries(queryClient))
    }
  }

  const handleClick = (event: MouseEvent<HTMLAnchorElement>, to: string): void => {
    event.preventDefault()
    if (to === activeRoot) clearListScrollForPrimaryNav(to)
    const target = resolvePrimaryNavTarget(to, location.pathname, location.search)
    if (target == null) return
    const go = (): void => navigate(target)
    if (location.pathname === ROUTE_PATH.settingsPluginDev) requestLeave(go)
    else go()
  }

  return (
    <>
      <div className={`nav-group${activeLibrary ? ' nav-group--active' : ''}`}>
      <div className={styles.groupHeader}>
        <div className="nav-group-label">媒体库</div>
        <IconButton
          className={styles.addButton}
          size="sm"
          label="新建媒体库"
          icon={<Plus {...UI_ICON_SM} />}
          onClick={() => setCreateOpen(true)}
        />
      </div>
      <div className={styles.list} aria-label="媒体库">
        {librariesQuery.isLoading ? (
          <div className={styles.status} role="status">
            正在读取…
          </div>
        ) : librariesQuery.isError ? (
          <button
            type="button"
            className={styles.retry}
            onClick={() => void librariesQuery.refetch()}
          >
            读取失败，重试
          </button>
        ) : (librariesQuery.data ?? []).length === 0 ? (
          <div className={styles.status}>暂无媒体库</div>
        ) : (
          <>
            {activeLibraries.map((library) => {
              const to = mediaLibraryPath(library.id)
              return (
                <div className="nav-item-row" key={library.id}>
                  <NavLink
                    to={primaryNavLinkTo(to, location.pathname, location.search)}
                    draggable={false}
                    onClick={(event) => handleClick(event, to)}
                    className={({ isActive }) =>
                      `nav-item ${styles.item}${isActive ? ' active' : ''}`
                    }
                    title={library.name}
                  >
                    <span
                      className={`nav-icon ${styles.icon}`}
                      style={mediaLibraryIdentityStyle(library.color)}
                    >
                      <NavIcon name={library.icon} />
                    </span>
                    <span className={`nav-label ${styles.name}`}>{library.name}</span>
                    {library.pendingRemovalRootCount > 0 ? (
                      <span
                        className={styles.warning}
                        title={`${library.pendingRemovalRootCount} 个来源待移除`}
                        aria-label={`${library.pendingRemovalRootCount} 个来源待移除`}
                      />
                    ) : null}
                  </NavLink>
                </div>
              )
            })}
            {archivedLibraries.length > 0 ? (
              <div className={styles.archivedLabel}>已归档</div>
            ) : null}
            {archivedLibraries.map((library) => {
              const to = mediaLibrarySettingsPath(library.id, 'danger')
              const active = activeLibrary?.libraryId === library.id
              return (
                <div className="nav-item-row" key={library.id}>
                  <NavLink
                    to={to}
                    draggable={false}
                    onClick={(event) => {
                      event.preventDefault()
                      const go = (): void => navigate(to)
                      if (location.pathname === ROUTE_PATH.settingsPluginDev) requestLeave(go)
                      else go()
                    }}
                    className={`nav-item ${styles.item} ${styles.archivedItem}${active ? ' active' : ''}`}
                    title={`${library.name}（已归档）`}
                  >
                    <span
                      className={`nav-icon ${styles.icon}`}
                      style={mediaLibraryIdentityStyle(library.color)}
                    >
                      <NavIcon name={library.icon} />
                    </span>
                    <span className={`nav-label ${styles.name}`}>{library.name}</span>
                  </NavLink>
                </div>
              )
            })}
          </>
        )}
      </div>
      </div>
      {createOpen ? (
        // The sidebar establishes a clipped stacking context; mount the dialog at
        // the document root so its fixed backdrop and form cover the full window.
        createPortal(
          <MediaLibraryCreateModal
            onCancel={() => setCreateOpen(false)}
            onCreated={handleCreated}
          />,
          document.body
        )
      ) : null}
    </>
  )
}
