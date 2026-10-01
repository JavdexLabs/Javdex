import ScrollRegion from './ScrollRegion'
import VirtualGridViewport from './VirtualGridViewport'
import styles from './VirtualPosterGrid.module.css'
import type { CatalogWindow } from '../query/useWindowedCatalog'
import Button from './Button'
import { forwardRef, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FixedSizeGrid, type GridChildComponentProps } from 'react-window'
import type { VideoCard } from '@shared/videoTypes'
import Spinner from './Spinner'
import { useElementSize } from '../hooks/useElementSize'
import { useLayoutSpacing } from '../hooks/useLayoutSpacing'
import { resolveScrollTopForKey, setListScroll } from '../listView/listViewMemory'
import ScrollToTopButton, { SCROLL_TO_TOP_THRESHOLD } from './ScrollToTopButton'
import PosterCard from './PosterCard'
import ScopedPosterCard from './ScopedPosterCard'
import type { ScopedVideoCard } from '@shared/cardProjection'
import { useDisplayMode } from './DisplayModeContext'
import {
  computePosterGridLayout,
  computePosterGridRowHeight
} from '../coverAspect'
import { scrollbarWidth } from '../utils/scrollbar'

const GAP = 12

function isScopedVideo(video: VideoCard): video is ScopedVideoCard {
  const candidate = video as Partial<ScopedVideoCard>
  return (
    Number.isSafeInteger(candidate.preferredLibraryId) &&
    Array.isArray(candidate.libraries)
  )
}

interface VirtualPosterGridProps<TVideo extends VideoCard> {
  catalogWindow?: CatalogWindow<TVideo>
  videos: TVideo[]
  detailLibraryId?: number
  detailLibraryIds?: ReadonlyMap<number, number>
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  selectedIds?: Set<number>
  selectionMode?: boolean
  onToggleSelect?: (video: TVideo, index: number, event?: React.MouseEvent) => void
  onEdit?: (video: TVideo) => void
  builtinActions?: 'all' | 'watch'
  onAddToPlaylist?: (video: TVideo) => void
  onScrape?: (video: TVideo) => void
  onMarkScrapeSuccess?: (video: TVideo) => void
  onDelete?: (video: TVideo) => void
  deleteLabel?: string
  /** Show the bounded cross-library membership strip returned by global catalog projections. */
  showLibraryBadges?: boolean
  /** Session-only key for scroll restoration (see listViewMemory). */
  scrollMemoryKey?: string
}

/**
 * Windowed poster wall. Only renders visible cells, so tens of thousands of
 * videos scroll smoothly. Column count is derived from container width.
 */
