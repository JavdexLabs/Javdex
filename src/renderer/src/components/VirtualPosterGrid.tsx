import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FixedSizeGrid, type GridChildComponentProps } from 'react-window'
import type { Video } from '@shared/types'
import { useElementSize } from '../hooks/useElementSize'
import { useLayoutSpacing } from '../hooks/useLayoutSpacing'
import { resolveScrollTopForKey, setListScroll } from '../listView/listViewMemory'
import ScrollToTopButton, { SCROLL_TO_TOP_THRESHOLD } from './ScrollToTopButton'
import PosterCard from './PosterCard'
import { useDisplayMode } from './DisplayModeContext'
import {
  computePosterGridLayout,
  POSTER_META_HEIGHT
} from '../coverAspect'
import { scrollbarWidth } from '../utils/scrollbar'

const GAP = 12

interface VirtualPosterGridProps {
  videos: Video[]
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  selectedIds?: Set<number>
  selectionMode?: boolean
  onToggleSelect?: (video: Video) => void
  onEdit?: (video: Video) => void
  onAddToPlaylist?: (video: Video) => void
  onScrape?: (video: Video) => void
  onDelete?: (video: Video) => void
  /** Session-only key for scroll restoration (see listViewMemory). */
  scrollMemoryKey?: string
}

/**
 * Windowed poster wall. Only renders visible cells, so tens of thousands of
 * videos scroll smoothly. Column count is derived from container width.
 */
