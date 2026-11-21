import ScrollRegion from './ScrollRegion'
import VirtualGridViewport from './VirtualGridViewport'
import styles from './VirtualActressGrid.module.css'
import type { CatalogWindow } from '../query/useWindowedCatalog'
import { forwardRef, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FixedSizeGrid, type GridChildComponentProps } from 'react-window'
import type { ActressCard } from '@shared/cardProjection'
import { useElementSize } from '../hooks/useElementSize'
import { useLayoutSpacing } from '../hooks/useLayoutSpacing'
import { resolvePageForKey, resolveScrollTopForKey, setListScroll } from '../listView/listViewMemory'
import { scrollbarWidth } from '../utils/scrollbar'
import ScrollToTopButton, { SCROLL_TO_TOP_THRESHOLD } from './ScrollToTopButton'
import ActressCardTile from './ActressCardTile'
import ListPagination from './ListPagination'
import { useDisplayMode } from './DisplayModeContext'
import type { ListPageSize } from '@shared/settingsTypes'
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
  const { listLoadMode, listPageSize, persistListPageSize } = useDisplayMode()
  const lastSize = useRef({ width: 0, height: 0 })
  const gridRef = useRef<FixedSizeGrid>(null)
  const outerRef = useRef<HTMLDivElement>(null)
  const previousKey = useRef<string>()
  const scrollTopRef = useRef(0)
  const [page, setPageState] = useState(() => resolvePageForKey(undefined, scrollMemoryKey))
  const [showScrollToTop, setShowScrollToTop] = useState(false)

  useLayoutEffect(() => {
    const prev = previousKey.current
    scrollTopRef.current = resolveScrollTopForKey(prev, scrollMemoryKey)
    setPageState(resolvePageForKey(prev, scrollMemoryKey))
    previousKey.current = scrollMemoryKey
    setShowScrollToTop(scrollTopRef.current > SCROLL_TO_TOP_THRESHOLD)
    gridRef.current?.scrollTo({ scrollTop: scrollTopRef.current })
  }, [scrollMemoryKey])

  if (width > 0 && height > 0) lastSize.current = { width, height }
  const renderWidth = width || lastSize.current.width
  const renderHeight = height || lastSize.current.height
  const layoutWidth = Math.max(0, renderWidth - scrollbarWidth() - pagePadX * 2)
  const { columnCount, cardWidth, columnStride, rowHeight } = computeActressGridLayout(layoutWidth)
  const totalCount = catalogWindow?.total ?? actresses.length
  const isPaged = listLoadMode === 'paged'
  const totalPages = Math.max(1, Math.ceil(totalCount / listPageSize))
  const activePage = isPaged ? Math.min(Math.max(1, page), totalPages) : 1
  const pageOffset = isPaged ? (activePage - 1) * listPageSize : 0
  const pageItemCount = isPaged ? Math.max(0, Math.min(listPageSize, totalCount - pageOffset)) : totalCount
  const showStatusRow = !isPaged && (loadingMore || loadMoreFailed || hasMore)
  const { statusRowStart, renderedCount } = actressGridSlotCount(
    pageItemCount,
    columnCount,
    !catalogWindow && showStatusRow
  )
  const rowCount = Math.ceil(renderedCount / columnCount)
  const innerHeight = cardAreaPadTop + rowCount * rowHeight + cardAreaPadBottom

  const onVisibleRange = catalogWindow?.onVisibleRange
  useLayoutEffect(() => {
    if (!isPaged || !onVisibleRange || pageItemCount <= 0) return
    const visibleRows = Math.max(1, Math.ceil((renderHeight || 600) / rowHeight) + 1)
    const start = Math.min(pageItemCount - 1, Math.floor(scrollTopRef.current / rowHeight) * columnCount)
    const end = Math.min(pageItemCount - 1, start + visibleRows * columnCount - 1)
    onVisibleRange(pageOffset + start, pageOffset + end)
  }, [isPaged, onVisibleRange, pageOffset, pageItemCount, renderHeight, rowHeight, columnCount])

  const innerElementType = useMemo(
    () =>
      forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function GridInner(
        { style, ...props },
        innerRef
      ) {
        // react-window's calculated width must not override the viewport width.
        return (
          <div
            ref={innerRef}
            {...props}
            className={[styles.inner, props.className].filter(Boolean).join(' ')}
            style={{ ...style, height: innerHeight, width: undefined }}
          />
        )
      }),
    [innerHeight]
  )

  const persistScroll = (scrollTop: number, visibleRowIndex?: number, nextPage?: number): void => {
    scrollTopRef.current = scrollTop
    setShowScrollToTop(scrollTop > SCROLL_TO_TOP_THRESHOLD)
    setListScroll(scrollMemoryKey, {
      scrollTop,
      ...(visibleRowIndex == null ? {} : { visibleRowIndex }),
      ...(nextPage === undefined ? {} : { page: nextPage })
    })
  }

  const changePage = (nextPage: number): void => {
    const clamped = Math.min(totalPages, Math.max(1, nextPage))
    setPageState(clamped)
    setShowScrollToTop(false)
    outerRef.current?.scrollTo({ top: 0 })
    gridRef.current?.scrollTo({ scrollTop: 0 })
    persistScroll(0, 0, clamped)
  }

  const changePageSize = (nextSize: ListPageSize): void => {
    const nextPage = Math.floor(pageOffset / nextSize) + 1
    setPageState(nextPage)
    setShowScrollToTop(false)
    outerRef.current?.scrollTo({ top: 0 })
    gridRef.current?.scrollTo({ scrollTop: 0 })
    persistScroll(0, 0, nextPage)
    void persistListPageSize(nextSize)
  }

  const Cell = ({ columnIndex, rowIndex, style }: GridChildComponentProps): JSX.Element | null => {
    const localIndex = rowIndex * columnCount + columnIndex
    if (localIndex >= renderedCount) return null
    const index = pageOffset + localIndex
    const cellStyle = {
      ...style,
      top: (style.top as number) + cardAreaPadTop,
      left: pagePadX + columnIndex * columnStride,
      width: cardWidth,
      height: rowHeight,
      paddingBottom: ACTRESS_GRID_GAP
    }
    const windowActress = catalogWindow?.getItem(index)
    if (catalogWindow && !windowActress) {
      if (index >= catalogWindow.total) return null
      return <div className={styles.cell} style={cellStyle}>{catalogWindow.error
        ? <Button size="sm" onClick={catalogWindow.retry}>加载失败，重试</Button>
        : <Spinner aria-label="正在加载演员" />}</div>
    }
    if (!catalogWindow && localIndex >= pageItemCount) {
      if (columnIndex !== 0 || localIndex !== statusRowStart) return null
      return (
        <div className={`${styles.cell} ${styles.status}`} style={cellStyle}>
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
    if (!actress) return null
    return (
      <div className={styles.cell} style={cellStyle}>
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
    <div className={styles.shell}>
      <ScrollRegion ref={ref} className={styles.root}>
        {renderWidth > 0 && renderHeight > 0 ? (
          <FixedSizeGrid
            ref={gridRef}
            outerRef={outerRef}
            outerElementType={VirtualGridViewport}
            columnCount={columnCount}
            columnWidth={columnStride}
            rowCount={rowCount}
            rowHeight={rowHeight}
            width={renderWidth}
            height={renderHeight}
            innerElementType={innerElementType}
            initialScrollTop={scrollTopRef.current}
            onScroll={({ scrollTop }) => persistScroll(scrollTop)}
            onItemsRendered={({ overscanRowStartIndex, overscanRowStopIndex }) => {
              persistScroll(scrollTopRef.current, overscanRowStopIndex)
              if (renderedCount > 0) {
                catalogWindow?.onVisibleRange(
                  pageOffset + overscanRowStartIndex * columnCount,
                  pageOffset + Math.min(renderedCount - 1, (overscanRowStopIndex + 1) * columnCount - 1)
                )
              }
              if (!isPaged && !catalogWindow && hasMore && !loadMoreFailed && overscanRowStopIndex >= rowCount - 3) onLoadMore()
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
      </ScrollRegion>
      {isPaged && totalCount > 0 ? (
        <ListPagination
          label="演员列表分页"
          page={activePage}
          pageSize={listPageSize}
          total={totalCount}
          onPageChange={changePage}
          onPageSizeChange={changePageSize}
        />
      ) : null}
    </div>
  )
}
