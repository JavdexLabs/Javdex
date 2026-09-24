import { useQuery } from '@tanstack/react-query'
import type { LibraryOverviewStats } from '@shared/libraryTypes'
import { api } from '../api'
import { overviewStatsKeys } from '../query/queryKeys'
import { useDesktopSession } from '../desktop/DesktopSessionContext'

export function useLibraryOverviewStats(refreshKey = 0, enabled = true): {
  stats: LibraryOverviewStats | undefined
  isLoading: boolean
  refetch: () => void
} {
  const { catalogReadsEnabled } = useDesktopSession()
  const query = useQuery({
    queryKey: overviewStatsKeys.detail(refreshKey),
    queryFn: () => api.settings.getOverviewStats(),
    enabled: enabled && catalogReadsEnabled,
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
