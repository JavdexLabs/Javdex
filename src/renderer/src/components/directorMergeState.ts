import type { DirectorMergeInput, DirectorOption } from '@shared/classificationTypes'

export function reconcileDirectorMergeSource(
  selected: DirectorOption | null,
  candidates: DirectorOption[]
): DirectorOption | null {
  if (!selected) return null
  return candidates.find((candidate) => candidate.id === selected.id) ?? selected
}

export function buildDirectorMergeInput(
  targetId: number,
  sourceId: number | null
): DirectorMergeInput | null {
  if (!Number.isInteger(targetId) || targetId <= 0) return null
  if (!Number.isInteger(sourceId) || sourceId == null || sourceId <= 0 || sourceId === targetId) {
    return null
  }
  return { targetId, sourceId }
}
