import type { Video, VideoResourceFilter } from '@shared/videoTypes'

export function matchesPlaylistResourceFilter(
  video: Video,
  filters: readonly VideoResourceFilter[]
): boolean {
  if (filters.length === 0) return true
  const kinds = video.resource_kinds ?? []
  return filters.some((filter) => filter === 'none' ? kinds.length === 0 : kinds.includes(filter))
}
