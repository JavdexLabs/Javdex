import type {
  ActressConflictCurrentOwner,
  ActressConflictDecisionSnapshot,
  ActressNameConflictGroup,
  ActressScrapeFieldImpact,
  PendingActressScrapeCandidate
} from '@shared/types'
import { normalizeActressName } from '@shared/actressNameNormalization'

export type ActressOwnershipDecision =
  | 'assignToCurrentActress'
  | 'assignToExistingActress'

export type ConflictReviewTab = 'process' | 'source'

export type ConflictReviewAction =
  | 'editName'
  | 'assignOwnership'
  | 'mergeActresses'
  | 'markIllegalName'
  | 'discardScrape'
  | 'applyPending'

export const CONFLICT_ACTION_SCOPE_LABEL: Record<ConflictReviewAction, string> = {
  editName: '当前来源',
  assignOwnership: '整个名称组',
  mergeActresses: '演员档案',
  markIllegalName: '整个名称组',
  discardScrape: '整份刮削结果',
  applyPending: '整份刮削结果'
}

export type ConflictReviewSource =
  | { kind: 'scrape'; id: number }
  | { kind: 'claim'; id: number }

export interface ConflictReviewProposedOwner {
  actressId: number
  revision: number
  mainName: string
}

export interface ConflictReviewSelection {
  source: ConflictReviewSource | null
  proposedOwner: ConflictReviewProposedOwner | null
  tab: ConflictReviewTab
}

export function buildConflictQueueSections(groups: ActressNameConflictGroup[]): {
  pending: ActressNameConflictGroup[]
  applicable: ActressNameConflictGroup[]
} {
  const sort = (items: ActressNameConflictGroup[]): ActressNameConflictGroup[] =>
    [...items].sort((left, right) =>
      left.displayName.localeCompare(right.displayName, 'zh-Hans-CN')
    )
  return {
    pending: sort(groups.filter((group) => group.status === 'conflict')),
    applicable: sort(groups.filter((group) => group.status === 'applicable'))
  }
}

export function createConflictReviewSelection(
  group: ActressNameConflictGroup
): ConflictReviewSelection {
  const candidate = group.candidates[0]
  const claim = group.pendingNameClaims[0]
  return {
    source: candidate
      ? { kind: 'scrape', id: candidate.pendingId }
      : claim
        ? { kind: 'claim', id: claim.claimId }
        : null,
    proposedOwner: null,
    tab: 'process'
  }
}

export function selectConflictSource(
  state: ConflictReviewSelection,
  source: ConflictReviewSource
): ConflictReviewSelection {
  return { ...state, source }
}

export function selectConflictProposedOwner(
  state: ConflictReviewSelection,
  proposedOwner: ConflictReviewProposedOwner | null
): ConflictReviewSelection {
  return { ...state, proposedOwner }
}

export function partitionConflictFieldImpacts(impacts: ActressScrapeFieldImpact[]): {
  changed: ActressScrapeFieldImpact[]
  unchanged: ActressScrapeFieldImpact[]
  unchangedInitiallyOpen: false
} {
  return {
    changed: impacts.filter((impact) => impact.action !== 'preserve'),
    unchanged: impacts.filter((impact) => impact.action === 'preserve'),
    unchangedInitiallyOpen: false
  }
}

export function conflictFieldImpactsForProposedOwner(
  candidate: PendingActressScrapeCandidate,
  proposedOwner: ConflictReviewProposedOwner | null
): ActressScrapeFieldImpact[] {
  return proposedOwner?.actressId === candidate.actressId
    ? candidate.fieldImpactsWhenAssignedToCandidate
    : candidate.fieldImpacts
}

export interface ConflictNameEditInspection {
  normalizedName: string
  status: 'empty' | 'unchanged' | 'conflict' | 'available'
  targetGroupName: string | null
}

export function normalizeConflictNameForPreview(name: string): string {
  try {
    return normalizeActressName(name)
  } catch {
    return ''
  }
}

