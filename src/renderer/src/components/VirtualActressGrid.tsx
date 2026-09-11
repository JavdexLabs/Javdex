import type { CatalogWindow } from '../query/useWindowedCatalog'
import { forwardRef, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FixedSizeGrid, type GridChildComponentProps } from 'react-window'
import type { ActressCard } from '@shared/cardProjection'
import { useElementSize } from '../hooks/useElementSize'
import { useLayoutSpacing } from '../hooks/useLayoutSpacing'
import { resolveScrollTopForKey, setListScroll } from '../listView/listViewMemory'
import { scrollbarWidth } from '../utils/scrollbar'
import ScrollToTopButton, { SCROLL_TO_TOP_THRESHOLD } from './ScrollToTopButton'
import ActressCardTile from './ActressCardTile'
import {
  ACTRESS_GRID_GAP,
  actressGridSlotCount,
  computeActressGridLayout
} from './actressGridLayout'
import Button from './Button'
import Spinner from './Spinner'

interface VirtualActressGridProps {
  catalogWindow?: CatalogWindow<ActressCard>
  actresses: ActressCard[]
  selectedIds: Set<number>
  selectionMode: boolean
  hasMore: boolean
  loadingMore: boolean
  loadMoreFailed: boolean
  onLoadMore: () => void
  onRetryLoadMore: () => void
  onToggleSelect: (actress: ActressCard, index: number, event: React.MouseEvent) => void
  onOpen: (actress: ActressCard) => void
  onDelete: (actress: ActressCard) => void
  scrollMemoryKey: string
}

export default function VirtualActressGrid({
  actresses,
  catalogWindow,
  selectedIds,
  selectionMode,
  hasMore,
  loadingMore,
  loadMoreFailed,
  onLoadMore,
  onRetryLoadMore,
  onToggleSelect,
  onOpen,
  onDelete,
  scrollMemoryKey
}: VirtualActressGridProps): JSX.Element {
  const { pagePadX, cardAreaPadTop, cardAreaPadBottom } = useLayoutSpacing()
  const { ref, width, height } = useElementSize<HTMLDivElement>()
  const lastSize = useRef({ width: 0, height: 0 })
  const gridRef = useRef<FixedSizeGrid>(null)
  const outerRef = useRef<HTMLDivElement>(null)
  const previousKey = useRef<string>()
  const scrollTopRef = useRef(0)
  const [showScrollToTop, setShowScrollToTop] = useState(false)

  useLayoutEffect(() => {
    scrollTopRef.current = resolveScrollTopForKey(previousKey.current, scrollMemoryKey)
    previousKey.current = scrollMemoryKey
    setShowScrollToTop(scrollTopRef.current > SCROLL_TO_TOP_THRESHOLD)
    gridRef.current?.scrollTo({ scrollTop: scrollTopRef.current })
  }, [scrollMemoryKey])

  if (width > 0 && height > 0) lastSize.current = { width, height }
  const renderWidth = width || lastSize.current.width
  const renderHeight = height || lastSize.current.height
  const layoutWidth = Math.max(0, renderWidth - scrollbarWidth() - pagePadX * 2)
  const { columnCount, cardWidth, columnStride, rowHeight } = computeActressGridLayout(layoutWidth)
  const showStatusRow = loadingMore || loadMoreFailed || hasMore
  const { statusRowStart, renderedCount } = actressGridSlotCount(
    catalogWindow?.total ?? actresses.length,
    columnCount,
    !catalogWindow && showStatusRow
  )
  const rowCount = Math.ceil(renderedCount / columnCount)
  const innerHeight = cardAreaPadTop + rowCount * rowHeight + cardAreaPadBottom

  const innerElementType = useMemo(
    () =>
      forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function GridInner(
        { style, ...props },
        innerRef
      ) {
        return (
          <div
            ref={innerRef}
            style={{ ...style, height: innerHeight, position: 'relative', width: '100%' }}
            {...props}
          />
        )
      }),
    [innerHeight]
  )

  const persistScroll = (scrollTop: number, visibleRowIndex?: number): void => {
    scrollTopRef.current = scrollTop
    setShowScrollToTop(scrollTop > SCROLL_TO_TOP_THRESHOLD)
    setListScroll(scrollMemoryKey, {
      scrollTop,
      ...(visibleRowIndex == null ? {} : { visibleRowIndex })
    })
  }

  const Cell = ({ columnIndex, rowIndex, style }: GridChildComponentProps): JSX.Element | null => {
    const index = rowIndex * columnCount + columnIndex
    const cellStyle = {
      ...style,
      top: (style.top as number) + cardAreaPadTop,
      left: pagePadX + columnIndex * columnStride,
      width: cardWidth,
      height: rowHeight,
      paddingBottom: ACTRESS_GRID_GAP,
      boxSizing: 'border-box' as const
    }
    const windowActress = catalogWindow?.getItem(index)
    if (catalogWindow && !windowActress) {
      if (index >= catalogWindow.total) return null
      return <div style={cellStyle}>{catalogWindow.error
        ? <Button size="sm" onClick={catalogWindow.retry}>加载失败，重试</Button>
        : <Spinner aria-label="正在加载演员" />}</div>
    }
    if (!catalogWindow && index >= actresses.length) {
      if (columnIndex !== 0 || index !== statusRowStart) return null
      return (
        <div className="virtual-actress-grid-status" style={cellStyle}>
          {loadMoreFailed ? (
            <Button type="button" size="sm" onClick={onRetryLoadMore}>
              加载失败，重试
            </Button>
          ) : loadingMore ? (
            <Spinner aria-label="正在加载更多演员" />
          ) : null}
        </div>
      )
    }
    const actress = windowActress ?? actresses[index]
    return (
      <div className="virtual-actress-grid-cell" style={cellStyle}>
        <ActressCardTile
          actress={actress}
          selected={selectedIds.has(actress.id)}
          selectionMode={selectionMode}
          onToggleSelect={(event) => onToggleSelect(actress, index, event)}
          onOpen={() => onOpen(actress)}
          onDelete={() => onDelete(actress)}
        />
      </div>
    )
  }

  return (
    <div ref={ref} className="list-scroll-region virtual-actress-grid">
      {renderWidth > 0 && renderHeight > 0 ? (
        <FixedSizeGrid
          ref={gridRef}
          outerRef={outerRef}
          columnCount={columnCount}
          columnWidth={columnStride}
          rowCount={rowCount}
          rowHeight={rowHeight}
          width={renderWidth}
          height={renderHeight}
          innerElementType={innerElementType}
          className="virtual-actress-grid-scroller"
          initialScrollTop={scrollTopRef.current}
          onScroll={({ scrollTop }) => persistScroll(scrollTop)}
          onItemsRendered={({ overscanRowStartIndex, overscanRowStopIndex }) => {
            persistScroll(scrollTopRef.current, overscanRowStopIndex)
            catalogWindow?.onVisibleRange(overscanRowStartIndex * columnCount, Math.min(renderedCount - 1, (overscanRowStopIndex + 1) * columnCount - 1))
            if (!catalogWindow && hasMore && !loadMoreFailed && overscanRowStopIndex >= rowCount - 3) onLoadMore()
          }}
        >
          {Cell}
        </FixedSizeGrid>
      ) : null}
      <ScrollToTopButton
        visible={showScrollToTop}
        onClick={() => {
          outerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
          persistScroll(0, 0)
        }}
      />
    </div>
  )
}
