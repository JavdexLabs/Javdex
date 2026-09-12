import type { ScrapeResult, VideoScrapeField } from '@shared/videoScrapeTypes'

/** Keep one scrape result inside the plugin-declared or user-selected field boundary. */
export function projectVideoScrapeResult(
  result: ScrapeResult,
  fields: ReadonlySet<VideoScrapeField>,
  fallbackCode = result.code
): ScrapeResult {
  const projected: ScrapeResult = { code: result.code || fallbackCode }
  if (fields.has('title')) projected.title = result.title
  if (fields.has('summary')) projected.summary = result.summary
  if (fields.has('cover')) projected.coverUrl = result.coverUrl
  if (fields.has('releaseDate')) projected.releaseDate = result.releaseDate
  if (fields.has('maker')) projected.maker = result.maker
  if (fields.has('publisher')) projected.publisher = result.publisher
  if (fields.has('series')) projected.series = result.series
  if (fields.has('director')) projected.director = result.director
  if (fields.has('duration')) projected.durationSeconds = result.durationSeconds
  if (fields.has('tags')) projected.tags = result.tags
  if (fields.has('source')) projected.sourceUrl = result.sourceUrl
  if (fields.has('rating')) {
    projected.ratingAverage = result.ratingAverage
    projected.ratingCount = result.ratingCount
  }
  if (fields.has('samples')) projected.sampleImageUrls = result.sampleImageUrls
  if (fields.has('actressesFemale') || fields.has('actressesMale')) {
    projected.actresses = (result.actresses ?? []).filter((actress) => {
      const gender = actress.gender ?? 'female'
      return (
        (gender === 'female' && fields.has('actressesFemale')) ||
        (gender === 'male' && fields.has('actressesMale'))
      )
    })
  }
  return projected
}

/** Combine field-source projections without partially merging collection-valued fields. */
export function mergeVideoScrapeResults(
  base: ScrapeResult | null,
  next: ScrapeResult
): ScrapeResult {
  return {
    ...(base ?? { code: next.code }),
    ...next,
    actresses: [...(base?.actresses ?? []), ...(next.actresses ?? [])],
    tags: next.tags ?? base?.tags,
    sampleImageUrls: next.sampleImageUrls ?? base?.sampleImageUrls
  }
}
