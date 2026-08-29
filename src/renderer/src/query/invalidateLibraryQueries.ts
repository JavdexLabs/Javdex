import type { QueryClient } from '@tanstack/react-query'
import {
  actressKeys,
  directorKeys,
  homeKeys,
  mediaLibraryKeys,
  organizationKeys,
  overviewStatsKeys,
  seriesKeys,
  videoKeys
} from './queryKeys'

/** Invalidate list queries and overview counters after library mutations (scrape, edit, scan). */
export function invalidateVideoLibraryQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: videoKeys.all })
  void queryClient.invalidateQueries({ queryKey: organizationKeys.all })
  void queryClient.invalidateQueries({ queryKey: directorKeys.all })
  void queryClient.invalidateQueries({ queryKey: seriesKeys.all })
  void queryClient.invalidateQueries({ queryKey: overviewStatsKeys.all })
  void queryClient.invalidateQueries({ queryKey: homeKeys.all })
  void queryClient.invalidateQueries({ queryKey: mediaLibraryKeys.all })
}

export async function invalidateActressLibraryQueries(queryClient: QueryClient): Promise<void> {
  // The face manifest is deliberately disabled on ordinary actress pages.
  // Reset its cached data so the next without-face workflow explicitly reloads it.
  await Promise.all([
    queryClient.resetQueries({ queryKey: actressKeys.faceScanManifest(), exact: true }),
    queryClient.invalidateQueries({ queryKey: actressKeys.all }),
    queryClient.invalidateQueries({ queryKey: overviewStatsKeys.all })
  ])
}

/** Full library resync after scan or mixed batch operations. */
export function invalidateAllLibraryQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: videoKeys.all })
  void queryClient.invalidateQueries({ queryKey: ['pending-scan-groups'] })
  void queryClient.resetQueries({ queryKey: actressKeys.faceScanManifest(), exact: true })
  void queryClient.invalidateQueries({ queryKey: actressKeys.all })
  void queryClient.invalidateQueries({ queryKey: organizationKeys.all })
  void queryClient.invalidateQueries({ queryKey: directorKeys.all })
  void queryClient.invalidateQueries({ queryKey: seriesKeys.all })
  void queryClient.invalidateQueries({ queryKey: overviewStatsKeys.all })
  void queryClient.invalidateQueries({ queryKey: homeKeys.all })
  void queryClient.invalidateQueries({ queryKey: mediaLibraryKeys.all })
}

/** Refetch stale library queries when a list surface becomes visible again. */
export function refetchStaleLibraryQueries(queryClient: QueryClient): void {
  void queryClient.refetchQueries({ queryKey: videoKeys.all, type: 'all', stale: true })
  void queryClient.refetchQueries({ queryKey: actressKeys.all, type: 'all', stale: true })
  void queryClient.refetchQueries({ queryKey: organizationKeys.all, type: 'all', stale: true })
  void queryClient.refetchQueries({ queryKey: directorKeys.all, type: 'all', stale: true })
  void queryClient.refetchQueries({ queryKey: seriesKeys.all, type: 'all', stale: true })
  void queryClient.refetchQueries({ queryKey: overviewStatsKeys.all, type: 'all', stale: true })
}
