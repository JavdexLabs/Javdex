import type { ClassificationMergeInput } from '@shared/classificationTypes'

export function reconcileClassificationMergeSource<T extends { id: number }>(
  selected: T | null,
  candidates: T[]
): T | null {
  if (!selected) return null
  return candidates.find((candidate) => candidate.id === selected.id) ?? selected
}

export function buildClassificationMergeCommand(
  targetId: number,
  sourceId: number | null
): ClassificationMergeInput | null {
  if (!Number.isInteger(targetId) || targetId <= 0) return null
  if (!Number.isInteger(sourceId) || sourceId == null || sourceId <= 0 || sourceId === targetId) {
    return null
  }
  return { targetId, sourceId }
}
