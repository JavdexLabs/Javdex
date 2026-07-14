import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { Minus, Plus, RotateCcw, X } from 'lucide-react'
import IconButton from './IconButton'
import { useImagePreviewOverlay } from './ImagePreviewOverlayContext'
import { UI_ICON } from './iconDefaults'

const ZOOM_MIN = 0.5
const ZOOM_MAX = 5
const ZOOM_STEP = 0.15
const CHROME_IDLE_MS = 1000
/** Ignore passive pointer/focus events right after open so chrome stays hidden until interaction. */
const CHROME_OPEN_GRACE_MS = 200
const FILMSTRIP_DRAG_THRESHOLD = 5
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export interface ImagePreviewItem {
  id: number
  src: string
  /** Local asset path used for poster selection; omit when poster actions are disabled. */
  localPath?: string | null
}

export interface ImagePreviewLabels {
  dialog: string
  filmstrip: string
  thumb: (index: number) => string
  posterMissing?: string
}

export interface ImagePreviewLightboxProps {
  items: ImagePreviewItem[]
  index: number
  onClose: () => void
  onIndexChange: (index: number) => void
  labels: ImagePreviewLabels
  posterPath?: string | null
  onPosterChange?: (posterPath: string | null) => Promise<void>
  toolbarActions?: ReactNode
}

