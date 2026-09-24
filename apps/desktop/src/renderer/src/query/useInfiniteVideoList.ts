import { useWindowedCatalog, type CatalogWindow } from './useWindowedCatalog'
import { useEffect } from 'react'
import { toScopedVideoCardPage, type ScopedVideoCard, type ScopedVideoCardPage } from '@shared/cardProjection'
import type { CatalogScope } from '@shared/mediaLibraryTypes'
import { VIDEO_LIST_PAGE_LIMIT_MAX, type VideoQuery } from '@shared/videoTypes'
import { api } from '../api'
import { videoKeys } from './queryKeys'

export interface InfiniteVideoListResult {
  window: CatalogWindow<ScopedVideoCard>
  videos: ScopedVideoCard[]
  total: number
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  loadMore: () => void
  isFetching: boolean
  refetchSilent: () => void
}

export function useInfiniteVideoList(
  scope: CatalogScope,
  query: VideoQuery,
  queryHash: string,
  onError: (error: unknown) => void,
  enabled = true
): InfiniteVideoListResult {
  const result = useWindowedCatalog<ScopedVideoCard, ScopedVideoCardPage>(
    videoKeys.list(scope, query, queryHash), VIDEO_LIST_PAGE_LIMIT_MAX,
    async offset => toScopedVideoCardPage(await api.videos.list(scope, { ...query, limit: VIDEO_LIST_PAGE_LIMIT_MAX, offset })), enabled
  )
  useEffect(() => { if (result.error) onError(result.error) }, [result.error, onError])
  return { ...result, videos: result.items, loadingMore: result.isFetching && !result.loading }
}
