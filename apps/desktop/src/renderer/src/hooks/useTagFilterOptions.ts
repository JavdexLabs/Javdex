import { api } from '../api'
import { useContinuousPage } from './useContinuousPage'
export function useTagFilterOptions(open: boolean, search: string) {
  const result = useContinuousPage(search, 100,
    offset => api.tags.filterOptions({ search, offset, limit: 100 }), open)
  return { ...result, hasMore: Boolean(result.known && result.items.length < result.total) }
}