export default function ImagePreviewLightbox({
  items,
  index,
  onClose,
  onIndexChange,
  labels,
  posterPath = null,
  onPosterChange,
  toolbarActions
}: ImagePreviewLightboxProps): JSX.Element | null {
  const { register } = useImagePreviewOverlay()
  const src = items[index]?.src
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [savingPoster, setSavingPoster] = useState(false)
  const [chromeVisible, setChromeVisible] = useState(false)
  const [chromeHover, setChromeHover] = useState(false)
  const [imageReady, setImageReady] = useState(true)
  const [filmstripDragging, setFilmstripDragging] = useState(false)
  const chromeHoverRef = useRef(false)
  const chromeGateRef = useRef<'arming' | 'open'>('arming')
  const chromeTimerRef = useRef<number | null>(null)
  const chromeReleaseTimerRef = useRef<number | null>(null)
  const chromeGateTimerRef = useRef<number | null>(null)
  const activeThumbRef = useRef<HTMLButtonElement>(null)
  const filmstripRef = useRef<HTMLDivElement>(null)
  const thumbSelectRef = useRef(false)
  const filmstripDraggedRef = useRef(false)
  const filmstripDragRef = useRef<{
    pointerId: number
    startX: number
    originScrollLeft: number
  } | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)

  const resetView = useCallback(() => {
    setScale(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const clearChromeTimer = useCallback(() => {
    if (chromeTimerRef.current != null) {
      window.clearTimeout(chromeTimerRef.current)
      chromeTimerRef.current = null
    }
  }, [])

  const scheduleChromeHide = useCallback(() => {
    clearChromeTimer()
    if (chromeHoverRef.current) return
    chromeTimerRef.current = window.setTimeout(() => {
      if (!chromeHoverRef.current) setChromeVisible(false)
      chromeTimerRef.current = null
    }, CHROME_IDLE_MS)
  }, [clearChromeTimer])

  const bumpChrome = useCallback(() => {
    setChromeVisible(true)
    scheduleChromeHide()
  }, [scheduleChromeHide])

  const armChromeGate = useCallback(() => {
    chromeGateRef.current = 'arming'
    if (chromeGateTimerRef.current != null) {
      window.clearTimeout(chromeGateTimerRef.current)
    }
    chromeGateTimerRef.current = window.setTimeout(() => {
      chromeGateRef.current = 'open'
      chromeGateTimerRef.current = null
    }, CHROME_OPEN_GRACE_MS)
  }, [])

  const resetChromeOnOpen = useCallback(() => {
    clearChromeTimer()
    chromeHoverRef.current = false
    setChromeHover(false)
    setChromeVisible(false)
    armChromeGate()
  }, [armChromeGate, clearChromeTimer])

  /** Show chrome and restart the idle hide timer (skipped while toolbar chrome is held). */
  const noteChromeActivity = useCallback(
    (passive = false) => {
      if (passive && chromeGateRef.current === 'arming') return
      if (chromeHoverRef.current) return
      bumpChrome()
    },
    [bumpChrome]
  )

  const holdChrome = useCallback(() => {
    if (chromeReleaseTimerRef.current != null) {
      window.clearTimeout(chromeReleaseTimerRef.current)
      chromeReleaseTimerRef.current = null
    }
    chromeHoverRef.current = true
    setChromeHover(true)
    setChromeVisible(true)
    clearChromeTimer()
  }, [clearChromeTimer])

  const releaseChrome = useCallback(() => {
    if (chromeReleaseTimerRef.current != null) {
      window.clearTimeout(chromeReleaseTimerRef.current)
    }
    chromeReleaseTimerRef.current = window.setTimeout(() => {
      chromeHoverRef.current = false
      setChromeHover(false)
      scheduleChromeHide()
      chromeReleaseTimerRef.current = null
    }, 48)
  }, [scheduleChromeHide])

  useEffect(() => register(), [register])

  useEffect(() => {
    resetChromeOnOpen()
  }, [resetChromeOnOpen])

  useEffect(() => {
    resetView()
    if (thumbSelectRef.current) {
      thumbSelectRef.current = false
      setChromeVisible(true)
      clearChromeTimer()
    } else {
      resetChromeOnOpen()
    }
    setImageReady(false)
    const frame = window.requestAnimationFrame(() => setImageReady(true))
    return () => window.cancelAnimationFrame(frame)
  }, [clearChromeTimer, index, resetChromeOnOpen, resetView])

  useEffect(() => {
    return () => {
      clearChromeTimer()
      if (chromeReleaseTimerRef.current != null) {
        window.clearTimeout(chromeReleaseTimerRef.current)
      }
      if (chromeGateTimerRef.current != null) {
        window.clearTimeout(chromeGateTimerRef.current)
      }
    }
  }, [clearChromeTimer])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  useEffect(() => {
    activeThumbRef.current?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [index])

  const zoomBy = useCallback((delta: number) => {
    setScale((current) => {
      const next = clamp(current + delta, ZOOM_MIN, ZOOM_MAX)
      if (next <= 1) setPan({ x: 0, y: 0 })
      return next
    })
  }, [])

  const goPrev = useCallback(() => {
    if (index > 0) onIndexChange(index - 1)
  }, [index, onIndexChange])

  const goNext = useCallback(() => {
    if (index < items.length - 1) onIndexChange(index + 1)
  }, [index, items.length, onIndexChange])

  const selectThumb = useCallback(
    (thumbIndex: number) => {
      if (thumbIndex === index) return
      thumbSelectRef.current = true
      holdChrome()
      onIndexChange(thumbIndex)
    },
    [holdChrome, index, onIndexChange]
  )

  useEscapeKey(onClose, true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        bumpChrome()
        goPrev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        bumpChrome()
        goNext()
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        bumpChrome()
        zoomBy(ZOOM_STEP)
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        bumpChrome()
        zoomBy(-ZOOM_STEP)
      } else if (e.key === '0') {
        e.preventDefault()
        bumpChrome()
        resetView()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bumpChrome, goNext, goPrev, resetView, zoomBy])

  useEffect(() => {
    if (index < 0 || index >= items.length || !items[index]?.src) {
      onClose()
    }
  }, [index, items, onClose])

  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    e.preventDefault()
    bumpChrome()
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    bumpChrome()
    if (scale <= 1 || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: pan.x,
      originY: pan.y
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    setPan({
      x: drag.originX + (e.clientX - drag.startX),
      y: drag.originY + (e.clientY - drag.startY)
    })
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null
  }

  const onDoubleClick = (): void => {
    bumpChrome()
    if (Math.round(scale * 100) !== 100) resetView()
    else setScale(2)
  }

  const onFilmstripWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const el = filmstripRef.current
    if (!el) return
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    if (delta === 0) return
    e.preventDefault()
    e.stopPropagation()
    el.scrollLeft += delta
    noteChromeActivity()
  }

  const onFilmstripPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const el = filmstripRef.current
    if (!el) return
    filmstripDraggedRef.current = false
    setFilmstripDragging(false)
    filmstripDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      originScrollLeft: el.scrollLeft
    }
    holdChrome()
  }

  const onFilmstripPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = filmstripDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const el = filmstripRef.current
    if (!el) return
    const delta = e.clientX - drag.startX
    if (Math.abs(delta) <= FILMSTRIP_DRAG_THRESHOLD) return
    if (!filmstripDraggedRef.current) {
      filmstripDraggedRef.current = true
      setFilmstripDragging(true)
      el.setPointerCapture(e.pointerId)
    }
    el.scrollLeft = drag.originScrollLeft - delta
  }

  const endFilmstripDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = filmstripDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    filmstripDragRef.current = null
    setFilmstripDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const handleThumbClick = (thumbIndex: number): void => {
    if (filmstripDraggedRef.current) {
      filmstripDraggedRef.current = false
      return
    }
    selectThumb(thumbIndex)
  }

  if (!src) return null

  const canPan = scale > 1
  const posterCandidate = items[index]?.localPath ?? null
  const isPoster = Boolean(posterCandidate && posterPath === posterCandidate)
  const showPosterAction = Boolean(onPosterChange)
  const chromeClass = chromeVisible || savingPoster || chromeHover ? ' is-visible' : ''
  const canResetView = Math.round(scale * 100) !== 100

  const togglePoster = async (): Promise<void> => {
    if (!onPosterChange || !posterCandidate || savingPoster) return
    setSavingPoster(true)
    bumpChrome()
    try {
      await onPosterChange(isPoster ? null : posterCandidate)
      onClose()
    } finally {
      setSavingPoster(false)
    }
  }

  return createPortal(
    (
    <div
      className="image-preview"
      role="dialog"
      aria-modal
      aria-label={labels.dialog}
      aria-describedby="image-preview-hint"
      onFocusCapture={() => noteChromeActivity(true)}
    >
      <div className="image-preview-backdrop" aria-hidden />
      <p id="image-preview-hint" className="sr-only">
        使用左右方向键切换图片，加号与减号缩放，0 还原视图，Esc 关闭。
      </p>

      <header
        className={`image-preview-chrome image-preview-chrome--top${chromeClass}`}
        onMouseEnter={holdChrome}
        onMouseLeave={releaseChrome}
        onFocusCapture={holdChrome}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) releaseChrome()
        }}
      >
        <span className="image-preview-counter image-preview-toolbar-pill">
          {index + 1} / {items.length}
        </span>
        <div className="image-preview-actions">
          {showPosterAction && (
            <button
              type="button"
              className={`image-preview-poster-chip${isPoster ? ' is-active' : ''}`}
              onClick={() => void togglePoster()}
              disabled={!posterCandidate || savingPoster}
              title={posterCandidate ? undefined : labels.posterMissing}
            >
              {savingPoster ? '保存中…' : isPoster ? '背景 ✓' : '设为背景'}
            </button>
          )}
          {toolbarActions}
          <div className="image-preview-zoom" aria-label="缩放">
            <IconButton
              className="image-preview-icon-btn image-preview-zoom-btn"
              icon={<Minus {...UI_ICON} />}
              label="缩小"
              onClick={() => zoomBy(-ZOOM_STEP)}
            />
            <span className="image-preview-zoom-label">{Math.round(scale * 100)}%</span>
            <IconButton
              className="image-preview-icon-btn image-preview-zoom-btn"
              icon={<Plus {...UI_ICON} />}
              label="放大"
              onClick={() => zoomBy(ZOOM_STEP)}
            />
            <IconButton
              className="image-preview-icon-btn image-preview-reset-btn"
              icon={<RotateCcw {...UI_ICON} />}
              label="还原视图"
              onClick={resetView}
              disabled={!canResetView}
            />
          </div>
          <IconButton
            className="image-preview-close image-preview-icon-btn"
            icon={<X {...UI_ICON} />}
            label="关闭预览"
            onClick={onClose}
          />
        </div>
      </header>

      <div className="image-preview-stage" onPointerMove={() => noteChromeActivity(true)}>
        <button
          type="button"
          className="image-preview-hit image-preview-hit--prev"
          onClick={goPrev}
          onMouseEnter={() => noteChromeActivity(true)}
          disabled={index === 0}
          aria-label="上一张"
        />
        <div
          className={`image-preview-viewport${canPan ? ' image-preview-viewport--pan' : ''}`}
          onPointerEnter={() => noteChromeActivity(true)}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
        >
          <img
            key={items[index]?.id ?? index}
            src={src}
            alt=""
            className={`image-preview-img${imageReady ? ' is-visible' : ''}`}
            style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})` }}
            draggable={false}
          />
        </div>
        <button
          type="button"
          className="image-preview-hit image-preview-hit--next"
          onClick={goNext}
          onMouseEnter={() => noteChromeActivity(true)}
          disabled={index === items.length - 1}
          aria-label="下一张"
        />
      </div>

      <footer
        className={`image-preview-chrome image-preview-chrome--bottom${chromeClass}`}
        onMouseEnter={holdChrome}
        onMouseLeave={releaseChrome}
        onFocusCapture={holdChrome}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) releaseChrome()
        }}
      >
        <div
          ref={filmstripRef}
          className={`image-preview-filmstrip${
            filmstripDragging ? ' image-preview-filmstrip--dragging' : ''
          }`}
          role="tablist"
          aria-label={labels.filmstrip}
          onWheel={onFilmstripWheel}
          onPointerDownCapture={onFilmstripPointerDown}
          onPointerMove={onFilmstripPointerMove}
          onPointerUp={endFilmstripDrag}
          onPointerCancel={endFilmstripDrag}
        >
          {items.map((item, thumbIndex) => {
            const active = thumbIndex === index
            const thumbIsPoster = Boolean(item.localPath && posterPath === item.localPath)
            return (
              <button
                key={item.id}
                ref={active ? activeThumbRef : undefined}
                type="button"
                role="tab"
                aria-selected={active}
                className={`image-preview-thumb${active ? ' image-preview-thumb--active' : ''}${
                  thumbIsPoster ? ' image-preview-thumb--poster' : ''
                }`}
                onClick={() => handleThumbClick(thumbIndex)}
                aria-label={labels.thumb(thumbIndex)}
              >
                <img src={item.src} alt="" loading="lazy" draggable={false} />
              </button>
            )
          })}
        </div>
      </footer>
    </div>
    ),
    document.body
  )
}
