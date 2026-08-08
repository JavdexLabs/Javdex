import type {
  VideoBatchScrapeFilter,
  VideoScrapeField,
  VideoScrapeUpdateMode
} from '@shared/scrapeTypes'
import {
  getVideoImageCandidatePaths,
  listVideosForBatchScrape,
  resolveEffectiveScrapeFields as resolveEffectiveScrapeFieldsRecord,
  type VideoImageAvailabilityFacts
} from '../db/videoRepo'
import { mediaAssetStore } from './mediaAssetStore'

export function inspectVideoImageAvailability(videoId: number): VideoImageAvailabilityFacts {
  const paths = getVideoImageCandidatePaths(videoId)
  return {
    coverAvailable: mediaAssetStore.inspectImage(paths.coverPath).usable,
    samplePathsAvailable:
      paths.samplePaths.length > 0 &&
      paths.samplePaths.every((storedPath) => mediaAssetStore.inspectImage(storedPath).usable)
  }
}

export function resolveEffectiveVideoScrapeFields(
  videoId: number,
  fields: VideoScrapeField[],
  mode: VideoScrapeUpdateMode = 'replace',
  sourceName?: string,
  ratingSourceName?: string
): VideoScrapeField[] {
  return resolveEffectiveScrapeFieldsRecord(
    videoId,
    fields,
    mode,
    sourceName,
    ratingSourceName,
    inspectVideoImageAvailability(videoId)
  )
}

export function resolveVideoBatchTargets(
  filter: VideoBatchScrapeFilter
): Array<{ id: number; code: string }> {
  const base = listVideosForBatchScrape({ ...filter, missingFields: [] })
  if (filter.videoIds || !(filter.missingFields ?? []).length) return base
  return base.filter(
    (video) =>
      resolveEffectiveVideoScrapeFields(
        video.id,
        filter.missingFields ?? [],
        'fillEmpty',
        filter.sourceName,
        filter.ratingSourceName
      ).length > 0
  )
}
