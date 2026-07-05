import type { VideoQuery } from '@shared/types'
import { libraryQueryHash } from '../listView/listQueryParams'

export const videoKeys = {
  all: ['videos'] as const,
  list: (query: VideoQuery, queryHash: string) => ['videos', 'list', queryHash, query] as const,
  listFromParams: (params: URLSearchParams) =>
    ['videos', 'list', libraryQueryHash(params)] as const,
  detail: (id: number) => ['videos', 'detail', id] as const
}

export const actressKeys = {
  all: ['actresses'] as const,
  list: (queryHash: string, search: string, gender: string, sortBy: string, sortDir: string) =>
    ['actresses', 'list', queryHash, search, gender, sortBy, sortDir] as const
}

export const facetKeys = {
  all: ['facets'] as const,
  list: (type: string, queryHash: string) => ['facets', 'list', type, queryHash] as const
}

export const overviewStatsKeys = {
  all: ['settings', 'overviewStats'] as const,
  detail: (refreshKey = 0) => ['settings', 'overviewStats', refreshKey] as const
}
