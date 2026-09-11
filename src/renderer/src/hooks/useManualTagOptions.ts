import { api } from '../api'
import { useContinuousPage } from './useContinuousPage'
export function useManualTagOptions(open: boolean, videoId: number, search: string, offset: number, retry: number) {
  const result = useContinuousPage(JSON.stringify([videoId, search, retry]), 100,
    offset => api.tags.manualOptions({ search, offset, limit: 100 }), open, offset)
  return { ...result, hasMore: result.page?.hasMore ?? false }
}
