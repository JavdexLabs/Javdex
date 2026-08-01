import type {
  ActressConflictCurrentOwner,
  ActressConflictDecisionSnapshot,
  ActressNameConflictGroup
} from '@shared/types'

export type ActressOwnershipDecision =
  | 'assignToCurrentActress'
  | 'assignToExistingActress'

export type IllegalNameReplacementValidationStatus =
  | 'idle'
  | 'checking'
  | 'valid'
  | 'invalid'
  | 'stale'

export interface ActressConflictMergeActor {
  actressId: number
  revision: number
  mainName: string
  avatarPath: string | null
  hasPending: boolean
}

export function buildActressConflictDecisionSnapshot(
  group: ActressNameConflictGroup
): ActressConflictDecisionSnapshot {
  return {
    status: group.status,
    normalizedName: group.normalizedName,
    currentOwnerActressId: group.currentOwner?.actressId ?? null,
    currentOwnerRevision: group.currentOwner?.revision ?? null,
    claimants: group.claimants.map((claimant) => ({
      actressId: claimant.actressId,
      revision: claimant.revision
    })),
    candidates: group.candidates.map((candidate) => ({
      pendingId: candidate.pendingId,
      pendingRevision: candidate.revision,
      actressId: candidate.actressId,
      actressRevision: candidate.actressRevision
    }))
  }
}

export function conflictClaimantsNeedingReplacement(
  group: ActressNameConflictGroup,
  destinationOwnerActressId?: number | null
): ActressConflictCurrentOwner[] {
  return group.claimants.filter(
    (claimant) =>
      claimant.nameTypes.includes('main') && claimant.actressId !== destinationOwnerActressId
  )
}

export function canConfirmIllegalName(
  requiredClaimants: ActressConflictCurrentOwner[],
  replacementMainNames: Record<number, string>,
  validationStatus: IllegalNameReplacementValidationStatus
): boolean {
  if (requiredClaimants.length === 0) return true
  return (
    validationStatus === 'valid' &&
    requiredClaimants.every((claimant) => replacementMainNames[claimant.actressId]?.trim())
  )
}

export function buildActressConflictMergeActors(
  group: ActressNameConflictGroup
): ActressConflictMergeActor[] {
  const actors = new Map<number, ActressConflictMergeActor>()
  for (const claimant of group.claimants) {
    actors.set(claimant.actressId, {
      actressId: claimant.actressId,
      revision: claimant.revision,
      mainName: claimant.mainName,
      avatarPath: claimant.avatarPath,
      hasPending: false
    })
  }
  for (const candidate of group.candidates) {
    const existing = actors.get(candidate.actressId)
    actors.set(candidate.actressId, {
      actressId: candidate.actressId,
      revision: candidate.actressRevision,
      mainName: candidate.actressMainName,
      avatarPath: candidate.actressAvatarPath,
      hasPending: true,
      ...(existing
        ? {
            mainName: existing.mainName,
            avatarPath: existing.avatarPath
          }
        : {})
    })
  }
  return [...actors.values()]
}

export function canConfirmMergeActresses(
  actors: ActressConflictMergeActor[],
  selectedActressId: number,
  partnerActressId: number | null,
  keepActressId: number | null,
  finalMainNameActressId: number | null
): boolean {
  if (
    partnerActressId == null ||
    keepActressId == null ||
    partnerActressId === selectedActressId
  ) {
    return false
  }
  const selected = actors.find((actor) => actor.actressId === selectedActressId)
  const partner = actors.find((actor) => actor.actressId === partnerActressId)
  if (!selected || !partner || !selected.hasPending) return false
  if (selected.hasPending && partner.hasPending) return false
  if (keepActressId !== selectedActressId && keepActressId !== partnerActressId) return false
  return (
    finalMainNameActressId === selectedActressId ||
    finalMainNameActressId === partnerActressId
  )
}

export function selectConflictGroupAfterRefresh(
  previousGroups: ActressNameConflictGroup[],
  refreshedGroups: ActressNameConflictGroup[],
  selectedNormalizedName: string | null
): string | null {
  if (refreshedGroups.length === 0) return null
  if (
    selectedNormalizedName &&
    refreshedGroups.some((group) => group.normalizedName === selectedNormalizedName)
  ) {
    return selectedNormalizedName
  }
  const previousIndex = selectedNormalizedName
    ? previousGroups.findIndex((group) => group.normalizedName === selectedNormalizedName)
    : 0
  const nextIndex = Math.min(
    Math.max(previousIndex, 0),
    refreshedGroups.length - 1
  )
  return refreshedGroups[nextIndex].normalizedName
}
