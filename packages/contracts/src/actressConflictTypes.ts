import type { ActressScrapeField, ActressScrapeFieldImpact, ActressScrapePluginRef, ActressScrapeResult, ActressScrapeUpdateMode } from './actressScrapeTypes'

export type ActressPendingNameType = 'main' | 'zh' | 'en' | 'alias'

export interface PendingActressScrapeCandidate {
  pendingId: number
  revision: number
  actressId: number
  actressRevision: number
  actressMainName: string
  actressAvatarPath: string | null
  plugin: ActressScrapePluginRef
  queryName: string
  selectedFields: ActressScrapeField[]
  applicableFields: ActressScrapeField[]
  mode: ActressScrapeUpdateMode
  result: ActressScrapeResult
  warnings: string[]
  createdAt: string
  batchJobId?: string
  resources: PendingActressScrapeResource[]
  conflicts: Array<{ name: string; normalizedName: string; type: ActressPendingNameType }>
  /** Exact field result when this candidate actress receives the current conflict name. */
  fieldImpactsWhenAssignedToCandidate: ActressScrapeFieldImpact[]
  /** Exact field result when the current conflict name is kept away from this candidate. */
  fieldImpacts: ActressScrapeFieldImpact[]
  willApplyAfterDecision: boolean
  remainingConflictCountAfterDecision: number
}

export interface PendingActressScrapeResource {
  field: 'avatar' | 'gallery'
  position: number
  remoteUrl?: string
  stagedPath: string
  width: number | null
  height: number | null
}

export interface DiscardPendingActressScrapeInput {
  pendingId: number
  expectedRevision: number
}

export interface DiscardPendingActressScrapeResult {
  remainingPending: number
}

export interface ActressConflictCurrentOwner {
  actressId: number
  revision: number
  mainName: string
  avatarPath: string | null
  nameTypes: ActressPendingNameType[]
  hasPendingScrape: boolean
}

export interface PendingActressNameClaim {
  claimId: number
  actressId: number
  name: string
  type: ActressPendingNameType
  locale: string | null
  source: string | null
  isPrimary: boolean
}

export interface ActressNameConflictGroup {
  status: 'conflict' | 'applicable'
  normalizedName: string
  displayName: string
  currentOwner: ActressConflictCurrentOwner | null
  /** Every actress that currently declares this normalized name, including legacy ambiguous claims. */
  claimants: ActressConflictCurrentOwner[]
  /** Ambiguous historical claims awaiting an explicit ownership decision. */
  pendingNameClaims: PendingActressNameClaim[]
  candidates: PendingActressScrapeCandidate[]
  /** Exact main-process merge preflight for every pair shown in this group. */
  mergePairs?: Array<{
    actressIds: [number, number]
    blockedReason: string | null
  }>
}

export interface ActressConflictReviewSummary {
  groupCount: number
  conflictGroupCount: number
  applicableGroupCount: number
  pendingScrapeCount: number
  pendingNameClaimGroupCount: number
}

export interface InspectActressConflictNameInput {
  actressId: number
  name: string
  pendingId?: number
}

export interface InspectActressConflictNameResult {
  normalizedName: string
  status: 'available' | 'conflict'
}

export interface ActressConflictDecisionSnapshot {
  status: 'conflict' | 'applicable'
  normalizedName: string
  currentOwnerActressId: number | null
  currentOwnerRevision: number | null
  claimants: Array<{ actressId: number; revision: number }>
  pendingNameClaims: Array<{
    claimId: number
    actressId: number
    name: string
    type: ActressPendingNameType
  }>
  candidates: Array<{
    pendingId: number
    pendingRevision: number
    actressId: number
    actressRevision: number
  }>
}

export interface ActressConflictReplacementMainName {
  actressId: number
  mainName: string
}

export interface ValidateIllegalNameReplacementsInput {
  snapshot: ActressConflictDecisionSnapshot
  replacementMainNames: ActressConflictReplacementMainName[]
  /** Ownership decisions keep this claimant's main name; illegal-name decisions omit it. */
  destinationOwnerActressId?: number
}

export type ValidateIllegalNameReplacementsResult =
  | { status: 'valid' }
  | {
      status: 'invalid'
      errors: Array<{ actressId: number; message: string }>
    }
  | { status: 'stale'; message: string }

interface ActressConflictDecisionBase {
  snapshot: ActressConflictDecisionSnapshot
  replacementMainNames: ActressConflictReplacementMainName[]
}

export type ResolveActressConflictInput = ActressConflictDecisionBase &
  (
    | {
        kind: 'editName'
        pendingId: number
        name: string
        nameType: ActressPendingNameType
        newName: string
      }
    | {
        kind: 'editPendingNameClaim'
        claimId: number
        actressId: number
        name: string
        nameType: ActressPendingNameType
        newName: string
      }
    | { kind: 'assignToCurrentActress'; pendingId: number }
    | {
        kind: 'assignToExistingActress'
        ownerActressId: number
        ownerActressRevision: number
      }
    | {
        kind: 'mergeActresses'
        pendingId?: number
        keepActressId: number
        keepActressRevision: number
        mergeActressId: number
        mergeActressRevision: number
        finalMainName: string
      }
    | { kind: 'markIllegalName' }
    | { kind: 'applyPending'; pendingId: number }
  )

export type ResolveActressConflictResult =
  | { status: 'success'; remainingPending: number }
  | { status: 'stale'; message: string }


/** Queue projection only; decisions must use a freshly read complete group. */
export interface ActressConflictQueueItem {
  normalizedName: string
  displayName: string
  status: 'conflict' | 'applicable'
  candidateCount: number
  pendingNameClaimCount: number
  avatarPath: string | null
}
export interface ActressConflictQueueQuery {
  limit?: number
  offset?: number
  anchorName?: string
}
export interface ActressConflictQueuePage {
  items: ActressConflictQueueItem[]
  total: number
  offset: number
}
