import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { Minus, Plus, RotateCcw, X } from 'lucide-react'
import IconButton from './IconButton'
import { useImagePreviewOverlay } from './ImagePreviewOverlayContext'
import { UI_ICON } from './iconDefaults'
import {
  getImagePreviewSwipeDirection,
  isImagePreviewDrag,
  type ImagePreviewSwipeDirection
} from './imagePreviewGesture'

const ZOOM_MIN = 0.5
const ZOOM_MAX = 5
const ZOOM_STEP = 0.15
const CHROME_IDLE_MS = 1000
/** Ignore passive pointer/focus events right after open so chrome stays hidden until interaction. */
const CHROME_OPEN_GRACE_MS = 200
const FILMSTRIP_DRAG_THRESHOLD = 5
const SWIPE_AXIS_LOCK_THRESHOLD = 6
const SWIPE_SETTLE_MS = 180
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export interface ImagePreviewItem {
  id: number
  src: string
  thumbnailSrc?: string
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
  /** A bounded window; onIndexChange may receive -1 or items.length at its edges. */
  windowOffset?: number
  total?: number
  loading?: boolean
  index: number
  onClose: () => void
  onIndexChange: (index: number) => void
  labels: ImagePreviewLabels
  posterPath?: string | null
  onPosterChange?: (posterPath: string | null) => Promise<void>
  navigationStatus?: ReactNode
  toolbarActions?: ReactNode
}

