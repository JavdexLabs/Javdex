import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { navigateToVideoDetail } from '../listView/listNavigation'
import type { Video } from '@shared/types'
import { assetUrl } from '../api'
import { useDisplayMode } from './DisplayModeContext'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { Ellipsis, ListMinus, Pencil } from 'lucide-react'
import IconButton from './IconButton'
import { UI_ICON } from './iconDefaults'

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
  onToggleSelect?: (video: Video) => void
  onEdit?: (video: Video) => void
  onAddToPlaylist?: (video: Video) => void
  onScrape?: (video: Video) => void
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
  onDelete,
  onRemove,
  removeDisabled = false
}: PosterCardProps): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const { mode } = useDisplayMode()
  const cover = assetUrl(video.cover_path)
  const badge = STATUS_BADGE[video.scraped_status]
  const [tallCover, setTallCover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const hasQuickActions = Boolean(onAddToPlaylist || onScrape || onDelete)

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

  const openVideo = (): void => {
    if (selectionMode && onToggleSelect) {
      onToggleSelect(video)
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
        {onToggleSelect && (
          <button
            type="button"
            className={`poster-select-toggle poster-hover-control${selected || selectionMode ? ' is-visible' : ''}${selected ? ' is-checked' : ''}`}
            aria-label={selected ? `取消选择 ${video.code}` : `选择 ${video.code}`}
            aria-pressed={selected}
            onClick={(e) => stopAndRun(e, onToggleSelect)}
          />
        )}
        {!selectionMode && onRemove && (
          <IconButton
            className="poster-icon-action poster-remove-action poster-hover-control"
            icon={<ListMinus {...UI_ICON} />}
            label={`从清单移出 ${video.code}`}
            title="移出清单"
            disabled={removeDisabled}
            onClick={(e) => stopAndRun(e, onRemove)}
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
