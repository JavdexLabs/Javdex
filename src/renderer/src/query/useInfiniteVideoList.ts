import { useInfiniteQuery } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import type { Video, VideoQuery } from '@shared/types'
import { api } from '../api'
import { videoKeys } from './queryKeys'

const PAGE_SIZE = 240

export interface InfiniteVideoListResult {
  videos: Video[]
  total: number
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  loadMore: () => void
  isFetching: boolean
  refetchSilent: () => void
}

export function useInfiniteVideoList(
  query: VideoQuery,
  queryHash: string,
  onError: (error: unknown) => void,
  enabled = true
): InfiniteVideoListResult {
  const stableQuery = useMemo(() => ({ ...query }), [queryHash, query])

  const result = useInfiniteQuery({
    queryKey: videoKeys.list(stableQuery, queryHash),
    enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const offset = typeof pageParam === 'number' ? pageParam : 0
      return api.videos.list({ ...stableQuery, limit: PAGE_SIZE, offset })
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0)
      return loaded < lastPage.total ? loaded : undefined
    },
    placeholderData: (prev) => prev
  })

  useEffect(() => {
    if (result.isError && result.error) onError(result.error)
  }, [result.isError, result.error, onError])

  const videos = useMemo(
    () => result.data?.pages.flatMap((p) => p.items) ?? [],
    [result.data]
  )
  const total = result.data?.pages[0]?.total ?? 0
  const loading = result.isLoading && videos.length === 0
  const loadingMore = result.isFetchingNextPage
  const hasMore = videos.length < total

  return {
    videos,
    total,
    loading,
    loadingMore,
    hasMore,
    loadMore: () => {
      if (result.hasNextPage && !result.isFetchingNextPage) void result.fetchNextPage()
    },
    isFetching: result.isFetching,
    refetchSilent: () => {
      void result.refetch()
    }
  }
}
