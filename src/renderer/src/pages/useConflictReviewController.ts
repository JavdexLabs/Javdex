import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ActressListItem } from '@shared/actressTypes'
import type {
  ActressNameConflictGroup,
  PendingActressScrapeCandidate,
  ResolveActressConflictInput
} from '@shared/actressConflictTypes'
import { api } from '../api'
import { useToast } from '../components/Toast'
import { useDebounce } from '../hooks/useDebounce'
import { invalidateActressLibraryQueries } from '../query/invalidateLibraryQueries'
import { actressKeys } from '../query/queryKeys'
import type { ConflictMergeActressesDecision } from './ConflictMergeActressesModal'
import { createLatestRequestGate } from './latestRequestGate'
import {
  buildActressConflictDecisionSnapshot,
  buildActressConflictMergeActors,
  buildConflictQueueSections,
  buildConflictReviewRefreshState,
  conflictClaimantsNeedingReplacement,
  createConflictReviewSelection,
  inspectConflictNameEdit,
  selectConflictProposedOwner,
  selectConflictSource,
  type ConflictReviewProposedOwner,
  type ConflictReviewSelection,
  type ConflictReviewTab,
  type IllegalNameReplacementValidationStatus
} from './actressConflictReviewState'

type ReplacementDialog = 'ownership' | 'illegal' | null

