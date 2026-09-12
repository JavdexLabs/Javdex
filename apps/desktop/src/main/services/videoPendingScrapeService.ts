import {
  countPendingVideoScrapes,
  existingPendingVideoScrapeIds,
  getPendingVideoScrapeById,
  pagePendingVideoScrapes,
  listPendingVideoScrapes
} from '@library/db/pendingVideoScrapeRepo'
import { getDb } from '@library/db/database'
import { mediaAssetStore } from '@library/mediaAssetStore'
import {
  confirmPendingVideoScrape,
  discardPendingVideoScrapeRecord
} from '@library/catalog/catalogPendingVideoScrapes'
import type {
  PendingVideoScrape,
  PendingVideoScrapePage,
  PendingVideoScrapePageQuery,
  PendingVideoScrapeConfirmInput,
  PendingVideoScrapeResolutionResult
} from '@shared/videoScrapeTypes'

/** Remove crash leftovers while preserving every referenced or recently written staging dir. */
export function cleanupOrphanedVideoScrapeStaging(options?: {
  now?: number
  olderThanMs?: number
}): number {
  const referencedPaths = (
    getDb().prepare(
      `SELECT staged_path FROM pending_video_scrape_resources
       UNION
       SELECT r.staged_path
         FROM agent_metadata_draft_resources r
         JOIN agent_metadata_drafts d ON d.id = r.draft_id
        WHERE d.status = 'ready' AND r.field IN ('cover', 'samples', 'actressAvatar')`
    ).all() as Array<{
      staged_path: string
    }>
  ).map((row) => row.staged_path)
  return mediaAssetStore.cleanupOrphanedVideoScrapeStaging(referencedPaths, options)
}

export const videoPendingScrapeService = {
  count(): number {
    return countPendingVideoScrapes()
  },

  existingIds(ids: number[]): number[] {
    return existingPendingVideoScrapeIds(ids)
  },

  page(query: PendingVideoScrapePageQuery): PendingVideoScrapePage {
    return pagePendingVideoScrapes(query)
  },

  get(id: number): PendingVideoScrape | null {
    return getPendingVideoScrapeById(id)
  },

  list(): PendingVideoScrape[] {
    return listPendingVideoScrapes()
  },

  discard(pendingScrapeId: number): boolean {
    const result = discardPendingVideoScrapeRecord(pendingScrapeId)
    if (!result.ok) return false
    mediaAssetStore.cleanupVideoScrapeStagingPaths(result.stagedPaths)
    return true
  },

  confirm(input: PendingVideoScrapeConfirmInput): PendingVideoScrapeResolutionResult {
    return confirmPendingVideoScrape(input)
  }
}
