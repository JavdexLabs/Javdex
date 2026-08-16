import type { ActressListItem } from '@shared/actressTypes'
import type {
  ActressNameConflictGroup,
  PendingActressNameClaim,
  PendingActressScrapeCandidate
} from '@shared/actressConflictTypes'
import {
  buildActressConflictMergeActors,
  buildConflictQueueSections,
  buildConflictReviewRefreshState,
  canConfirmIllegalName,
  conflictClaimantsNeedingReplacement,
  createConflictReviewSelection,
  inspectConflictNameEdit,
  selectConflictProposedOwner,
  selectConflictSource,
  type ActressConflictMergeActor,
  type ConflictNameEditInspection,
  type ConflictReviewProposedOwner,
  type ConflictReviewSelection,
  type ConflictReviewTab,
  type IllegalNameReplacementValidationStatus
} from './actressConflictReviewState'

export type ReplacementDialog = 'ownership' | 'illegal' | null

export interface ConflictReviewOwnerOption {
  actressId: number
  revision: number
  mainName: string
  avatarPath: string | null
  roles: string[]
}

export interface ConflictReviewSessionState {
  selectedName: string | null
  selectionGroupName: string | null
  selection: ConflictReviewSelection | null
  focusAfterRefresh: string | null | undefined
  staleMessage: string | null
  resolving: boolean
  discarding: boolean
  discardCandidate: PendingActressScrapeCandidate | null
  otherOwnerOpen: boolean
  otherOwnerSearch: string
  otherOwnerOptions: ActressListItem[]
  otherOwnerLoading: boolean
  selectedOtherOwner: ActressListItem | null
  editNameOpen: boolean
  editedName: string
  liveEditInspection: { normalizedName: string; status: 'available' | 'conflict' } | null
  editInspectionLoading: boolean
  mergeOpen: boolean
  replacementDialog: ReplacementDialog
  replacementMainNames: Record<number, string>
  replacementValidationStatus: IllegalNameReplacementValidationStatus
  replacementValidationErrors: Record<number, string>
}

export type ConflictReviewIntent =
  | { type: 'patch'; patch: Partial<ConflictReviewSessionState> }
  | { type: 'resetTransient' }
  | { type: 'chooseGroup'; group: ActressNameConflictGroup }
  | { type: 'syncSelectedGroup'; group: ActressNameConflictGroup | null }
  | { type: 'selectTab'; tab: ConflictReviewTab }
  | { type: 'selectOwner'; owner: ConflictReviewProposedOwner }
  | { type: 'selectSource'; source: NonNullable<ConflictReviewSelection['source']> }
  | { type: 'openOtherOwner' }
  | { type: 'closeOtherOwner' }
  | { type: 'changeOtherOwnerSearch'; value: string }
  | { type: 'chooseOtherOwner'; item: ActressListItem; revision: number }
  | { type: 'openEditName'; sourceName: string }
  | { type: 'closeEditName' }
  | { type: 'changeEditedName'; value: string }
  | { type: 'openMerge' }
  | { type: 'closeMerge' }
  | { type: 'openIllegalName' }
  | { type: 'openOwnershipReplacement' }
  | { type: 'closeReplacement' }
  | { type: 'changeReplacementMainName'; actressId: number; value: string }
  | { type: 'requestDiscard'; candidate: PendingActressScrapeCandidate }
  | { type: 'cancelDiscard' }
  | {
      type: 'applyRefresh'
      previousGroups: ActressNameConflictGroup[]
      refreshedGroups: ActressNameConflictGroup[]
      previousSelectedName: string | null
      stale?: boolean
    }
  | { type: 'focusHandled' }
  | { type: 'staleReplacementValidation' }