interface ControllerState {
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

type ControllerAction =
  | { type: 'patch'; patch: Partial<ControllerState> }
  | { type: 'update'; update: (state: ControllerState) => Partial<ControllerState> }
  | { type: 'resetTransient' }

const initialState: ControllerState = {
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

const EMPTY_GROUPS: ActressNameConflictGroup[] = []
const EMPTY_REPLACEMENT_CLAIMANTS: ActressNameConflictGroup['claimants'] = []

function reducer(state: ControllerState, action: ControllerAction): ControllerState {
  if (action.type === 'patch') return { ...state, ...action.patch }
  if (action.type === 'update') return { ...state, ...action.update(state) }
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

export function useConflictReviewController() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [state, dispatch] = useReducer(reducer, initialState)
  const editInspectionGate = useRef(createLatestRequestGate())
  const ownerSearchGate = useRef(createLatestRequestGate())
  const replacementValidationGate = useRef(createLatestRequestGate())
  const debouncedOwnerSearch = useDebounce(state.otherOwnerSearch, 250)
  const debouncedEditedName = useDebounce(state.editedName, 250)

  const groupsQuery = useQuery({
    queryKey: actressKeys.conflicts(),
    queryFn: () => api.actressScrape.listConflicts()
  })
  const summaryQuery = useQuery({
    queryKey: actressKeys.conflictSummary(),
    queryFn: () => api.actressScrape.conflictSummary()
  })
  const groups = groupsQuery.data ?? EMPTY_GROUPS
  const sections = useMemo(() => buildConflictQueueSections(groups), [groups])
  const selectedGroup =
    groups.find((group) => group.normalizedName === state.selectedName) ?? groups[0] ?? null
  const selectedCandidate =
    state.selection?.source?.kind === 'scrape'
      ? selectedGroup?.candidates.find((candidate) => candidate.pendingId === state.selection?.source?.id) ?? null
      : null
  const selectedClaim =
    state.selection?.source?.kind === 'claim'
      ? selectedGroup?.pendingNameClaims.find((claim) => claim.claimId === state.selection?.source?.id) ?? null
      : null
  const selectedConflict =
    selectedCandidate?.conflicts.find(
      (conflict) => conflict.normalizedName === selectedGroup?.normalizedName
    ) ?? null
  const ownerOptions = useMemo(
    () => (selectedGroup ? buildOwnerOptions(selectedGroup) : []),
    [selectedGroup]
  )
  const mergeActors = useMemo(
    () => (selectedGroup ? buildActressConflictMergeActors(selectedGroup) : []),
    [selectedGroup]
  )
  const proposedOwner = state.selection?.proposedOwner ?? null
  const ownershipReplacementClaimants = useMemo(
    () => selectedGroup ? conflictClaimantsNeedingReplacement(selectedGroup, proposedOwner?.actressId) : [],
    [proposedOwner?.actressId, selectedGroup]
  )
  const illegalReplacementClaimants = useMemo(
    () => selectedGroup ? conflictClaimantsNeedingReplacement(selectedGroup, null) : [],
    [selectedGroup]
  )
  const requiredReplacementClaimants =
    state.replacementDialog === 'ownership'
      ? ownershipReplacementClaimants
      : state.replacementDialog === 'illegal'
        ? illegalReplacementClaimants
        : EMPTY_REPLACEMENT_CLAIMANTS
  const replacementInputs = useMemo(
    () => requiredReplacementClaimants.map((claimant) => ({
      actressId: claimant.actressId,
      mainName: state.replacementMainNames[claimant.actressId] ?? ''
    })),
    [requiredReplacementClaimants, state.replacementMainNames]
  )
  const debouncedReplacementInputs = useDebounce(replacementInputs, 250)
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
            targetGroupName: state.liveEditInspection.status === 'conflict'
              ? localEditInspection.targetGroupName
              : null
          }
        : localEditInspection
  const editInspectionPending =
    localEditInspection.status !== 'empty' &&
    localEditInspection.status !== 'unchanged' &&
    (state.editInspectionLoading || state.editedName !== debouncedEditedName || !state.liveEditInspection)

  const resetTransientState = useCallback(() => dispatch({ type: 'resetTransient' }), [])

  useEffect(() => {
    if (!selectedGroup) {
      if (state.selectedName !== null || state.selection !== null || state.selectionGroupName !== null) {
        dispatch({ type: 'patch', patch: { selectedName: null, selection: null, selectionGroupName: null } })
      }
      return
    }
    if (state.selectionGroupName !== selectedGroup.normalizedName) {
      dispatch({
        type: 'patch',
        patch: {
          selectedName: selectedGroup.normalizedName,
          selection: createConflictReviewSelection(selectedGroup),
          selectionGroupName: selectedGroup.normalizedName
        }
      })
      resetTransientState()
    } else if (state.selectedName !== selectedGroup.normalizedName) {
      dispatch({ type: 'patch', patch: { selectedName: selectedGroup.normalizedName } })
    }
  }, [resetTransientState, selectedGroup, state.selectedName, state.selectionGroupName])

  useEffect(() => {
    const requestId = ownerSearchGate.current.next()
    if (!state.otherOwnerOpen) return
    dispatch({ type: 'patch', patch: { otherOwnerLoading: true } })
    void api.actresses.list(debouncedOwnerSearch.trim(), 'all')
      .then((items) => {
        if (!ownerSearchGate.current.isLatest(requestId)) return
        const visibleItems = items
          .filter((item) => ownerOptions.every((owner) => owner.actressId !== item.id))
          .slice(0, 40)
        const keepSelected = debouncedOwnerSearch.trim() === '' &&
          state.selectedOtherOwner != null &&
          !visibleItems.some((item) => item.id === state.selectedOtherOwner?.id)
        dispatch({
          type: 'patch',
          patch: {
            otherOwnerOptions: keepSelected
              ? [state.selectedOtherOwner!, ...visibleItems].slice(0, 40)
              : visibleItems
          }
        })
      })
      .catch((error) => {
        if (ownerSearchGate.current.isLatest(requestId)) toast.show(String((error as Error).message), 'error')
      })
      .finally(() => {
        if (ownerSearchGate.current.isLatest(requestId)) dispatch({ type: 'patch', patch: { otherOwnerLoading: false } })
      })
    return () => ownerSearchGate.current.invalidate(requestId)
  }, [debouncedOwnerSearch, ownerOptions, state.otherOwnerOpen, state.selectedOtherOwner, toast])

  useEffect(() => {
    const requestId = editInspectionGate.current.next()
    dispatch({ type: 'patch', patch: { liveEditInspection: null } })
    if (!state.editNameOpen || !selectedGroup) {
      dispatch({ type: 'patch', patch: { editInspectionLoading: false } })
      return
    }
    const local = inspectConflictNameEdit(editSourceName, debouncedEditedName, groups)
    const actressId = selectedCandidate?.actressId ?? selectedClaim?.actressId
    if (actressId == null || local.status === 'empty' || local.status === 'unchanged') {
      dispatch({ type: 'patch', patch: { editInspectionLoading: false } })
      return
    }
    dispatch({ type: 'patch', patch: { editInspectionLoading: true } })
    void api.actressScrape.inspectConflictName({
      actressId,
      name: debouncedEditedName,
      ...(selectedCandidate ? { pendingId: selectedCandidate.pendingId } : {})
    }).then((inspection) => {
      if (editInspectionGate.current.isLatest(requestId)) dispatch({ type: 'patch', patch: { liveEditInspection: inspection } })
    }).catch((error) => {
      if (editInspectionGate.current.isLatest(requestId)) toast.show(String((error as Error).message), 'error')
    }).finally(() => {
      if (editInspectionGate.current.isLatest(requestId)) dispatch({ type: 'patch', patch: { editInspectionLoading: false } })
    })
    return () => editInspectionGate.current.invalidate(requestId)
  }, [debouncedEditedName, editSourceName, groups, selectedCandidate, selectedClaim, selectedGroup, state.editNameOpen, toast])

  useEffect(() => {
    replacementValidationGate.current.next()
    const status: IllegalNameReplacementValidationStatus = !state.replacementDialog
      ? 'idle'
      : requiredReplacementClaimants.length === 0
        ? 'valid'
        : replacementInputs.some((replacement) => !replacement.mainName.trim())
          ? 'idle'
          : 'checking'
    dispatch({ type: 'patch', patch: { replacementValidationErrors: {}, replacementValidationStatus: status } })
  }, [replacementInputs, requiredReplacementClaimants.length, state.replacementDialog])

  useEffect(() => {
    if (!state.replacementDialog || !selectedGroup || requiredReplacementClaimants.length === 0 ||
        debouncedReplacementInputs.some((replacement) => !replacement.mainName.trim())) return
    const requestId = replacementValidationGate.current.next()
    void api.actressScrape.validateIllegalNameReplacements({
      snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
      replacementMainNames: debouncedReplacementInputs,
      ...(state.replacementDialog === 'ownership' && proposedOwner
        ? { destinationOwnerActressId: proposedOwner.actressId }
        : {})
    }).then((result) => {
      if (!replacementValidationGate.current.isLatest(requestId)) return
      if (result.status === 'valid') {
        dispatch({ type: 'patch', patch: { replacementValidationStatus: 'valid' } })
      } else if (result.status === 'invalid') {
        dispatch({
          type: 'patch',
          patch: {
            replacementValidationStatus: 'invalid',
            replacementValidationErrors: Object.fromEntries(result.errors.map((error) => [error.actressId, error.message]))
          }
        })
      } else {
        dispatch({
          type: 'update',
          update: (current) => ({
            replacementDialog: null,
            staleMessage: '数据已变化，已刷新，请重新确认',
            selection: current.selection ? selectConflictProposedOwner(current.selection, null) : current.selection,
            selectedOtherOwner: null
          })
        })
        void invalidateActressLibraryQueries(queryClient)
      }
    }).catch((error) => {
      if (!replacementValidationGate.current.isLatest(requestId)) return
      dispatch({ type: 'patch', patch: { replacementValidationStatus: 'invalid' } })
      toast.show(String((error as Error).message), 'error')
    })
    return () => replacementValidationGate.current.invalidate(requestId)
  }, [debouncedReplacementInputs, proposedOwner, queryClient, requiredReplacementClaimants.length, selectedGroup, state.replacementDialog, toast])

  const chooseGroup = (group: ActressNameConflictGroup): void => {
    dispatch({
      type: 'patch',
      patch: {
        staleMessage: null,
        selectedName: group.normalizedName,
        selectionGroupName: group.normalizedName,
        selection: createConflictReviewSelection(group)
      }
    })
    resetTransientState()
  }

  const selectAfterRefresh = (
    previousGroups: ActressNameConflictGroup[],
    refreshedGroups: ActressNameConflictGroup[],
    previousSelectedName: string | null,
    stale = false
  ): void => {
    const next = buildConflictReviewRefreshState(previousGroups, refreshedGroups, previousSelectedName, stale)
    dispatch({
      type: 'patch',
      patch: {
        selectedName: next.selectedNormalizedName,
        selectionGroupName: null,
        selection: next.selection,
        staleMessage: next.staleMessage,
        focusAfterRefresh: next.focusTarget.kind === 'group' ? next.focusTarget.normalizedName : null
      }
    })
  }

  const resolveDecision = async (input: ResolveActressConflictInput): Promise<void> => {
    if (state.resolving) return
    const previousGroups = groups
    const previousSelectedName = selectedGroup?.normalizedName ?? null
    dispatch({ type: 'patch', patch: { resolving: true } })
    try {
      const outcome = await api.actressScrape.resolveConflict(input)
      await invalidateActressLibraryQueries(queryClient)
      const refreshed = await groupsQuery.refetch()
      if (outcome.status === 'stale') {
        dispatch({ type: 'patch', patch: { replacementDialog: null } })
        toast.show(outcome.message, 'info')
      } else {
        resetTransientState()
        toast.show('名称冲突已处理', 'success')
      }
      selectAfterRefresh(previousGroups, refreshed.data ?? [], previousSelectedName, outcome.status === 'stale')
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    } finally {
      dispatch({ type: 'patch', patch: { resolving: false } })
    }
  }

  const submitOwnership = (): void => {
    if (!selectedGroup || !proposedOwner) return
    void resolveDecision({
      kind: 'assignToExistingActress',
      snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
      ownerActressId: proposedOwner.actressId,
      ownerActressRevision: proposedOwner.revision,
      replacementMainNames: ownershipReplacementClaimants.map((claimant) => ({
        actressId: claimant.actressId,
        mainName: state.replacementMainNames[claimant.actressId] ?? ''
      }))
    })
  }

  const confirmOwnership = (): void => {
    if (!proposedOwner) return
    if (ownershipReplacementClaimants.length > 0) {
      dispatch({ type: 'patch', patch: { replacementMainNames: {}, replacementDialog: 'ownership' } })
    } else submitOwnership()
  }

  const applySelectedPending = (): void => {
    if (!selectedGroup || !selectedCandidate) return
    void resolveDecision({
      kind: 'applyPending',
      snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
      pendingId: selectedCandidate.pendingId,
      replacementMainNames: []
    })
  }

  const submitEditedName = (): void => {
    if (!selectedGroup || !editSourceType || editInspectionPending ||
        editInspection.status === 'empty' || editInspection.status === 'unchanged') return
    if (selectedCandidate && selectedConflict) {
      void resolveDecision({
        kind: 'editName',
        snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
        pendingId: selectedCandidate.pendingId,
        name: selectedConflict.name,
        nameType: selectedConflict.type,
        newName: state.editedName,
        replacementMainNames: []
      })
    } else if (selectedClaim) {
      void resolveDecision({
        kind: 'editPendingNameClaim',
        snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
        claimId: selectedClaim.claimId,
        actressId: selectedClaim.actressId,
        name: selectedClaim.name,
        nameType: selectedClaim.type,
        newName: state.editedName,
        replacementMainNames: []
      })
    }
  }

  const submitIllegalName = (): void => {
    if (!selectedGroup) return
    void resolveDecision({
      kind: 'markIllegalName',
      snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
      replacementMainNames: illegalReplacementClaimants.map((claimant) => ({
        actressId: claimant.actressId,
        mainName: state.replacementMainNames[claimant.actressId] ?? ''
      }))
    })
  }

  const submitMerge = (decision: ConflictMergeActressesDecision): void => {
    if (!selectedGroup) return
    const pending = selectedGroup.candidates.find((candidate) =>
      candidate.actressId === decision.keepActressId || candidate.actressId === decision.mergeActressId)
    void resolveDecision({
      kind: 'mergeActresses',
      snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
      ...(pending ? { pendingId: pending.pendingId } : {}),
      ...decision,
      replacementMainNames: []
    })
  }

  const discard = async (): Promise<void> => {
    if (!state.discardCandidate || state.discarding) return
    const previousGroups = groups
    const previousSelectedName = selectedGroup?.normalizedName ?? null
    dispatch({ type: 'patch', patch: { discarding: true } })
    try {
      await api.actressScrape.discardConflict({
        pendingId: state.discardCandidate.pendingId,
        expectedRevision: state.discardCandidate.revision
      })
      dispatch({ type: 'patch', patch: { discardCandidate: null } })
      await invalidateActressLibraryQueries(queryClient)
      const refreshed = await groupsQuery.refetch()
      selectAfterRefresh(previousGroups, refreshed.data ?? [], previousSelectedName)
      toast.show('已丢弃错误匹配并清理暂存资源', 'success')
    } catch (error) {
      const message = String((error as Error).message)
      await invalidateActressLibraryQueries(queryClient)
      const refreshed = await groupsQuery.refetch()
      dispatch({ type: 'patch', patch: { discardCandidate: null } })
      selectAfterRefresh(previousGroups, refreshed.data ?? [], previousSelectedName, true)
      toast.show(message, 'error')
    } finally {
      dispatch({ type: 'patch', patch: { discarding: false } })
    }
  }

  const chooseOtherOwner = async (item: ActressListItem): Promise<void> => {
    try {
      const detail = item.revision == null ? await api.actresses.get(item.id) : null
      const revision = item.revision ?? detail?.revision
      if (revision == null) throw new Error('无法读取演员当前版本，请刷新后重试')
      dispatch({
        type: 'update',
        update: (current) => ({
          selection: current.selection
            ? selectConflictProposedOwner(current.selection, { actressId: item.id, revision, mainName: item.main_name })
            : current.selection,
          selectedOtherOwner: item,
          otherOwnerOpen: false,
          otherOwnerSearch: ''
        })
      })
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    }
  }

  return {
    ...state,
    groupsQuery,
    summary: summaryQuery.data,
    groups,
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
    editSourceName,
    editSourceType,
    editInspection,
    editInspectionPending,
    chooseGroup,
    selectTab: (tab: ConflictReviewTab) => dispatch({ type: 'update', update: (current) => ({
      selection: current.selection ? { ...current.selection, tab } : current.selection
    }) }),
    selectOwner: (owner: ConflictReviewProposedOwner) => dispatch({ type: 'update', update: (current) => ({
      selectedOtherOwner: null,
      selection: current.selection ? selectConflictProposedOwner(current.selection, owner) : current.selection
    }) }),
    selectSource: (source: NonNullable<ConflictReviewSelection['source']>) => dispatch({ type: 'update', update: (current) => ({
      selection: current.selection ? selectConflictSource(current.selection, source) : current.selection
    }) }),
    openOtherOwner: () => dispatch({ type: 'patch', patch: { otherOwnerOpen: true, otherOwnerSearch: '' } }),
    closeOtherOwner: () => dispatch({ type: 'patch', patch: { otherOwnerOpen: false, otherOwnerSearch: '' } }),
    changeOtherOwnerSearch: (value: string) => dispatch({ type: 'patch', patch: { otherOwnerSearch: value } }),
    chooseOtherOwner,
    openEditName: () => {
      if (editSourceName) dispatch({ type: 'patch', patch: { editedName: editSourceName, editNameOpen: true } })
    },
    closeEditName: () => dispatch({ type: 'patch', patch: { editNameOpen: false } }),
    changeEditedName: (value: string) => dispatch({ type: 'patch', patch: { editedName: value } }),
    openMerge: () => dispatch({ type: 'patch', patch: { mergeOpen: true } }),
    closeMerge: () => dispatch({ type: 'patch', patch: { mergeOpen: false } }),
    openIllegalName: () => dispatch({ type: 'patch', patch: { replacementMainNames: {}, replacementDialog: 'illegal' } }),
    closeReplacement: () => dispatch({ type: 'patch', patch: { replacementDialog: null, replacementMainNames: {} } }),
    changeReplacementMainName: (actressId: number, value: string) => dispatch({ type: 'update', update: (current) => ({
      replacementMainNames: { ...current.replacementMainNames, [actressId]: value }
    }) }),
    requestDiscard: (candidate: PendingActressScrapeCandidate) => dispatch({ type: 'patch', patch: { discardCandidate: candidate } }),
    cancelDiscard: () => dispatch({ type: 'patch', patch: { discardCandidate: null } }),
    confirmOwnership,
    applySelectedPending,
    submitEditedName,
    submitIllegalName,
    submitOwnership,
    submitMerge,
    discard,
    focusHandled: () => dispatch({ type: 'patch', patch: { focusAfterRefresh: undefined } })
  }
}

function buildOwnerOptions(group: ActressNameConflictGroup) {
  const options = new Map<number, {
    actressId: number
    revision: number
    mainName: string
    avatarPath: string | null
    roles: string[]
  }>()
  const ensure = (actressId: number, revision: number, mainName: string, avatarPath: string | null, role: string) => {
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
    ensure(candidate.actressId, candidate.actressRevision, candidate.actressMainName, candidate.actressAvatarPath, '本次刮削目标')
  }
  return [...options.values()].sort((left, right) => left.mainName.localeCompare(right.mainName, 'zh-Hans-CN'))
}
