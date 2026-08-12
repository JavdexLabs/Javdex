import type { PendingScanResource, PendingScanResourceTarget } from '@shared/libraryTypes'

function pendingPathOrderKey(filePath: string): string {
  const slashNormalized = filePath.replaceAll('\\', '/')
  const platform =
    typeof navigator !== 'undefined'
      ? navigator.platform.toLowerCase()
      : typeof process !== 'undefined'
        ? process.platform
        : ''
  return platform.includes('mac') || platform.includes('win')
    ? slashNormalized.toLowerCase()
    : slashNormalized
}

export function arePendingScanAssignmentsComplete(
  resourceIds: readonly number[],
  assignments: Readonly<Record<number, PendingScanResourceTarget | undefined>>
): boolean {
  return resourceIds.length > 0 && resourceIds.every((resourceId) => {
    const target = assignments[resourceId]
    if (!target) return false
    return target.kind === 'existing'
      ? Number.isInteger(target.videoId) && target.videoId > 0
      : target.groupKey.trim().length > 0
  })
}

export function pendingScanTargetValue(target: PendingScanResourceTarget | undefined): string {
  if (!target) return ''
  return target.kind === 'existing'
    ? `existing:${target.videoId}`
    : `new:${target.groupKey}`
}

export function pendingScanTargetFromValue(value: string): PendingScanResourceTarget | undefined {
  if (value.startsWith('existing:')) {
    const videoId = Number(value.slice('existing:'.length))
    return Number.isInteger(videoId) && videoId > 0
      ? { kind: 'existing', videoId }
      : undefined
  }
  if (value.startsWith('new:')) {
    const groupKey = value.slice('new:'.length).trim()
    return groupKey ? { kind: 'new', groupKey } : undefined
  }
  return undefined
}

/** Mirror the persisted resolution rule so the UI can show the effective default before submit. */
export function defaultPendingScanPrimaryResourceId(
  resources: readonly PendingScanResource[]
): number | null {
  const sorted = [...resources].sort((left, right) => {
    const duration = (right.durationSeconds ?? -1) - (left.durationSeconds ?? -1)
    if (duration) return duration
    const size = (right.sizeBytes ?? -1) - (left.sizeBytes ?? -1)
    if (size) return size
    const leftPath = pendingPathOrderKey(left.filePath)
    const rightPath = pendingPathOrderKey(right.filePath)
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
  })
  return sorted[0]?.id ?? null
}

export function arePendingScrapeSelectionsComplete(
  sources: ReadonlyArray<{
    id: number
    candidates: ReadonlyArray<{ id: number }>
  }>,
  selections: Readonly<Record<number, number>>
): boolean {
  return sources.length > 0 && sources.every((source) => {
    const selectedId = selections[source.id]
    return selectedId != null && source.candidates.some((candidate) => candidate.id === selectedId)
  })
}
