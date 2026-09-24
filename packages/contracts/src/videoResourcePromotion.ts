import type { VideoResource } from './videoTypes'

function promotionRank(
  resource: VideoResource,
  isLocalAccessible: (path: string) => boolean
): number {
  if (resource.kind === 'local') {
    return isLocalAccessible(resource.locator) ? 0 : Number.MAX_SAFE_INTEGER
  }
  if (resource.kind === 'direct') return 1
  if (resource.kind === 'magnet') return 2
  if (resource.kind === 'ed2k') return 3
  return 4
}

/**
 * Chooses the deterministic primary fallback for an already-scoped resource list.
 * Inaccessible local resources are ineligible; equal kinds use add time and then id.
 */
export function selectPrimaryVideoResourceCandidate(
  resources: VideoResource[],
  isLocalAccessible: (path: string) => boolean
): VideoResource | null {
  const ranked = resources
    .map((resource) => ({ resource, rank: promotionRank(resource, isLocalAccessible) }))
    .filter((item) => item.rank < Number.MAX_SAFE_INTEGER)
    .sort((left, right) => {
      const rank = left.rank - right.rank
      if (rank !== 0) return rank
      const added = left.resource.add_time.localeCompare(right.resource.add_time)
      return added !== 0 ? added : left.resource.id - right.resource.id
    })
  return ranked[0]?.resource ?? null
}
