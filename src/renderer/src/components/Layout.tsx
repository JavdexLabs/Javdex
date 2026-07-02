import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { type MouseEvent, type ReactNode } from 'react'
import { resolveMediaSrc } from '../api'
import { getDetailPosterScope } from '../listView/detailPosterScope'
import { clearListScrollForPrimaryNav } from '../listView/listViewMemory'
import AppBrand from './AppBrand'
import AssetCryptoOverlay from './AssetCryptoOverlay'
import AppBackgroundLayer from './AppBackgroundLayer'
import { useAppBackground } from './AppBackgroundContext'
import { useImagePreviewOverlay } from './ImagePreviewOverlayContext'
import { usePluginDevLeaveGuard } from './pluginDev/PluginDevLeaveGuard'
import { NavIcon, type NavIconName } from './NavIcons'

type NavItem = { to: string; label: string; icon: NavIconName; end?: boolean }

const NAV_MAIN: NavItem[] = [
  { to: '/', label: '媒体库', icon: 'library', end: true },
  { to: '/playlists', label: '清单', icon: 'playlist' },
  { to: '/actresses', label: '演员', icon: 'actress' }
]

const NAV_FACETS: NavItem[] = [
  { to: '/facet/director', label: '导演', icon: 'director' },
  { to: '/facet/maker', label: '制作商', icon: 'maker' },
  { to: '/facet/publisher', label: '发行商', icon: 'publisher' },
  { to: '/facet/series', label: '系列', icon: 'series' }
]

const NAV_BOTTOM: NavItem[] = [{ to: '/settings', label: '设置', icon: 'settings' }]

function isPluginDevPath(pathname: string): boolean {
  return pathname.endsWith('/plugin-dev')
}

function NavItems({ items }: { items: NavItem[] }): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const { requestLeave } = usePluginDevLeaveGuard()

  const handleNavClick = (event: MouseEvent<HTMLAnchorElement>, to: string): void => {
    clearListScrollForPrimaryNav(to)
    if (!isPluginDevPath(location.pathname) || to === location.pathname) return
    event.preventDefault()
    requestLeave(() => navigate(to))
  }

  return (
    <>
      {items.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          onClick={(event) => handleNavClick(event, n.to)}
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
        >
          <span className="nav-icon">
            <NavIcon name={n.icon} />
          </span>
          <span className="nav-label">{n.label}</span>
        </NavLink>
      ))}
    </>
  )
}

export default function Layout({ children }: { children: ReactNode }): JSX.Element {
  const location = useLocation()
  const { getBackground } = useAppBackground()
  const { isOpen: imagePreviewOpen } = useImagePreviewOverlay()
  const facetActive = NAV_FACETS.some((n) => location.pathname.startsWith(n.to))
  const background = getBackground(getDetailPosterScope(location.pathname))
  const backgroundSrc = imagePreviewOpen ? null : resolveMediaSrc(background?.path)
  const hasBackgroundLayer = Boolean(backgroundSrc)

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
          <NavItems items={NAV_MAIN} />
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
