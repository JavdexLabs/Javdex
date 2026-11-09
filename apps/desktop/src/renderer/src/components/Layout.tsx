import { useLocation, useNavigate } from 'react-router-dom'
import { useEffect, type MouseEvent, type ReactNode } from 'react'
import { resolveMediaSrc } from '../api'
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
import MediaLibraryNav from './MediaLibraryNav'
import { type PendingInboxBadgeValue } from '../pendingInboxState'
import {
  isGlobalSearchShortcut,
  queueHomeGlobalSearchFocus
} from '../globalSearchShortcut'
import DesktopSessionOverlay from '../desktop/DesktopSessionOverlay'
import { interactionLayers } from '../interaction/interactionLayers'
import { SidebarNavIcon, SidebarNavLabel, SidebarNavLink, SidebarNavRow } from './SidebarNav'
import styles from './Layout.module.css'
import PlaybackPanel from '../playback/PlaybackPanel'
import { useTaskCenterData } from '../tasks/useTaskCenterData'
import { taskCenterPath } from '../tasks/taskCenterRoutes'

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
  { to: taskCenterPath(), label: '任务中心', icon: 'tasks' },
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
  badges?: Partial<Record<string, PendingInboxBadgeValue>>
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
      if (listRoot === ROUTE_PATH.tasks) { navigate(taskCenterPath()); return }
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
        const hasBadge = typeof badgeCount !== 'number' || badgeCount > 0
        const badgeLabel = badgeCount === 'loading' ? '待处理数量加载中，打开任务中心'
          : badgeCount === 'error' ? '待处理数量加载失败，打开任务中心'
          : `查看 ${badgeCount} 项需要处理的事项`
        return (
          <SidebarNavRow key={n.to}>
            <SidebarNavLink
              to={primaryNavLinkTo(n.to, location.pathname, location.search)}
              end={n.end}
              draggable={false}
              onClick={(event) => handleNavClick(event, n.to)}
              active={activeListRoot === n.to || n.to === ROUTE_PATH.tasks && activeListRoot === ROUTE_PATH.pending}
              reserveBadgeSpace={Boolean(hasBadge && badgeTarget)}
            >
              <SidebarNavIcon>
                <NavIcon name={n.icon} />
              </SidebarNavIcon>
              <SidebarNavLabel>{n.label}</SidebarNavLabel>
            </SidebarNavLink>
            {hasBadge && badgeTarget ? (
              <button
                type="button"
                className={styles.countBadge}
                aria-label={badgeLabel}
                title={badgeLabel}
                onClick={() => handleBadgeClick(n.to, badgeTarget)}
              >
                <span className={styles.countValue}>
                  {badgeCount === 'loading' ? '…' : badgeCount === 'error' ? '!' : badgeCount > 99 ? '99+' : badgeCount}
                </span>
              </button>
            ) : null}
          </SidebarNavRow>
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
  const taskData = useTaskCenterData()
  const pendingBadges: Record<string, PendingInboxBadgeValue> = {
    [ROUTE_PATH.tasks]: taskData.attention
  }

  useEffect(() => {
    syncPrimaryNavigationMemory(location.pathname, location.search)
  }, [location.pathname, location.search])

  useEffect(() => {
    const handleGlobalSearchShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || interactionLayers.hasModal() || !isGlobalSearchShortcut(event)) return
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
    <div className={styles.shell}>
    <div className={styles.root} data-background={hasBackgroundLayer || undefined}>
      {backgroundSrc && (
        <AppBackgroundLayer
          key={backgroundSrc}
          src={backgroundSrc}
        />
      )}
      <aside className={styles.sidebar}>
        <AppBrand />
        <nav className={styles.nav}>
          <div className={styles.browseNav}>
            <NavItems items={NAV_MAIN.slice(0, 1)} />
            <MediaLibraryNav />
            <div role="group" aria-label="全局浏览">
              <NavItems items={NAV_MAIN.slice(1)} />
              <div className={styles.group} data-active={facetActive || undefined}>
                <div className={styles.groupLabel}>分类</div>
                <NavItems items={NAV_FACETS} />
              </div>
            </div>
          </div>
          <div className={styles.spacer} />
          <NavItems
            items={NAV_BOTTOM}
            badges={pendingBadges}
            badgeTargets={{ [ROUTE_PATH.tasks]: taskCenterPath() }}
          />
        </nav>
      </aside>
      <div className={styles.main}>
        <DesktopSessionOverlay />
        <div className={styles.content}>{children}</div>
        <PlaybackPanel />
      </div>
      <AssetCryptoOverlay />
    </div>
    </div>
  )
}
