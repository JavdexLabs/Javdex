import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { navigateToVideoDetail } from '../listView/listNavigation'
import type { Video } from '@shared/videoTypes'
import { assetUrl } from '../api'
import { useDisplayMode } from './DisplayModeContext'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { Ellipsis, ListMinus, Pencil } from 'lucide-react'
import IconButton from './IconButton'
import MediaTileActionButton from './MediaTileActionButton'
import { UI_ICON, UI_ICON_SM } from './iconDefaults'
import { getVideoResourceBadgeSummary } from './videoResourceBadges'

const STATUS_BADGE: Record<number, { text: string; cls: string } | null> = {
  0: { text: '未刮削', cls: 'unscraped' },
  1: null,
  2: { text: '刮削失败', cls: 'failed' }
}

interface PosterCardProps {
  video: Video
  /** Fixed thumbnail height from virtual grid layout (keeps portrait rows aligned). */
  thumbHeight?: number
  selected?: boolean
  selectionMode?: boolean
  onToggleSelect?: (video: Video, event?: React.MouseEvent) => void
  onEdit?: (video: Video) => void
  onAddToPlaylist?: (video: Video) => void
  onScrape?: (video: Video) => void
  onMarkScrapeSuccess?: (video: Video) => void
  onDelete?: (video: Video) => void
  onRemove?: (video: Video) => void
  removeDisabled?: boolean
}

export default function PosterCard({
  video,
  thumbHeight,
  selected = false,
  selectionMode = false,
  onToggleSelect,
  onEdit,
  onAddToPlaylist,
  onScrape,
  onMarkScrapeSuccess,
  onDelete,
  onRemove,
  removeDisabled = false
}: PosterCardProps): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const { mode, showResourceTypeBadges } = useDisplayMode()
  const cover = assetUrl(video.cover_path)
  const badge = STATUS_BADGE[video.scraped_status]
  const [tallCover, setTallCover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const hasQuickActions = Boolean(onAddToPlaylist || onScrape || onMarkScrapeSuccess || onDelete)
  const resourceBadges = getVideoResourceBadgeSummary(video.resource_kinds ?? [])

  const dismissMenu = useCallback(() => {
    setMenuOpen(false)
  }, [])

  useDismissOverlaysOnNavigate(dismissMenu, location.pathname)

  useEffect(() => {
    setTallCover(false)
  }, [cover, mode])

  useEscapeKey(() => setMenuOpen(false), menuOpen)

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [menuOpen])

  const onCoverLoad = (e: React.SyntheticEvent<HTMLImageElement>): void => {
    const img = e.currentTarget
    setTallCover(mode === 'landscape' && img.naturalHeight > img.naturalWidth)
  }

  const openVideo = (event?: React.MouseEvent): void => {
    if (selectionMode && onToggleSelect) {
      if (event?.shiftKey) event.preventDefault()
      onToggleSelect(video, event)
      return
    }
    navigateToVideoDetail(navigate, location, video.id)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented || e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openVideo()
    }
  }

  const stopAndRun = (
    e: React.MouseEvent,
    action: ((video: Video) => void) | undefined
  ): void => {
    e.stopPropagation()
    setMenuOpen(false)
    action?.(video)
  }

  const stopAndToggleSelect = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (e.shiftKey) e.preventDefault()
    setMenuOpen(false)
    onToggleSelect?.(video, e)
  }

  return (
    <div
      className={`poster-card card-interactive${selected ? ' is-selected' : ''}${selectionMode ? ' is-selection-mode' : ''}`}
      role="button"
      tabIndex={0}
      onClick={openVideo}
      onKeyDown={onKeyDown}
    >
      <div
        className={`poster-thumb ${mode}${thumbHeight != null ? ' poster-thumb--fixed' : ''}`}
        style={thumbHeight != null ? { height: thumbHeight } : undefined}
      >
        {cover ? (
          <img
            src={cover}
            alt={video.code}
            loading="lazy"
            className={`cover-${mode}${tallCover ? ' cover-tall' : ''}`}
            onLoad={onCoverLoad}
          />
        ) : (
          <div className="poster-placeholder">{video.code}</div>
        )}
        {badge && <span className={`poster-badge ${badge.cls}`}>{badge.text}</span>}
        {showResourceTypeBadges && resourceBadges.visible.length > 0 ? (
          <span
            className="poster-resource-badges"
            title={resourceBadges.title}
            aria-label={`资源类型：${resourceBadges.title}`}
          >
            {resourceBadges.visible.map((item) => (
              <span key={item.kind} className="poster-resource-badge">
                {item.label}
              </span>
            ))}
            {resourceBadges.overflow > 0 ? (
              <span className="poster-resource-badge">+{resourceBadges.overflow}</span>
            ) : null}
          </span>
        ) : null}
        {onToggleSelect && (
          <button
            type="button"
            className={`poster-select-toggle poster-hover-control${selected || selectionMode ? ' is-visible' : ''}${selected ? ' is-checked' : ''}`}
            aria-label={selected ? `取消选择 ${video.code}` : `选择 ${video.code}`}
            aria-pressed={selected}
            onClick={stopAndToggleSelect}
          />
        )}
        {!selectionMode && onRemove && (
          <MediaTileActionButton
            action="remove"
            className="poster-hover-control"
            icon={<ListMinus {...UI_ICON_SM} />}
            label={`从清单移出 ${video.code}`}
            title="移出清单"
            disabled={removeDisabled}
            onClick={() => {
              setMenuOpen(false)
              onRemove(video)
            }}
          />
        )}
        {!selectionMode && onEdit && (
          <IconButton
            className="poster-icon-action poster-edit-action poster-hover-control"
            icon={<Pencil {...UI_ICON} />}
            label={`编辑 ${video.code} 元数据`}
            title="编辑元数据"
            onClick={(e) => stopAndRun(e, onEdit)}
          />
        )}
        {!selectionMode && hasQuickActions && (
          <div
            ref={menuRef}
            className="poster-menu-wrap poster-hover-control"
            onClick={(e) => e.stopPropagation()}
          >
            <IconButton
              className="poster-icon-action"
              icon={<Ellipsis {...UI_ICON} />}
              label={`${video.code} 功能菜单`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="更多"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen((open) => !open)
              }}
            />
            {menuOpen && (
              <div className="poster-action-menu" role="menu">
                {onAddToPlaylist && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={(e) => stopAndRun(e, onAddToPlaylist)}
                  >
                    加入清单
                  </button>
                )}
                {onScrape && (
                  <button type="button" role="menuitem" onClick={(e) => stopAndRun(e, onScrape)}>
                    刮削元数据
                  </button>
                )}
                {onMarkScrapeSuccess && video.scraped_status !== 1 && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={(e) => stopAndRun(e, onMarkScrapeSuccess)}
                  >
                    标记为刮削成功
                  </button>
                )}
                {onDelete && (
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    onClick={(e) => stopAndRun(e, onDelete)}
                  >
                    删除影片
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="poster-meta">
        <div className="poster-code">{video.code}</div>
        <div className="poster-title">{video.title || '— 待刮削 —'}</div>
      </div>
    </div>
  )
}
