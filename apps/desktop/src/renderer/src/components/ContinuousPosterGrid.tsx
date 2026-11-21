import { useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { VideoCard } from '@shared/videoTypes'
import type { ListPageSize } from '@shared/settingsTypes'
import type { ContinuousWindow } from '../hooks/useContinuousPage'
import ContinuousGrid from './ContinuousGrid'
import { useDetailFooterHost } from './DetailFooterContext'
import ListPagination from './ListPagination'
import PosterCard from './PosterCard'
import { useDisplayMode } from './DisplayModeContext'
import {
  getPosterMinColWidth,
  PORTRAIT_HEIGHT_PER_WIDTH,
  LANDSCAPE_HEIGHT_PER_WIDTH,
  POSTER_META_HEIGHT
} from '../coverAspect'

export default function ContinuousPosterGrid<T extends VideoCard>({ window, scope, onOpen, onRemove, removeDisabled, initialIndex, onAnchor }: {
  window: ContinuousWindow<T>; scope: string; onRemove?: (video: T) => void; removeDisabled?: boolean; initialIndex: number; onAnchor: (index: number) => void
  onOpen?: (video: T) => void
}): JSX.Element {
  const { mode, coverSize, listLoadMode, listPageSize, persistListPageSize } = useDisplayMode()
  const footerHost = useDetailFooterHost()
  const isPaged = listLoadMode === 'paged'
  const totalPages = Math.max(1, Math.ceil(window.total / listPageSize))
  const rawPage = Math.floor(initialIndex / listPageSize) + 1
  const activePage = isPaged ? Math.min(Math.max(1, rawPage), totalPages) : 1
  const pageOffset = isPaged ? (activePage - 1) * listPageSize : 0
  const pageItemCount = isPaged ? Math.max(0, Math.min(listPageSize, window.total - pageOffset)) : window.total

  const effectiveWindow = useMemo<ContinuousWindow<T>>(() => {
    if (!isPaged) return window
    return {
      ...window,
      total: pageItemCount,
      getItem: (localIndex: number) =>
        localIndex >= 0 && localIndex < pageItemCount
          ? window.getItem(pageOffset + localIndex)
          : undefined,
      findIndex: (predicate: (item: T) => boolean) => {
        const found = window.findIndex(predicate)
        return found >= pageOffset && found < pageOffset + pageItemCount ? found - pageOffset : -1
      },
      onVisibleRange: (start: number, end: number) => {
        if (pageItemCount > 0) {
          window.onVisibleRange(
            pageOffset + Math.max(0, start),
            pageOffset + Math.min(pageItemCount - 1, Math.max(0, end))
          )
        }
      }
    }
  }, [isPaged, pageItemCount, pageOffset, window])

  const changePage = (nextPage: number): void => {
    const clamped = Math.min(totalPages, Math.max(1, nextPage))
    const nextOffset = (clamped - 1) * listPageSize
    onAnchor(nextOffset)
  }

  const changePageSize = (nextSize: ListPageSize): void => {
    void persistListPageSize(nextSize)
  }

  const minWidth = getPosterMinColWidth(mode, coverSize, 'detail')
  const pagination = isPaged && window.total > 0 ? (
    <ListPagination
      inline={!footerHost}
      label="关联影片分页"
      page={activePage}
      pageSize={listPageSize}
      total={window.total}
      onPageChange={changePage}
      onPageSizeChange={changePageSize}
    />
  ) : null

  return (
    <>
      <ContinuousGrid
        window={effectiveWindow}
        scope={isPaged ? `${scope}:paged:${activePage}:${listPageSize}` : scope}
        initialIndex={isPaged ? 0 : initialIndex}
        onAnchor={isPaged ? undefined : index => onAnchor(Math.floor(index / 60) * 60)}
        pageSize={isPaged ? undefined : 60}
        label="影片"
        itemKey={video => video.id}
        minWidth={minWidth}
        itemHeight={width => width * (mode === 'portrait' ? PORTRAIT_HEIGHT_PER_WIDTH : LANDSCAPE_HEIGHT_PER_WIDTH) + POSTER_META_HEIGHT}
        renderItem={video => <PosterCard video={video} onOpen={onOpen} onRemove={onRemove ? () => onRemove(video) : undefined} removeDisabled={removeDisabled} />}
      />
      {pagination ? (footerHost ? createPortal(pagination, footerHost) : pagination) : null}
    </>
  )
}