export const initialConflictReviewSessionState: ConflictReviewSessionState = {
  selectedName: null,
  selectionGroupName: null,
  selection: null,
  focusAfterRefresh: undefined,
  staleMessage: null,
  resolving: false,
  discarding: false,
  discardCandidate: null,
  otherOwnerOpen: false,
  otherOwnerSearch: '',
  otherOwnerOptions: [],
  otherOwnerLoading: false,
  selectedOtherOwner: null,
  editNameOpen: false,
  editedName: '',
  liveEditInspection: null,
  editInspectionLoading: false,
  mergeOpen: false,
  replacementDialog: null,
  replacementMainNames: {},
  replacementValidationStatus: 'idle',
  replacementValidationErrors: {}
}

const EMPTY_REPLACEMENT_CLAIMANTS: ActressNameConflictGroup['claimants'] = []

function resetTransient(state: ConflictReviewSessionState): ConflictReviewSessionState {
  return {
    ...state,
    otherOwnerOpen: false,
    otherOwnerSearch: '',
    selectedOtherOwner: null,
    editNameOpen: false,
    mergeOpen: false,
    replacementDialog: null,
    replacementMainNames: {},
    replacementValidationStatus: 'idle',
    replacementValidationErrors: {}
  }
}

export function reduceConflictReviewSession(
  state: ConflictReviewSessionState,
  intent: ConflictReviewIntent
): ConflictReviewSessionState {
  switch (intent.type) {
    case 'patch':
      return { ...state, ...intent.patch }
    case 'resetTransient':
      return resetTransient(state)
    case 'chooseGroup':
      return resetTransient({
        ...state,
        staleMessage: null,
        selectedName: intent.group.normalizedName,
        selectionGroupName: intent.group.normalizedName,
        selection: createConflictReviewSelection(intent.group)
      })
    case 'syncSelectedGroup': {
      if (!intent.group) {
        if (state.selectedName === null && state.selection === null && state.selectionGroupName === null) {
          return state
        }
        return { ...state, selectedName: null, selection: null, selectionGroupName: null }
      }
      if (state.selectionGroupName !== intent.group.normalizedName) {
        return resetTransient({
          ...state,
          selectedName: intent.group.normalizedName,
          selection: createConflictReviewSelection(intent.group),
          selectionGroupName: intent.group.normalizedName
        })
      }
      if (state.selectedName !== intent.group.normalizedName) {
        return { ...state, selectedName: intent.group.normalizedName }
      }
      return state
    }
    case 'selectTab':
      return {
        ...state,
        selection: state.selection ? { ...state.selection, tab: intent.tab } : state.selection
      }
    case 'selectOwner':
      return {
        ...state,
        selectedOtherOwner: null,
        selection: state.selection
          ? selectConflictProposedOwner(state.selection, intent.owner)
          : state.selection
      }
    case 'selectSource':
      return {
        ...state,
        selection: state.selection
          ? selectConflictSource(state.selection, intent.source)
          : state.selection
      }
    case 'openOtherOwner':
      return { ...state, otherOwnerOpen: true, otherOwnerSearch: '' }
    case 'closeOtherOwner':
      return { ...state, otherOwnerOpen: false, otherOwnerSearch: '' }
    case 'changeOtherOwnerSearch':
      return { ...state, otherOwnerSearch: intent.value }
    case 'chooseOtherOwner':
      return {
        ...state,
        selection: state.selection
          ? selectConflictProposedOwner(state.selection, {
              actressId: intent.item.id,
              revision: intent.revision,
              mainName: intent.item.main_name
            })
          : state.selection,
        selectedOtherOwner: intent.item,
        otherOwnerOpen: false,
        otherOwnerSearch: ''
      }
    case 'openEditName':
      if (!intent.sourceName) return state
      return { ...state, editedName: intent.sourceName, editNameOpen: true }
    case 'closeEditName':
      return { ...state, editNameOpen: false }
    case 'changeEditedName':
      return { ...state, editedName: intent.value }
    case 'openMerge':
      return { ...state, mergeOpen: true }
    case 'closeMerge':
      return { ...state, mergeOpen: false }
    case 'openIllegalName':
      return { ...state, replacementMainNames: {}, replacementDialog: 'illegal' }
    case 'openOwnershipReplacement':
      return { ...state, replacementMainNames: {}, replacementDialog: 'ownership' }
    case 'closeReplacement':
      return { ...state, replacementDialog: null, replacementMainNames: {} }
    case 'changeReplacementMainName':
      return {
        ...state,
        replacementMainNames: {
          ...state.replacementMainNames,
          [intent.actressId]: intent.value
        }
      }
    case 'requestDiscard':
      return { ...state, discardCandidate: intent.candidate }
    case 'cancelDiscard':
      return { ...state, discardCandidate: null }
    case 'applyRefresh': {
      const next = buildConflictReviewRefreshState(
        intent.previousGroups,
        intent.refreshedGroups,
        intent.previousSelectedName,
        intent.stale ?? false
      )
      return {
        ...state,
        selectedName: next.selectedNormalizedName,
        selectionGroupName: null,
        selection: next.selection,
        staleMessage: next.staleMessage,
        focusAfterRefresh: next.focusTarget.kind === 'group' ? next.focusTarget.normalizedName : null
      }
    }
    case 'focusHandled':
      return { ...state, focusAfterRefresh: undefined }
    case 'staleReplacementValidation':
      return {
        ...state,
        replacementDialog: null,
        staleMessage: '数据已变化，已刷新，请重新确认',
        selection: state.selection
          ? selectConflictProposedOwner(state.selection, null)
          : state.selection,
        selectedOtherOwner: null
      }
    default:
      return state
  }
}

