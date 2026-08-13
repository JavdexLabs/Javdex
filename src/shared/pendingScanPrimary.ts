export interface PendingScanPrimaryCandidate {
  filePath: string
  durationSeconds: number | null
  sizeBytes: number | null
}

export function selectDefaultPendingScanPrimary<T extends PendingScanPrimaryCandidate>(
  resources: readonly T[],
  pathOrderKey: (filePath: string) => string
): T | undefined {
  return [...resources].sort((left, right) => {
    const duration = (right.durationSeconds ?? -1) - (left.durationSeconds ?? -1)
    if (duration) return duration
    const size = (right.sizeBytes ?? -1) - (left.sizeBytes ?? -1)
    if (size) return size
    const leftPath = pathOrderKey(left.filePath)
    const rightPath = pathOrderKey(right.filePath)
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
  })[0]
}