export default function VirtualPosterGrid<TVideo extends VideoCard>({
  videos,
  catalogWindow,
  detailLibraryId,
  detailLibraryIds,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  selectedIds = new Set<number>(),
  selectionMode = false,
  onToggleSelect,
  onEdit,
  builtinActions,
  onAddToPlaylist,
  onScrape,
  onMarkScrapeSuccess,
  onDelete,
  deleteLabel,
  showLibraryBadges = false,
  scrollMemoryKey
}: VirtualPosterGridProps<TVideo>): JSX.Element {
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
  const rowHeight = computePosterGridRowHeight(posterHeight, {
    gap: GAP,
    showLibraryBadges
  })
  const renderedItemCount = catalogWindow?.total ?? (videos.length + (hasMore ? columnCount : 0))
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
        // react-window's calculated width must not override the viewport width.
        return (
          <div
            ref={innerRef}
            {...rest}
            className={[styles.inner, rest.className].filter(Boolean).join(' ')}
            style={{ ...style, height: innerHeight, width: undefined }}
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
    const windowVideo = catalogWindow?.getItem(index)
    if (catalogWindow && !windowVideo) {
      if (index >= catalogWindow.total) return null
      return <div style={{ ...style, top: Number(style.top) + cardAreaPadTop, left: pagePadX + columnIndex * stride, width: columnWidth }}>
        {catalogWindow.error ? <Button size="sm" onClick={catalogWindow.retry}>加载失败，重试</Button> : <Spinner aria-label="正在加载影片" />}
      </div>
    }
    if (!catalogWindow && index >= videos.length) {
      if (loadingMore && columnIndex === 0 && index === videos.length) {
        return (
          <div
            className={styles.cell}
            style={{
              ...style,
              top: (style.top as number) + cardAreaPadTop,
              left: pagePadX + columnIndex * stride,
              width: columnWidth,
              height: rowHeight,
              paddingBottom: GAP
            }}
          >
            <div className={styles.loading}>
              <Spinner />
            </div>
          </div>
        )
      }
      return null
    }
    const video = windowVideo ?? videos[index]
    const cellWidth =
      columnIndex === columnCount - 1 ? columnWidth + widthRemainder : columnWidth
    return (
      <div
        className={styles.cell}
        style={{
          ...style,
          top: (style.top as number) + cardAreaPadTop,
          left: pagePadX + columnIndex * stride,
          width: cellWidth,
          height: rowHeight,
          paddingBottom: GAP
        }}
      >
        {showLibraryBadges && isScopedVideo(video) ? (
          <ScopedPosterCard
            video={video}
            thumbHeight={posterHeight}
            selected={selectedIds.has(video.id)}
            selectionMode={selectionMode}
            onToggleSelect={
              onToggleSelect
                ? (_selectedVideo, event) => onToggleSelect(video, index, event)
                : undefined
            }
            onEdit={onEdit ? () => onEdit(video) : undefined}
            builtinActions={builtinActions}
            onAddToPlaylist={onAddToPlaylist ? () => onAddToPlaylist(video) : undefined}
            onScrape={onScrape ? () => onScrape(video) : undefined}
            onMarkScrapeSuccess={
              onMarkScrapeSuccess ? () => onMarkScrapeSuccess(video) : undefined
            }
            onDelete={onDelete ? () => onDelete(video) : undefined}
            deleteLabel={deleteLabel}
          />
        ) : (
          <PosterCard
            className={styles.card}
            video={video}
            detailLibraryId={detailLibraryIds?.get(video.id) ?? detailLibraryId}
            thumbHeight={posterHeight}
            selected={selectedIds.has(video.id)}
            selectionMode={selectionMode}
            onToggleSelect={
              onToggleSelect
                ? (_selectedVideo, event) => onToggleSelect(video, index, event)
                : undefined
            }
            onEdit={onEdit ? () => onEdit(video) : undefined}
            builtinActions={builtinActions}
            onAddToPlaylist={onAddToPlaylist ? () => onAddToPlaylist(video) : undefined}
            onScrape={onScrape ? () => onScrape(video) : undefined}
            onMarkScrapeSuccess={
              onMarkScrapeSuccess ? () => onMarkScrapeSuccess(video) : undefined
            }
            onDelete={onDelete ? () => onDelete(video) : undefined}
            deleteLabel={deleteLabel}
          />
        )}
      </div>
    )
  }

  const renderWidth = gridWidth > 0 ? gridWidth : lastSize.current.width
  const renderHeight = gridHeight > 0 ? gridHeight : lastSize.current.height

  return (
    <ScrollRegion
      ref={ref}
      className={styles.root}
    >
      {renderWidth > 0 && renderHeight > 0 && (
        <FixedSizeGrid
          ref={gridRef}
          outerRef={outerRef}
          outerElementType={VirtualGridViewport}
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
          onItemsRendered={({ overscanRowStartIndex, overscanRowStopIndex }) => {
            persistScroll(scrollTopRef.current, overscanRowStopIndex)
            catalogWindow?.onVisibleRange(overscanRowStartIndex * columnCount, Math.min(renderedItemCount - 1, (overscanRowStopIndex + 1) * columnCount - 1))
            if (!catalogWindow && hasMore && overscanRowStopIndex >= rowCount - 3) {
              onLoadMore?.()
            }
          }}
        >
          {Cell}
        </FixedSizeGrid>
      )}
      <ScrollToTopButton visible={showScrollToTop} onClick={scrollToTop} />
    </ScrollRegion>
  )
}