export function buildOwnerOptions(group: ActressNameConflictGroup): ConflictReviewOwnerOption[] {
  const options = new Map<number, ConflictReviewOwnerOption>()
  const ensure = (
    actressId: number,
    revision: number,
    mainName: string,
    avatarPath: string | null,
    role: string
  ): void => {
    const current = options.get(actressId)
    if (current) {
      if (!current.roles.includes(role)) current.roles.push(role)
      return
    }
    options.set(actressId, { actressId, revision, mainName, avatarPath, roles: [role] })
  }
  for (const claimant of group.claimants) {
    ensure(
      claimant.actressId,
      claimant.revision,
      claimant.mainName,
      claimant.avatarPath,
      group.currentOwner?.actressId === claimant.actressId ? '当前归属' : '历史名称声明'
    )
  }
  for (const candidate of group.candidates) {
    ensure(
      candidate.actressId,
      candidate.actressRevision,
      candidate.actressMainName,
      candidate.actressAvatarPath,
      '本次刮削目标'
    )
  }
  return [...options.values()].sort((left, right) =>
    left.mainName.localeCompare(right.mainName, 'zh-Hans-CN')
  )
}

export interface ConflictReviewDerivedDetail {
  sections: { pending: ActressNameConflictGroup[]; applicable: ActressNameConflictGroup[] }
  selectedGroup: ActressNameConflictGroup | null
  selectedCandidate: PendingActressScrapeCandidate | null
  selectedClaim: PendingActressNameClaim | null
  selectedConflict: PendingActressScrapeCandidate['conflicts'][number] | null
  ownerOptions: ConflictReviewOwnerOption[]
  mergeActors: ActressConflictMergeActor[]
  proposedOwner: ConflictReviewProposedOwner | null
  ownershipReplacementClaimants: ActressNameConflictGroup['claimants']
  illegalReplacementClaimants: ActressNameConflictGroup['claimants']
  requiredReplacementClaimants: ActressNameConflictGroup['claimants']
  replacementInputs: Array<{ actressId: number; mainName: string }>
  editSourceName: string
  editSourceType: PendingActressScrapeCandidate['conflicts'][number]['type'] | PendingActressNameClaim['type'] | null
  localEditInspection: ConflictNameEditInspection
  editInspection: ConflictNameEditInspection
  editInspectionPending: boolean
  canSubmitEditedName: boolean
  canSubmitReplacement: boolean
}

