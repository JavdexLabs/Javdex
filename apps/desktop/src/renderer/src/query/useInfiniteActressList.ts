import { useEffect } from 'react'
import { useWindowedCatalog, type CatalogWindow } from './useWindowedCatalog'
import { actressKeys } from './queryKeys'
import type { ActressListQuery, ActressListStatusCounts } from '@shared/actressTypes'
import { toActressCardPage, type ActressCard, type ActressCardPage } from '@shared/cardProjection'
import { api } from '../api'

const EMPTY_STATUS_COUNTS: ActressListStatusCounts = {
  all: 0,
  success: 0,
  unscraped: 0,
  failed: 0
}

export interface InfiniteActressListResult {
  window: CatalogWindow<ActressCard>
  items: ActressCard[]
  total: number
  statusCounts: ActressListStatusCounts
  error: unknown
  retry: () => void
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  nextPageError: boolean
  loadMore: () => void
  retryLoadMore: () => void
  isFetching: boolean
  refetchSilent: () => void
}

export function useInfiniteActressList(
  query: ActressListQuery,
  queryHash: string,
  onError: (error: unknown) => void
): InfiniteActressListResult {
  const result = useWindowedCatalog<ActressCard, ActressCardPage>(
    actressKeys.list(query, queryHash), 240,
    async offset => toActressCardPage(await api.actresses.listPage({ ...query, limit: 240, offset }))
  )
  useEffect(() => { if (result.error) onError(result.error) }, [result.error, onError])
  return { ...result, statusCounts: result.page?.statusCounts ?? EMPTY_STATUS_COUNTS,
    loadingMore: result.isFetching && !result.loading, nextPageError: Boolean(result.error), retryLoadMore: result.retry }
}
