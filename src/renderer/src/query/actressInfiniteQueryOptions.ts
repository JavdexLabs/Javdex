import { infiniteQueryOptions } from '@tanstack/react-query'
import type {
  ActressListItem,
  ActressListQuery,
  ActressListStatusCounts
} from '@shared/types'
import { nextActressPageOffset } from './actressListPages'
import { actressKeys } from './queryKeys'

const PAGE_SIZE = 240

export type FetchActressListPage = (query: ActressListQuery) => Promise<{
  items: ActressListItem[]
  total: number
  statusCounts: ActressListStatusCounts
}>

export function actressInfiniteQueryOptions(
  query: ActressListQuery,
  queryHash: string,
  fetchPage: FetchActressListPage
) {
  return infiniteQueryOptions({
    queryKey: actressKeys.list(query, queryHash),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchPage({
        ...query,
        limit: PAGE_SIZE,
        offset: typeof pageParam === 'number' ? pageParam : 0
      }),
    getNextPageParam: (_lastPage, pages) => nextActressPageOffset(pages)
  })
}
