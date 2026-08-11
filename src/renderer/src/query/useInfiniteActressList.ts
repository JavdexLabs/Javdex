import { useEffect, useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import type { ActressListItem, ActressListQuery, ActressListStatusCounts } from '@shared/actressTypes'
import { api } from '../api'
import { flattenActressListPages } from './actressListPages'
import { actressInfiniteQueryOptions } from './actressInfiniteQueryOptions'

const EMPTY_STATUS_COUNTS: ActressListStatusCounts = {
  all: 0,
  success: 0,
  unscraped: 0,
  failed: 0
}

export interface InfiniteActressListResult {
  items: ActressListItem[]
  total: number
  statusCounts: ActressListStatusCounts
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
  const stableQuery = useMemo(() => ({ ...query }), [query])
  const result = useInfiniteQuery(
    actressInfiniteQueryOptions(stableQuery, queryHash, api.actresses.listPage)
  )

  useEffect(() => {
    if (result.isError && result.error) onError(result.error)
  }, [result.isError, result.error, onError])

  const items = useMemo(
    () => flattenActressListPages(result.data?.pages ?? []),
    [result.data]
  )
  const total = result.data?.pages[0]?.total ?? 0

  return {
    items,
    total,
    statusCounts: result.data?.pages[0]?.statusCounts ?? EMPTY_STATUS_COUNTS,
    loading: result.isLoading && items.length === 0,
    loadingMore: result.isFetchingNextPage,
    hasMore: items.length < total,
    nextPageError: result.isFetchNextPageError,
    loadMore: () => {
      if (result.hasNextPage && !result.isFetchingNextPage) void result.fetchNextPage()
    },
    retryLoadMore: () => {
      if (!result.isFetchingNextPage) void result.fetchNextPage()
    },
    isFetching: result.isFetching,
    refetchSilent: () => {
      void result.refetch()
    }
  }
}