export function deriveConflictReviewDetail(
  state: ConflictReviewSessionState,
  groups: ActressNameConflictGroup[],
  debouncedEditedName: string
): ConflictReviewDerivedDetail {
  const sections = buildConflictQueueSections(groups)
  const selectedGroup =
    groups.find((group) => group.normalizedName === state.selectedName) ?? groups[0] ?? null
  const selectedCandidate =
    state.selection?.source?.kind === 'scrape'
      ? selectedGroup?.candidates.find(
          (candidate) => candidate.pendingId === state.selection?.source?.id
        ) ?? null
      : null
  const selectedClaim =
    state.selection?.source?.kind === 'claim'
      ? selectedGroup?.pendingNameClaims.find(
          (claim) => claim.claimId === state.selection?.source?.id
        ) ?? null
      : null
  const selectedConflict =
    selectedCandidate?.conflicts.find(
      (conflict) => conflict.normalizedName === selectedGroup?.normalizedName
    ) ?? null
  const ownerOptions = selectedGroup ? buildOwnerOptions(selectedGroup) : []
  const mergeActors = selectedGroup ? buildActressConflictMergeActors(selectedGroup) : []
  const proposedOwner = state.selection?.proposedOwner ?? null
  const ownershipReplacementClaimants = selectedGroup
    ? conflictClaimantsNeedingReplacement(selectedGroup, proposedOwner?.actressId)
    : EMPTY_REPLACEMENT_CLAIMANTS
  const illegalReplacementClaimants = selectedGroup
    ? conflictClaimantsNeedingReplacement(selectedGroup, null)
    : EMPTY_REPLACEMENT_CLAIMANTS
  const requiredReplacementClaimants =
    state.replacementDialog === 'ownership'
      ? ownershipReplacementClaimants
      : state.replacementDialog === 'illegal'
        ? illegalReplacementClaimants
        : EMPTY_REPLACEMENT_CLAIMANTS
  const replacementInputs = requiredReplacementClaimants.map((claimant) => ({
    actressId: claimant.actressId,
    mainName: state.replacementMainNames[claimant.actressId] ?? ''
  }))
  const editSourceName = selectedConflict?.name ?? selectedClaim?.name ?? ''
  const editSourceType = selectedConflict?.type ?? selectedClaim?.type ?? null
  const localEditInspection = inspectConflictNameEdit(editSourceName, state.editedName, groups)
  const editInspection =
    localEditInspection.status === 'empty' || localEditInspection.status === 'unchanged'
      ? localEditInspection
      : state.liveEditInspection
        ? {
            normalizedName: state.liveEditInspection.normalizedName,
            status: state.liveEditInspection.status,
            targetGroupName:
              state.liveEditInspection.status === 'conflict'
                ? localEditInspection.targetGroupName
                : null
          }
        : localEditInspection
  const editInspectionPending =
    localEditInspection.status !== 'empty' &&
    localEditInspection.status !== 'unchanged' &&
    (state.editInspectionLoading ||
      state.editedName !== debouncedEditedName ||
      !state.liveEditInspection)

  return {
    sections,
    selectedGroup,
    selectedCandidate,
    selectedClaim,
    selectedConflict,
    ownerOptions,
    mergeActors,
    proposedOwner,
    ownershipReplacementClaimants,
    illegalReplacementClaimants,
    requiredReplacementClaimants,
    replacementInputs,
    editSourceName,
    editSourceType,
    localEditInspection,
    editInspection,
    editInspectionPending,
    canSubmitEditedName:
      !editInspectionPending &&
      editInspection.status !== 'empty' &&
      editInspection.status !== 'unchanged',
    canSubmitReplacement: canConfirmIllegalName(
      requiredReplacementClaimants,
      state.replacementMainNames,
      state.replacementValidationStatus
    )
  }
}
