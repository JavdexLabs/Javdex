import type { MediaLibraryDetail } from '@shared/mediaLibraryTypes'

/**
 * Resolve the single-video scraper from the active library snapshot. The id check prevents a
 * retained query result from the previous library being used during a route-context switch.
 */
export function resolveVideoDetailDefaultScraper(
  activeLibraryId: number | null,
  library: Pick<MediaLibraryDetail, 'id' | 'config'> | null | undefined,
  globalDefaultScraper: string
): string {
  const libraryDefault =
    activeLibraryId != null && library?.id === activeLibraryId
      ? library.config.defaultVideoScraper?.trim()
      : ''
  return libraryDefault || globalDefaultScraper.trim()
}
