import type { VideoExternalStats } from './videoTypes'

/** Keep a manual selection; otherwise choose the newest usable score deterministically. */
export function selectDefaultExternalRating<T extends Pick<VideoExternalStats,
  'source' | 'rating_average' | 'fetched_at' | 'is_default'>>(ratings: readonly T[]): T | undefined {
  return ratings.filter((rating) => rating.rating_average != null && Number.isFinite(rating.rating_average))
    .sort((a, b) => {
      const selected = Number(Boolean(b.is_default)) - Number(Boolean(a.is_default))
      if (selected) return selected
      const aTime = a.fetched_at ?? ''
      const bTime = b.fetched_at ?? ''
      if (aTime !== bTime) return aTime > bTime ? -1 : 1
      return a.source < b.source ? -1 : a.source > b.source ? 1 : 0
    })[0]
}
