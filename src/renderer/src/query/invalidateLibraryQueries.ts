import type { QueryClient } from '@tanstack/react-query'
import { actressKeys, facetKeys, overviewStatsKeys, videoKeys } from './queryKeys'

/** Invalidate list queries and overview counters after library mutations (scrape, edit, scan). */
export function invalidateVideoLibraryQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: videoKeys.all })
  void queryClient.invalidateQueries({ queryKey: facetKeys.all })
  void queryClient.invalidateQueries({ queryKey: overviewStatsKeys.all })
}

export function invalidateActressLibraryQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: actressKeys.all })
  void queryClient.invalidateQueries({ queryKey: overviewStatsKeys.all })
}

/** Full library resync after scan or mixed batch operations. */
export function invalidateAllLibraryQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: videoKeys.all })
  void queryClient.invalidateQueries({ queryKey: actressKeys.all })
  void queryClient.invalidateQueries({ queryKey: facetKeys.all })
  void queryClient.invalidateQueries({ queryKey: overviewStatsKeys.all })
}

/** Refetch stale library queries when a list surface becomes visible again. */
export function refetchStaleLibraryQueries(queryClient: QueryClient): void {
  void queryClient.refetchQueries({ queryKey: videoKeys.all, type: 'all', stale: true })
  void queryClient.refetchQueries({ queryKey: actressKeys.all, type: 'all', stale: true })
  void queryClient.refetchQueries({ queryKey: facetKeys.all, type: 'all', stale: true })
  void queryClient.refetchQueries({ queryKey: overviewStatsKeys.all, type: 'all', stale: true })
}
