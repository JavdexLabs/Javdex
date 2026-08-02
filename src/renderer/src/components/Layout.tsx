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
import { actressKeys } from '../query/queryKeys'

type NavItem = { to: string; label: string; icon: NavIconName; end?: boolean }

const NAV_MAIN: NavItem[] = [
  { to: ROUTE_PATH.library, label: '媒体库', icon: 'library', end: true },
  { to: ROUTE_PATH.playlists, label: '清单', icon: 'playlist' },
  { to: ROUTE_PATH.actresses, label: '演员', icon: 'actress' }
]

const NAV_FACETS: NavItem[] = [
  { to: '/facet/director', label: '导演', icon: 'director' },
  { to: '/facet/maker', label: '制作商', icon: 'maker' },
  { to: '/facet/publisher', label: '发行商', icon: 'publisher' },
  { to: '/facet/series', label: '系列', icon: 'series' }
]

const NAV_BOTTOM: NavItem[] = [{ to: ROUTE_PATH.settings, label: '设置', icon: 'settings' }]

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
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <span className="nav-icon">
                <NavIcon name={n.icon} />
              </span>
              <span className="nav-label">{n.label}</span>
            </NavLink>
            {badgeCount > 0 && badgeTarget ? (
              <button
                type="button"
                className="nav-count-badge nav-count-badge--entry"
                aria-label={`打开 ${badgeCount} 项待确认名称冲突`}
                title="打开名称冲突待确认"
                onClick={() => handleBadgeClick(n.to, badgeTarget)}
              >
                {badgeCount > 99 ? '99+' : badgeCount}
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
  const conflictBadges = {
    [ROUTE_PATH.actresses]: conflictSummaryQuery.data?.groupCount ?? 0
  }

  useEffect(() => {
    syncPrimaryNavigationMemory(location.pathname, location.search)
  }, [location.pathname, location.search])

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
          <NavItems
            items={NAV_MAIN}
            badges={conflictBadges}
            badgeTargets={{ [ROUTE_PATH.actresses]: ROUTE_PATH.actressConflicts }}
          />
          <div className={`nav-group${facetActive ? ' nav-group--active' : ''}`}>
            <div className="nav-group-label">分类</div>
            <NavItems items={NAV_FACETS} />
          </div>
          <div className="sidebar-nav-spacer" />
          <NavItems items={NAV_BOTTOM} />
        </nav>
      </aside>
      <div className="main-area">
        <div className="content">{children}</div>
      </div>
      <AssetCryptoOverlay />
    </div>
  )
}
