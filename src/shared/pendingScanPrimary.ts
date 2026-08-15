export interface PendingScanPrimaryCandidate {
  filePath: string
  sourceKind?: 'local' | 'strm'
  targetKind?: 'direct' | 'web' | 'magnet' | 'ed2k' | null
  durationSeconds: number | null
  sizeBytes: number | null
}

function resourceRank(resource: PendingScanPrimaryCandidate): number {
  if (resource.sourceKind !== 'strm') return 0
  if (resource.targetKind === 'direct') return 1
  if (resource.targetKind === 'magnet') return 2
  if (resource.targetKind === 'ed2k') return 3
  return 4
}

export function selectDefaultPendingScanPrimary<T extends PendingScanPrimaryCandidate>(
  resources: readonly T[],
  pathOrderKey: (filePath: string) => string
): T | undefined {
  return [...resources].sort((left, right) => {
    const rank = resourceRank(left) - resourceRank(right)
    if (rank) return rank
    if (left.sourceKind === 'strm' && right.sourceKind === 'strm') {
      const leftPath = pathOrderKey(left.filePath)
      const rightPath = pathOrderKey(right.filePath)
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
    }
    const duration = (right.durationSeconds ?? -1) - (left.durationSeconds ?? -1)
    if (duration) return duration
    const size = (right.sizeBytes ?? -1) - (left.sizeBytes ?? -1)
    if (size) return size
    const leftPath = pathOrderKey(left.filePath)
    const rightPath = pathOrderKey(right.filePath)
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
  })[0]
}
