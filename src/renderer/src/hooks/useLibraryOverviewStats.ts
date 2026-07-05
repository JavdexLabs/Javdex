import { useQuery } from '@tanstack/react-query'
import type { LibraryOverviewStats } from '@shared/types'
import { api } from '../api'
import { overviewStatsKeys } from '../query/queryKeys'

export function useLibraryOverviewStats(refreshKey = 0): {
  stats: LibraryOverviewStats | undefined
  isLoading: boolean
  refetch: () => void
} {
  const query = useQuery({
    queryKey: overviewStatsKeys.detail(refreshKey),
    queryFn: () => api.settings.getOverviewStats(),
    staleTime: 5_000
  })

  return {
    stats: query.data,
    isLoading: query.isLoading,
    refetch: () => {
      void query.refetch()
    }
  }
}
