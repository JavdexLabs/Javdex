import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, type MouseEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, resolveMediaSrc } from '../api'
import { getDetailPosterScope } from '../listView/detailPosterScope'
import { clearListScrollForPrimaryNav } from '../listView/listViewMemory'
import {
  primaryListRoot,
  primaryNavLinkTo,
  resolvePrimaryNavTarget,
  syncPrimaryNavigationMemory
} from '../listView/primaryNavigationMemory'
import AppBrand from './AppBrand'
import AssetCryptoOverlay from './AssetCryptoOverlay'
import AppBackgroundLayer from './AppBackgroundLayer'
import { useAppBackground } from './AppBackgroundContext'
import { useImagePreviewOverlay } from './ImagePreviewOverlayContext'
import { useTheme } from './ThemeProvider'
import { usePluginDevLeaveGuard } from './pluginDev/PluginDevLeaveGuard'
import { NavIcon, type NavIconName } from './NavIcons'
import { ROUTE_PATH } from '../listView/routePaths'
import { pendingCenterPath } from '../listView/pendingRoutes'
import { actressKeys, mediaLibraryKeys } from '../query/queryKeys'
import MediaLibraryNav from './MediaLibraryNav'
import { pendingInboxCount } from '../pendingInboxState'
import {
  isGlobalSearchShortcut,
  queueHomeGlobalSearchFocus
} from '../globalSearchShortcut'

type NavItem = { to: string; label: string; icon: NavIconName; end?: boolean }

const NAV_MAIN: NavItem[] = [
  { to: ROUTE_PATH.home, label: '首页', icon: 'home', end: true },
  { to: ROUTE_PATH.playlists, label: '清单', icon: 'playlist' },
  { to: ROUTE_PATH.actresses, label: '演员', icon: 'actress' }
]

const NAV_FACETS: NavItem[] = [
  { to: '/facet/director', label: '导演', icon: 'director' },
  { to: '/facet/maker', label: '制作商', icon: 'maker' },
  { to: '/facet/publisher', label: '发行商', icon: 'publisher' },
  { to: '/facet/series', label: '系列', icon: 'series' }
]

/** Maintenance zone: pinned to the sidebar bottom so the pending badge never shifts. */
const NAV_BOTTOM: NavItem[] = [
  { to: pendingCenterPath(), label: '待确认', icon: 'pending' },
  { to: ROUTE_PATH.settings, label: '设置', icon: 'settings' }
]

function isPluginDevPath(pathname: string): boolean {
  return pathname === ROUTE_PATH.settingsPluginDev
}

function NavItems({
  items,
  badges = {},
  badgeTargets = {}
}: {
  items: NavItem[]
  badges?: Partial<Record<string, number>>
  badgeTargets?: Partial<Record<string, string>>
}): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const { requestLeave } = usePluginDevLeaveGuard()
  const activeListRoot = primaryListRoot(location.pathname)

  const handleNavClick = (event: MouseEvent<HTMLAnchorElement>, to: string): void => {
    event.preventDefault()
    if (to === activeListRoot) clearListScrollForPrimaryNav(to)

    const target = resolvePrimaryNavTarget(to, location.pathname, location.search)
    if (target == null) return

    const go = (): void => {
      navigate(target)
    }
    if (isPluginDevPath(location.pathname) && to !== location.pathname) {
      requestLeave(go)
      return
    }
    go()
  }

  const handleBadgeClick = (listRoot: string, target: string): void => {
    const go = (): void => {
      const listTarget = primaryNavLinkTo(listRoot, location.pathname, location.search)
      navigate({ pathname: target, search: listTarget.search })
    }
    if (isPluginDevPath(location.pathname)) {
      requestLeave(go)
      return
    }
    go()
  }

  return (
    <>
      {items.map((n) => {
        const badgeCount = badges[n.to] ?? 0
        const badgeTarget = badgeTargets[n.to]
        return (
          <div
            className={`nav-item-row${badgeCount > 0 && badgeTarget ? ' nav-item-row--with-badge' : ''}`}
            key={n.to}
          >
            <NavLink
              to={primaryNavLinkTo(n.to, location.pathname, location.search)}
              end={n.end}
              draggable={false}
              onClick={(event) => handleNavClick(event, n.to)}
              className={({ isActive }) =>
                `nav-item ${isActive || activeListRoot === n.to ? 'active' : ''}`
              }
            >
              <span className="nav-icon">
                <NavIcon name={n.icon} />
              </span>
              <span className="nav-label">{n.label}</span>
            </NavLink>
            {badgeCount > 0 && badgeTarget ? (
              <button
                type="button"
                className="nav-count-badge"
                aria-label={`打开 ${badgeCount} 项待确认`}
                title="打开待确认项"
                onClick={() => handleBadgeClick(n.to, badgeTarget)}
              >
                <span className="nav-count-badge__value">
                  {badgeCount > 99 ? '99+' : badgeCount}
                </span>
              </button>
            ) : null}
          </div>
        )
      })}
    </>
  )
}