export function inspectConflictNameEdit(
  originalName: string,
  nextName: string,
  groups: ActressNameConflictGroup[]
): ConflictNameEditInspection {
  const trimmed = nextName.trim()
  const normalizedName = normalizeConflictNameForPreview(trimmed)
  if (!normalizedName) {
    return { normalizedName: '', status: 'empty', targetGroupName: null }
  }
  const targetGroup = groups.find((group) => group.normalizedName === normalizedName) ?? null
  if (trimmed === originalName.trim()) {
    return {
      normalizedName,
      status: 'unchanged',
      targetGroupName: targetGroup?.displayName ?? null
    }
  }
  if (targetGroup) {
    return {
      normalizedName,
      status: 'conflict',
      targetGroupName: targetGroup.displayName
    }
  }
  return { normalizedName, status: 'available', targetGroupName: null }
}

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
  blockedPartnerReasons: Record<number, string>
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
    pendingNameClaims: group.pendingNameClaims.map((claim) => ({
      claimId: claim.claimId,
      actressId: claim.actressId,
      name: claim.name,
      type: claim.type
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
      hasPending: claimant.hasPendingScrape,
      blockedPartnerReasons: {}
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
      blockedPartnerReasons: existing?.blockedPartnerReasons ?? {},
      ...(existing
        ? {
            mainName: existing.mainName,
            avatarPath: existing.avatarPath
          }
        : {})
    })
  }
  for (const pair of group.mergePairs ?? []) {
    if (!pair.blockedReason) continue
    const [firstId, secondId] = pair.actressIds
    const first = actors.get(firstId)
    const second = actors.get(secondId)
    if (first) first.blockedPartnerReasons[secondId] = pair.blockedReason
    if (second) second.blockedPartnerReasons[firstId] = pair.blockedReason
  }
  return [...actors.values()]
}

export function canConfirmMergeActresses(
  actors: ActressConflictMergeActor[],
  selectedActressId: number,
  partnerActressId: number | null,
  keepActressId: number | null,
  finalMainNameActressId: number | null,
  allowSinglePendingScrape = true
): boolean {
  if (
    actors.length > 2 ||
    partnerActressId == null ||
    keepActressId == null ||
    partnerActressId === selectedActressId
  ) {
    return false
  }
  const selected = actors.find((actor) => actor.actressId === selectedActressId)
  const partner = actors.find((actor) => actor.actressId === partnerActressId)
  if (!selected || !partner) return false
  if (selected.blockedPartnerReasons[partner.actressId]) return false
  if (!allowSinglePendingScrape && (selected.hasPending || partner.hasPending)) return false
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
  const previous = buildConflictQueueSections(previousGroups)
  const refreshed = buildConflictQueueSections(refreshedGroups)
  const orderedRefreshed = [...refreshed.pending, ...refreshed.applicable]
  if (!selectedNormalizedName) return orderedRefreshed[0]?.normalizedName ?? null
  const previousSelected = previousGroups.find(
    (group) => group.normalizedName === selectedNormalizedName
  )
  const refreshedSelected = refreshedGroups.find(
    (group) => group.normalizedName === selectedNormalizedName
  )
  if (previousSelected && refreshedSelected?.status === previousSelected.status) {
    return selectedNormalizedName
  }

  const previousSection = previous.pending.some(
    (group) => group.normalizedName === selectedNormalizedName
  )
    ? 'pending'
    : previous.applicable.some((group) => group.normalizedName === selectedNormalizedName)
      ? 'applicable'
      : null
  if (!previousSection) return orderedRefreshed[0]?.normalizedName ?? null

  const previousQueue = previous[previousSection]
  const refreshedQueue = refreshed[previousSection]
  if (refreshedQueue.length > 0) {
    const previousIndex = previousQueue.findIndex(
      (group) => group.normalizedName === selectedNormalizedName
    )
    return refreshedQueue[Math.min(Math.max(previousIndex, 0), refreshedQueue.length - 1)]
      .normalizedName
  }
  const nextSection = previousSection === 'pending' ? refreshed.applicable : refreshed.pending
  return nextSection[0]?.normalizedName ?? null
}

export interface ConflictReviewRefreshState {
  selectedNormalizedName: string | null
  selection: null
  staleMessage: string | null
  focusTarget: { kind: 'group'; normalizedName: string } | { kind: 'complete' }
}

export function buildConflictReviewRefreshState(
  previousGroups: ActressNameConflictGroup[],
  refreshedGroups: ActressNameConflictGroup[],
  selectedNormalizedName: string | null,
  stale: boolean
): ConflictReviewRefreshState {
  const next = selectConflictGroupAfterRefresh(
    previousGroups,
    refreshedGroups,
    selectedNormalizedName
  )
  return {
    selectedNormalizedName: next,
    selection: null,
    staleMessage: stale ? '数据已变化，已刷新，请重新确认' : null,
    focusTarget: next
      ? { kind: 'group', normalizedName: next }
      : { kind: 'complete' }
  }
}
