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

export type PendingInboxBadgeValue = number | 'loading' | 'error'

/** A partially loaded inbox cannot report an exact zero. */
export function pendingInboxBadgeValue(input: {
  libraries: readonly Pick<MediaLibrarySummary, 'pendingScanGroupCount'>[] | undefined
  pendingVideoCount: number | undefined
  actressConflictGroupCount: number | undefined
  isError: boolean
}): PendingInboxBadgeValue {
  if (input.isError) return 'error'
  if (input.libraries === undefined || input.pendingVideoCount === undefined ||
      input.actressConflictGroupCount === undefined) return 'loading'
  return pendingInboxCount({
    libraries: input.libraries,
    pendingVideoCount: input.pendingVideoCount,
    actressConflictGroupCount: input.actressConflictGroupCount
  })
}
