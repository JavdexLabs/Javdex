import type { MediaLibrarySummary } from '@shared/mediaLibraryTypes'

export function pendingInboxCount(input: {
  libraries: readonly Pick<MediaLibrarySummary, 'pendingScanGroupCount'>[]
  pendingVideoCount: number
  actressConflictGroupCount: number
}): number {
  return (
    input.libraries.reduce(
      (count, library) => count + library.pendingScanGroupCount,
      0
    ) +
    input.pendingVideoCount +
    input.actressConflictGroupCount
  )
}