export default function VirtualPosterGrid({
  videos,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  selectedIds = new Set<number>(),
  selectionMode = false,
  onToggleSelect,
  onEdit,
  onAddToPlaylist,
  onScrape,
  onDelete,
  scrollMemoryKey
}: VirtualPosterGridProps): JSX.Element {
  const { pagePadX, cardAreaPadTop, cardAreaPadBottom } = useLayoutSpacing()
  const { ref, width, height } = useElementSize<HTMLDivElement>()
  const { mode } = useDisplayMode()
  const lastSize = useRef({ width: 0, height: 0 })
  const gridRef = useRef<FixedSizeGrid>(null)
  const outerRef = useRef<HTMLDivElement>(null)
  const prevMemoryKeyRef = useRef<string | undefined>(undefined)
  const scrollTopRef = useRef(0)
  const [showScrollToTop, setShowScrollToTop] = useState(false)

  useLayoutEffect(() => {
    if (!scrollMemoryKey) {
      scrollTopRef.current = 0
      prevMemoryKeyRef.current = undefined
      return
    }
    scrollTopRef.current = resolveScrollTopForKey(prevMemoryKeyRef.current, scrollMemoryKey)
    prevMemoryKeyRef.current = scrollMemoryKey
    setShowScrollToTop(scrollTopRef.current > SCROLL_TO_TOP_THRESHOLD)
    gridRef.current?.scrollTo({ scrollTop: scrollTopRef.current })
  }, [scrollMemoryKey])

  if (width > 0 && height > 0) {
    lastSize.current = { width, height }
  }
  const gridWidth = width > 0 ? width : lastSize.current.width
  const layoutWidth = Math.max(0, gridWidth - scrollbarWidth() - pagePadX * 2)
  const layoutHeight = height > 0 ? height : lastSize.current.height

  const { columnCount, columnWidth, widthRemainder, posterHeight } = computePosterGridLayout(
    layoutWidth,
    mode,
    GAP
  )
  const cardHeight = posterHeight + POSTER_META_HEIGHT
  const rowHeight = cardHeight + GAP
  const renderedItemCount = videos.length + (hasMore ? columnCount : 0)
  const rowCount = Math.ceil(renderedItemCount / columnCount)
  const stride = columnWidth + GAP
  const gridHeight = layoutHeight
  const innerHeight = cardAreaPadTop + rowCount * rowHeight + cardAreaPadBottom

  const innerElementType = useMemo(
    () =>
      forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function GridInner(
        { style, ...rest },
        innerRef
      ) {
        return (
          <div
            ref={innerRef}
            style={{ ...style, height: innerHeight, position: 'relative', width: '100%' }}
            {...rest}
          />
        )
      }),
    [innerHeight]
  )

  useLayoutEffect(() => {
    if (gridWidth > 0 && gridHeight > 0) {
      gridRef.current?.scrollTo({ scrollTop: scrollTopRef.current })
    }
  }, [gridWidth, gridHeight])

  const persistScroll = (scrollTop: number, visibleRowIndex?: number): void => {
    scrollTopRef.current = scrollTop
    setShowScrollToTop((prev) => {
      const next = scrollTop > SCROLL_TO_TOP_THRESHOLD
      return prev === next ? prev : next
    })
    if (!scrollMemoryKey) return
    setListScroll(scrollMemoryKey, {
      scrollTop,
      ...(visibleRowIndex !== undefined ? { visibleRowIndex } : {})
    })
  }

  const scrollToTop = (): void => {
    setShowScrollToTop(false)
    const outer = outerRef.current
    if (outer) {
      outer.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    gridRef.current?.scrollTo({ scrollTop: 0 })
    persistScroll(0, 0)
  }

  const Cell = ({ columnIndex, rowIndex, style }: GridChildComponentProps): JSX.Element | null => {
    const index = rowIndex * columnCount + columnIndex
    if (index >= videos.length) {
      if (loadingMore && columnIndex === 0 && index === videos.length) {
        return (
          <div
            className="grid-poster-cell grid-poster-cell--loading"
            style={{
              ...style,
              top: (style.top as number) + cardAreaPadTop,
              left: pagePadX + columnIndex * stride,
              width: columnWidth,
              height: rowHeight,
              paddingBottom: GAP,
              boxSizing: 'border-box'
            }}
          >
            <div className="poster-grid-loading">
              <div className="spinner" />
            </div>
          </div>
        )
      }
      return null
    }
    const video = videos[index]
    const cellWidth =
      columnIndex === columnCount - 1 ? columnWidth + widthRemainder : columnWidth
    return (
      <div
        className="grid-poster-cell"
        style={{
          ...style,
          top: (style.top as number) + cardAreaPadTop,
          left: pagePadX + columnIndex * stride,
          width: cellWidth,
          height: rowHeight,
          paddingBottom: GAP,
          boxSizing: 'border-box'
        }}
      >
        <PosterCard
          video={video}
          thumbHeight={posterHeight}
          selected={selectedIds.has(video.id)}
          selectionMode={selectionMode}
          onToggleSelect={onToggleSelect}
          onEdit={onEdit}
          onAddToPlaylist={onAddToPlaylist}
          onScrape={onScrape}
          onDelete={onDelete}
        />
      </div>
    )
  }

  const renderWidth = gridWidth > 0 ? gridWidth : lastSize.current.width
  const renderHeight = gridHeight > 0 ? gridHeight : lastSize.current.height

  return (
    <div
      ref={ref}
      className="list-scroll-region"
      style={{ flex: 1, minHeight: 0, height: '100%', overflow: 'hidden' }}
    >
      {renderWidth > 0 && renderHeight > 0 && (
        <FixedSizeGrid
          ref={gridRef}
          outerRef={outerRef}
          columnCount={columnCount}
          columnWidth={stride}
          rowCount={rowCount}
          rowHeight={rowHeight}
          width={renderWidth}
          height={renderHeight}
          innerElementType={innerElementType}
          initialScrollTop={scrollTopRef.current}
          onScroll={({ scrollTop }) => {
            persistScroll(scrollTop)
          }}
          onItemsRendered={({ overscanRowStopIndex }) => {
            persistScroll(scrollTopRef.current, overscanRowStopIndex)
            if (hasMore && overscanRowStopIndex >= rowCount - 3) {
              onLoadMore?.()
            }
          }}
          style={{ overflowX: 'hidden', scrollbarGutter: 'stable' }}
        >
          {Cell}
        </FixedSizeGrid>
      )}
      <ScrollToTopButton visible={showScrollToTop} onClick={scrollToTop} />
    </div>
  )
}