export default function Layout({ children }: { children: ReactNode }): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const { requestLeave } = usePluginDevLeaveGuard()
  const { getBackground } = useAppBackground()
  const { isOpen: imagePreviewOpen } = useImagePreviewOverlay()
  const { privacyMode } = useTheme()
  const facetActive = NAV_FACETS.some((n) => location.pathname.startsWith(n.to))
  const background = getBackground(getDetailPosterScope(location.pathname))
  const privacyHidesBackground =
    privacyMode.privacyModeEnabled &&
    privacyMode.privacyModeScopes.includes('globalBackground')
  const backgroundSrc =
    imagePreviewOpen || privacyHidesBackground ? null : resolveMediaSrc(background?.path)
  const hasBackgroundLayer = Boolean(backgroundSrc)
  const conflictSummaryQuery = useQuery({
    queryKey: actressKeys.conflictSummary(),
    queryFn: () => api.actressScrape.conflictSummary(),
    refetchInterval: 3_000
  })
  const librariesQuery = useQuery({
    queryKey: mediaLibraryKeys.activeList(),
    queryFn: () => api.mediaLibraries.list(),
    staleTime: 2_000,
    refetchInterval: 3_000
  })
  const pendingVideoQuery = useQuery({
    queryKey: ['pending-video-scrapes'],
    queryFn: () => api.scrape.listPending(),
    refetchInterval: 3_000
  })
  /** One inbox, one badge: scan groups, scrape snapshots and actress name conflicts. */
  const pendingBadges: Record<string, number> = {
    [ROUTE_PATH.pending]: pendingInboxCount({
      libraries: librariesQuery.data ?? [],
      pendingVideoCount: pendingVideoQuery.data?.length ?? 0,
      actressConflictGroupCount: conflictSummaryQuery.data?.groupCount ?? 0
    })
  }

  useEffect(() => {
    syncPrimaryNavigationMemory(location.pathname, location.search)
  }, [location.pathname, location.search])

  useEffect(() => {
    const handleGlobalSearchShortcut = (event: KeyboardEvent): void => {
      if (!isGlobalSearchShortcut(event)) return
      event.preventDefault()
      const go = (): void => {
        if (location.pathname !== ROUTE_PATH.home) navigate(ROUTE_PATH.home)
        queueHomeGlobalSearchFocus(document, window.requestAnimationFrame.bind(window))
      }
      if (isPluginDevPath(location.pathname)) requestLeave(go)
      else go()
    }
    window.addEventListener('keydown', handleGlobalSearchShortcut)
    return () => window.removeEventListener('keydown', handleGlobalSearchShortcut)
  }, [location.pathname, navigate, requestLeave])

  return (
    <div className={`app-shell${hasBackgroundLayer ? ' app-shell--with-background' : ''}`}>
      {backgroundSrc && (
        <AppBackgroundLayer
          key={backgroundSrc}
          src={backgroundSrc}
          animationClass="app-background--active"
        />
      )}
      <aside className="sidebar">
        <AppBrand />
        <nav className="sidebar-nav">
          <NavItems items={NAV_MAIN.slice(0, 1)} />
          <MediaLibraryNav />
          <NavItems items={NAV_MAIN.slice(1)} />
          <div className={`nav-group${facetActive ? ' nav-group--active' : ''}`}>
            <div className="nav-group-label">分类</div>
            <NavItems items={NAV_FACETS} />
          </div>
          <div className="sidebar-nav-spacer" />
          <NavItems
            items={NAV_BOTTOM}
            badges={pendingBadges}
            badgeTargets={{ [ROUTE_PATH.pending]: pendingCenterPath() }}
          />
        </nav>
      </aside>
      <div className="main-area">
        <div className="content">{children}</div>
      </div>
      <AssetCryptoOverlay />
    </div>
  )
}
