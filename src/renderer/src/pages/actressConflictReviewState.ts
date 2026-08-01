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