export default function ImagePreviewLightbox({
  items,
  windowOffset = 0,
  total = items.length,
  loading = false,
  index,
  onClose,
  onIndexChange,
  labels,
  posterPath = null,
  onPosterChange,
  toolbarActions,
  navigationStatus
}: ImagePreviewLightboxProps): JSX.Element | null {
  const { register } = useImagePreviewOverlay()
  const src = items[index]?.src
  const assetId = items[index]?.id
  const canPrev = !loading && windowOffset + index > 0
  const canNext = !loading && windowOffset + index + 1 < total
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [savingPoster, setSavingPoster] = useState(false)
  const [chromeVisible, setChromeVisible] = useState(false)
  const [chromeHover, setChromeHover] = useState(false)
  const [imageReady, setImageReady] = useState(true)
  const [filmstripDragging, setFilmstripDragging] = useState(false)
  const [swipeOffsetX, setSwipeOffsetX] = useState(0)
  const [swipeViewportWidth, setSwipeViewportWidth] = useState(0)
  const [swipeDirection, setSwipeDirection] = useState<ImagePreviewSwipeDirection | null>(null)
  const [swipeDragging, setSwipeDragging] = useState(false)
  const [swipeSettling, setSwipeSettling] = useState(false)
  const chromeHoverRef = useRef(false)
  const chromeGateRef = useRef<'arming' | 'open'>('arming')
  const chromeTimerRef = useRef<number | null>(null)
  const chromeReleaseTimerRef = useRef<number | null>(null)
  const chromeGateTimerRef = useRef<number | null>(null)
  const swipeAnimationTimerRef = useRef<number | null>(null)
  const swipeAnimatingRef = useRef(false)
  const swipeCommitRef = useRef(false)
  const swipeClickSuppressedRef = useRef(false)
  const swipeClickReleaseTimerRef = useRef<number | null>(null)
  const activeThumbRef = useRef<HTMLButtonElement>(null)
  const filmstripRef = useRef<HTMLDivElement>(null)
  const thumbSelectRef = useRef(false)
  const filmstripDraggedRef = useRef(false)
  const filmstripDragRef = useRef<{
    pointerId: number
    startX: number
    originScrollLeft: number
  } | null>(null)
  const swipeRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    axis: 'pending' | 'horizontal' | 'vertical'
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

  const clearSwipeAnimation = useCallback(() => {
    if (swipeAnimationTimerRef.current != null) {
      window.clearTimeout(swipeAnimationTimerRef.current)
      swipeAnimationTimerRef.current = null
    }
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
    const preserveReadyImage = swipeCommitRef.current
    swipeCommitRef.current = false
    swipeAnimatingRef.current = false
    swipeRef.current = null
    clearSwipeAnimation()
    setSwipeOffsetX(0)
    setSwipeDirection(null)
    setSwipeDragging(false)
    setSwipeSettling(false)
    resetView()
    if (thumbSelectRef.current) {
      thumbSelectRef.current = false
      setChromeVisible(true)
      clearChromeTimer()
    } else {
      resetChromeOnOpen()
    }
    if (preserveReadyImage) {
      setImageReady(true)
      return
    }
    setImageReady(false)
    const frame = window.requestAnimationFrame(() => setImageReady(true))
    return () => window.cancelAnimationFrame(frame)
  }, [clearChromeTimer, clearSwipeAnimation, index, assetId, resetChromeOnOpen, resetView])

  useEffect(() => {
    return () => {
      clearChromeTimer()
      clearSwipeAnimation()
      if (chromeReleaseTimerRef.current != null) {
        window.clearTimeout(chromeReleaseTimerRef.current)
      }
      if (chromeGateTimerRef.current != null) {
        window.clearTimeout(chromeGateTimerRef.current)
      }
      if (swipeClickReleaseTimerRef.current != null) {
        window.clearTimeout(swipeClickReleaseTimerRef.current)
      }
    }
  }, [clearChromeTimer, clearSwipeAnimation])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  useEffect(() => {
    activeThumbRef.current?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [index, assetId])

  const zoomBy = useCallback((delta: number) => {
    setScale((current) => {
      const next = clamp(current + delta, ZOOM_MIN, ZOOM_MAX)
      if (next <= 1) setPan({ x: 0, y: 0 })
      return next
    })
  }, [])

  const goPrev = useCallback(() => {
    if (swipeAnimatingRef.current || swipeClickSuppressedRef.current) return
    if (canPrev) onIndexChange(index - 1)
  }, [canPrev, index, onIndexChange])

  const goNext = useCallback(() => {
    if (swipeAnimatingRef.current || swipeClickSuppressedRef.current) return
    if (canNext) onIndexChange(index + 1)
  }, [canNext, index, onIndexChange])

  const selectThumb = useCallback(
    (thumbIndex: number) => {
      if (loading || thumbIndex === index || swipeAnimatingRef.current) return
      thumbSelectRef.current = true
      holdChrome()
      onIndexChange(thumbIndex)
    },
    [holdChrome, index, loading, onIndexChange]
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
    if (swipeRef.current || swipeAnimatingRef.current) return
    bumpChrome()
    zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)
  }

  const swipeAreaWidth = (target: HTMLElement): number =>
    target.closest<HTMLElement>('.image-preview-stage')?.clientWidth ?? target.clientWidth

  const onPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    bumpChrome()
    if (loading || e.button !== 0 || swipeAnimatingRef.current) return
    if (Math.round(scale * 100) === 100) {
      e.currentTarget.setPointerCapture(e.pointerId)
      swipeRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        axis: 'pending'
      }
      setSwipeViewportWidth(swipeAreaWidth(e.currentTarget))
      setSwipeOffsetX(0)
      setSwipeDirection(null)
      setSwipeDragging(true)
      return
    }
    if (scale <= 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: pan.x,
      originY: pan.y
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLElement>): void => {
    const swipe = swipeRef.current
    if (swipe?.pointerId === e.pointerId) {
      const deltaX = e.clientX - swipe.startX
      const deltaY = e.clientY - swipe.startY
      if (
        swipe.axis === 'pending' &&
        Math.max(Math.abs(deltaX), Math.abs(deltaY)) > SWIPE_AXIS_LOCK_THRESHOLD
      ) {
        swipe.axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical'
      }
      if (swipe.axis === 'horizontal') {
        // Across a page boundary there is no adjacent image to slide into view.
        const unloadedNeighbor = (deltaX >= 0 && index === 0 && canPrev) ||
          (deltaX < 0 && index === items.length - 1 && canNext)
        setSwipeOffsetX(unloadedNeighbor ? 0 : deltaX)
        setSwipeDirection(deltaX >= 0 ? 'prev' : 'next')
      }
      return
    }
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    setPan({
      x: drag.originX + (e.clientX - drag.startX),
      y: drag.originY + (e.clientY - drag.startY)
    })
  }

  const onPointerUp = (
    e: React.PointerEvent<HTMLElement>,
    commitSwipe = true
  ): void => {
    const swipe = swipeRef.current
    if (swipe?.pointerId === e.pointerId) {
      swipeRef.current = null
      setSwipeDragging(false)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      const deltaX = e.clientX - swipe.startX
      const deltaY = e.clientY - swipe.startY
      if (isImagePreviewDrag(deltaX, deltaY, SWIPE_AXIS_LOCK_THRESHOLD)) {
        swipeClickSuppressedRef.current = true
        if (swipeClickReleaseTimerRef.current != null) {
          window.clearTimeout(swipeClickReleaseTimerRef.current)
        }
        swipeClickReleaseTimerRef.current = window.setTimeout(() => {
          swipeClickSuppressedRef.current = false
          swipeClickReleaseTimerRef.current = null
        }, 0)
      }
      const direction =
        commitSwipe && swipe.axis === 'horizontal'
          ? getImagePreviewSwipeDirection(deltaX, deltaY)
          : null
      const targetIndex =
        direction === 'prev' ? index - 1 : direction === 'next' ? index + 1 : null
      const canCommit = direction === 'prev' ? canPrev : direction === 'next' ? canNext : false

      if (canCommit && targetIndex != null && (targetIndex < 0 || targetIndex >= items.length)) {
        setSwipeOffsetX(0)
        setSwipeDirection(null)
        onIndexChange(targetIndex)
        return
      }

      if (!canCommit && (swipe.axis !== 'horizontal' || Math.abs(deltaX) < 1)) {
        setSwipeOffsetX(0)
        setSwipeDirection(null)
        return
      }

      clearSwipeAnimation()
      swipeAnimatingRef.current = true
      setSwipeSettling(true)
      if (canCommit && direction) {
        const viewportWidth = swipeAreaWidth(e.currentTarget) || swipeViewportWidth
        setSwipeDirection(direction)
        setSwipeOffsetX(direction === 'prev' ? viewportWidth : -viewportWidth)
      } else {
        setSwipeOffsetX(0)
      }
      swipeAnimationTimerRef.current = window.setTimeout(() => {
        swipeAnimationTimerRef.current = null
        if (canCommit && targetIndex != null) {
          swipeCommitRef.current = true
          onIndexChange(targetIndex)
        }
        swipeAnimatingRef.current = false
        setSwipeOffsetX(0)
        setSwipeDirection(null)
        setSwipeSettling(false)
      }, SWIPE_SETTLE_MS)
    }
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
  const canSwipe = Math.round(scale * 100) === 100
  const adjacentIndex =
    swipeDirection === 'prev' ? index - 1 : swipeDirection === 'next' ? index + 1 : -1
  const adjacentItem = adjacentIndex >= 0 && adjacentIndex < items.length ? items[adjacentIndex] : null
  const adjacentOffsetX =
    swipeDirection === 'prev'
      ? swipeOffsetX - swipeViewportWidth
      : swipeDirection === 'next'
        ? swipeOffsetX + swipeViewportWidth
        : 0
  const swipeSlideClass = `${swipeDragging ? ' is-dragging' : ''}${
    swipeSettling ? ' is-settling' : ''
  }`
  const posterCandidate = items[index]?.localPath ?? null
  const isPoster = Boolean(posterCandidate && posterPath === posterCandidate)
  const showPosterAction = Boolean(onPosterChange)
  const chromeClass = chromeVisible || savingPoster || chromeHover || loading || navigationStatus ? ' is-visible' : ''
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
      aria-busy={loading}
      aria-label={labels.dialog}
      aria-describedby="image-preview-hint"
      onFocusCapture={() => noteChromeActivity(true)}
    >
      <div className="image-preview-backdrop" aria-hidden />
      <p id="image-preview-hint" className="sr-only">
        未缩放时可用鼠标左右拖动切换图片；也可使用左右方向键切换图片，加号与减号缩放，0 还原视图，Esc 关闭。
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
          {windowOffset + index + 1} / {total}
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
          {navigationStatus}
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
          onPointerDown={canSwipe ? onPointerDown : undefined}
          onPointerMove={canSwipe ? onPointerMove : undefined}
          onPointerUp={canSwipe ? onPointerUp : undefined}
          onPointerCancel={canSwipe ? (event) => onPointerUp(event, false) : undefined}
          disabled={!canPrev}
          aria-label="上一张"
        />
        <div
          className={`image-preview-viewport${canPan ? ' image-preview-viewport--pan' : ''}${
            canSwipe ? ' image-preview-viewport--swipe' : ''
          }`}
          onPointerEnter={() => noteChromeActivity(true)}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={(event) => onPointerUp(event, false)}
          onDoubleClick={onDoubleClick}
        >
          <div
            className={`image-preview-slide${swipeSlideClass}`}
            style={{ transform: `translate3d(${swipeOffsetX}px, 0, 0)` }}
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
          {adjacentItem && (
            <div
              className={`image-preview-slide image-preview-slide--adjacent${swipeSlideClass}`}
              style={{ transform: `translate3d(${adjacentOffsetX}px, 0, 0)` }}
              aria-hidden
            >
              <img
                key={adjacentItem.id}
                src={adjacentItem.src}
                alt=""
                className="image-preview-img is-visible"
                draggable={false}
              />
            </div>
          )}
        </div>
        <button
          type="button"
          className="image-preview-hit image-preview-hit--next"
          onClick={goNext}
          onMouseEnter={() => noteChromeActivity(true)}
          onPointerDown={canSwipe ? onPointerDown : undefined}
          onPointerMove={canSwipe ? onPointerMove : undefined}
          onPointerUp={canSwipe ? onPointerUp : undefined}
          onPointerCancel={canSwipe ? (event) => onPointerUp(event, false) : undefined}
          disabled={!canNext}
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
                disabled={loading}
                aria-label={labels.thumb(windowOffset + thumbIndex)}
              >
                <img src={item.thumbnailSrc ?? item.src} alt="" loading="lazy" draggable={false} />
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
