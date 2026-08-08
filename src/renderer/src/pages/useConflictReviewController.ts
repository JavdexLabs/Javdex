import { useEffect, useMemo, useReducer, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ActressListItem } from '@shared/actressTypes'
import type {
  ActressConflictReviewSummary,
  ActressNameConflictGroup,
  PendingActressNameClaim,
  PendingActressScrapeCandidate
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
  type ConflictNameEditInspection,
  type ConflictReviewProposedOwner,
  type ConflictReviewSelection,
  type ConflictReviewTab,
  type IllegalNameReplacementValidationStatus
} from './actressConflictReviewState'
import {
  beginReplacementValidationStatus,
  chooseOtherOwnerRemote,
  discardConflictCandidate,
  resolveConflictDecision,
  runNameInspection,
  runOwnerSearch,
  runReplacementValidation,
  type ConflictReviewRemoteDeps
} from './conflictReviewRemote'
import {
  deriveConflictReviewDetail,
  initialConflictReviewSessionState,
  reduceConflictReviewSession,
  type ConflictReviewOwnerOption,
  type ConflictReviewSessionState,
  type ReplacementDialog
} from './conflictReviewSession'
import type { ActressConflictMergeActor } from './actressConflictReviewState'

const EMPTY_GROUPS: ActressNameConflictGroup[] = []

export interface ConflictReviewViewModel {
  queue: {
    loading: boolean
    error: string | null
    summary: ActressConflictReviewSummary | undefined
    groups: ActressNameConflictGroup[]
    sections: { pending: ActressNameConflictGroup[]; applicable: ActressNameConflictGroup[] }
    selectedGroup: ActressNameConflictGroup | null
    staleMessage: string | null
    focusAfterRefresh: string | null | undefined
    chooseGroup(group: ActressNameConflictGroup): void
    focusHandled(): void
  }
  detail: {
    selection: ConflictReviewSelection | null
    selectedCandidate: PendingActressScrapeCandidate | null
    selectedClaim: PendingActressNameClaim | null
    selectedConflict: PendingActressScrapeCandidate['conflicts'][number] | null
    ownerOptions: ConflictReviewOwnerOption[]
    mergeActors: ActressConflictMergeActor[]
    proposedOwner: ConflictReviewProposedOwner | null
    editSourceName: string
    editSourceType:
      | PendingActressScrapeCandidate['conflicts'][number]['type']
      | PendingActressNameClaim['type']
      | null
    editInspection: ConflictNameEditInspection
    editInspectionPending: boolean
    selectTab(tab: ConflictReviewTab): void
    selectOwner(owner: ConflictReviewProposedOwner): void
    selectSource(source: NonNullable<ConflictReviewSelection['source']>): void
    openEditName(): void
    openMerge(): void
    openIllegalName(): void
    openOtherOwner(): void
    confirmOwnership(): void
    applySelectedPending(): void
    requestDiscard(candidate: PendingActressScrapeCandidate): void
  }
  dialogs: {
    otherOwner: {
      open: boolean
      search: string
      options: ActressListItem[]
      loading: boolean
      selected: ActressListItem | null
      changeSearch(value: string): void
      choose(item: ActressListItem): void
      close(): void
    }
    editName: {
      open: boolean
      value: string
      change(value: string): void
      submit(): void
      close(): void
      canSubmit: boolean
    }
    merge: {
      open: boolean
      actors: ActressConflictMergeActor[]
      submit(decision: ConflictMergeActressesDecision): void
      close(): void
    }
    replacement: {
      kind: ReplacementDialog
      claimants: ActressNameConflictGroup['claimants']
      mainNames: Record<number, string>
      status: IllegalNameReplacementValidationStatus
      errors: Record<number, string>
      change(actressId: number, value: string): void
      submit(): void
      close(): void
      canSubmit: boolean
    }
    discard: {
      candidate: PendingActressScrapeCandidate | null
      busy: boolean
      confirm(): void
      cancel(): void
    }
  }
  busy: {
    resolving: boolean
  }
}

function createRemoteDeps(
  toast: { show(message: string, tone: 'success' | 'error' | 'info'): void },
  invalidateLibrary: () => Promise<void>,
  refetchGroups: () => Promise<ActressNameConflictGroup[]>
): ConflictReviewRemoteDeps {
  return {
    api: {
      listActresses: (search) => api.actresses.list(search, 'all'),
      getActress: (id) => api.actresses.get(id),
      inspectConflictName: (input) => api.actressScrape.inspectConflictName(input),
      validateIllegalNameReplacements: (input) =>
        api.actressScrape.validateIllegalNameReplacements(input),
      resolveConflict: (input) => api.actressScrape.resolveConflict(input),
      discardConflict: (input) => api.actressScrape.discardConflict(input)
    },
    toast,
    invalidateLibrary,
    refetchGroups
  }
}

export function useConflictReviewController(): ConflictReviewViewModel {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [state, dispatch] = useReducer(reduceConflictReviewSession, initialConflictReviewSessionState)
  const resolvingRef = useRef(false)
  const discardingRef = useRef(false)
  const discardCandidateRef = useRef(state.discardCandidate)
  discardCandidateRef.current = state.discardCandidate
  const editedNameRef = useRef(state.editedName)
  editedNameRef.current = state.editedName
  const replacementDialogRef = useRef(state.replacementDialog)
  replacementDialogRef.current = state.replacementDialog
  const replacementMainNamesRef = useRef(state.replacementMainNames)
  replacementMainNamesRef.current = state.replacementMainNames
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
  const derived = useMemo(
    () => deriveConflictReviewDetail(state, groups, debouncedEditedName),
    [debouncedEditedName, groups, state]
  )
  const replacementInputsKey = derived.replacementInputs
    .map((item) => `${item.actressId}:${item.mainName}`)
    .join('|')
  const replacementInputs = useMemo(
    () => derived.replacementInputs,
    // Intentionally key by contents; derive returns a fresh array each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [replacementInputsKey]
  )
  const debouncedReplacementInputs = useDebounce(replacementInputs, 250)

  const applyPatch = (patch: Partial<ConflictReviewSessionState>): void => {
    if (patch.resolving !== undefined) resolvingRef.current = patch.resolving
    if (patch.discarding !== undefined) discardingRef.current = patch.discarding
    dispatch({ type: 'patch', patch })
  }

  const toastRef = useRef(toast)
  toastRef.current = toast
  const refetchGroupsRef = useRef(groupsQuery.refetch)
  refetchGroupsRef.current = groupsQuery.refetch

  const remoteDeps = useMemo(
    () =>
      createRemoteDeps(
        {
          show(message, tone) {
            toastRef.current.show(message, tone)
          }
        },
        () => invalidateActressLibraryQueries(queryClient),
        async () => {
          const refreshed = await refetchGroupsRef.current()
          return refreshed.data ?? []
        }
      ),
    [queryClient]
  )

  useEffect(() => {
    dispatch({ type: 'syncSelectedGroup', group: derived.selectedGroup })
  }, [derived.selectedGroup])

  const ownerOptionsKey = derived.ownerOptions.map((owner) => owner.actressId).join(',')
  useEffect(() => {
    return runOwnerSearch({
      gate: ownerSearchGate.current,
      deps: remoteDeps,
      open: state.otherOwnerOpen,
      search: debouncedOwnerSearch,
      ownerOptions: derived.ownerOptions,
      selectedOtherOwner: state.selectedOtherOwner,
      apply: applyPatch
    })
    // ownerOptions identity changes every derive; key contents instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    debouncedOwnerSearch,
    ownerOptionsKey,
    remoteDeps,
    state.otherOwnerOpen,
    state.selectedOtherOwner
  ])

  useEffect(() => {
    return runNameInspection({
      gate: editInspectionGate.current,
      deps: remoteDeps,
      editNameOpen: state.editNameOpen,
      selectedGroup: derived.selectedGroup,
      groups,
      editSourceName: derived.editSourceName,
      debouncedEditedName,
      selectedCandidate: derived.selectedCandidate,
      selectedClaim: derived.selectedClaim,
      apply: applyPatch
    })
  }, [
    debouncedEditedName,
    derived.editSourceName,
    derived.selectedCandidate,
    derived.selectedClaim,
    derived.selectedGroup,
    groups,
    remoteDeps,
    state.editNameOpen
  ])

  useEffect(() => {
    const patch = beginReplacementValidationStatus({
      gate: replacementValidationGate.current,
      replacementDialog: state.replacementDialog,
      requiredCount: derived.requiredReplacementClaimants.length,
      replacementInputs
    })
    if (
      patch.replacementValidationStatus === state.replacementValidationStatus &&
      Object.keys(state.replacementValidationErrors).length === 0
    ) {
      return
    }
    applyPatch(patch)
  }, [
    derived.requiredReplacementClaimants.length,
    replacementInputs,
    state.replacementDialog,
    state.replacementValidationErrors,
    state.replacementValidationStatus
  ])

  useEffect(() => {
    return runReplacementValidation({
      gate: replacementValidationGate.current,
      deps: remoteDeps,
      replacementDialog: state.replacementDialog,
      selectedGroup: derived.selectedGroup,
      requiredCount: derived.requiredReplacementClaimants.length,
      debouncedReplacementInputs,
      proposedOwner: derived.proposedOwner,
      apply: applyPatch,
      onStale: () => dispatch({ type: 'staleReplacementValidation' })
    })
  }, [
    debouncedReplacementInputs,
    derived.proposedOwner,
    derived.requiredReplacementClaimants.length,
    derived.selectedGroup,
    remoteDeps,
    state.replacementDialog
  ])

  const applyRefresh = (args: {
    previousGroups: ActressNameConflictGroup[]
    refreshedGroups: ActressNameConflictGroup[]
    previousSelectedName: string | null
    stale: boolean
  }): void => {
    dispatch({
      type: 'applyRefresh',
      previousGroups: args.previousGroups,
      refreshedGroups: args.refreshedGroups,
      previousSelectedName: args.previousSelectedName,
      stale: args.stale
    })
  }

  const resolveDecision = (input: Parameters<typeof resolveConflictDecision>[0]['input']): void => {
    void resolveConflictDecision({
      deps: remoteDeps,
      resolving: resolvingRef.current,
      groups,
      selectedGroupName: derived.selectedGroup?.normalizedName ?? null,
      input,
      apply: applyPatch,
      applyRefresh,
      resetTransient: () => dispatch({ type: 'resetTransient' })
    })
  }

  const submitOwnership = (): void => {
    if (!derived.selectedGroup || !derived.proposedOwner) return
    resolveDecision({
      kind: 'assignToExistingActress',
      snapshot: buildActressConflictDecisionSnapshot(derived.selectedGroup),
      ownerActressId: derived.proposedOwner.actressId,
      ownerActressRevision: derived.proposedOwner.revision,
      replacementMainNames: derived.ownershipReplacementClaimants.map((claimant) => ({
        actressId: claimant.actressId,
        mainName: replacementMainNamesRef.current[claimant.actressId] ?? ''
      }))
    })
  }

  const submitIllegalName = (): void => {
    if (!derived.selectedGroup) return
    resolveDecision({
      kind: 'markIllegalName',
      snapshot: buildActressConflictDecisionSnapshot(derived.selectedGroup),
      replacementMainNames: derived.illegalReplacementClaimants.map((claimant) => ({
        actressId: claimant.actressId,
        mainName: replacementMainNamesRef.current[claimant.actressId] ?? ''
      }))
    })
  }

  return {
    queue: {
      loading: groupsQuery.isLoading,
      error: groupsQuery.error ? String((groupsQuery.error as Error).message) : null,
      summary: summaryQuery.data,
      groups,
      sections: derived.sections,
      selectedGroup: derived.selectedGroup,
      staleMessage: state.staleMessage,
      focusAfterRefresh: state.focusAfterRefresh,
      chooseGroup: (group) => dispatch({ type: 'chooseGroup', group }),
      focusHandled: () => dispatch({ type: 'focusHandled' })
    },
    detail: {
      selection: state.selection,
      selectedCandidate: derived.selectedCandidate,
      selectedClaim: derived.selectedClaim,
      selectedConflict: derived.selectedConflict,
      ownerOptions: derived.ownerOptions,
      mergeActors: derived.mergeActors,
      proposedOwner: derived.proposedOwner,
      editSourceName: derived.editSourceName,
      editSourceType: derived.editSourceType,
      editInspection: derived.editInspection,
      editInspectionPending: derived.editInspectionPending,
      selectTab: (tab) => dispatch({ type: 'selectTab', tab }),
      selectOwner: (owner) => dispatch({ type: 'selectOwner', owner }),
      selectSource: (source) => dispatch({ type: 'selectSource', source }),
      openEditName: () => dispatch({ type: 'openEditName', sourceName: derived.editSourceName }),
      openMerge: () => dispatch({ type: 'openMerge' }),
      openIllegalName: () => dispatch({ type: 'openIllegalName' }),
      openOtherOwner: () => dispatch({ type: 'openOtherOwner' }),
      confirmOwnership: () => {
        if (!derived.proposedOwner) return
        if (derived.ownershipReplacementClaimants.length > 0) {
          dispatch({ type: 'openOwnershipReplacement' })
        } else submitOwnership()
      },
      applySelectedPending: () => {
        if (!derived.selectedGroup || !derived.selectedCandidate) return
        resolveDecision({
          kind: 'applyPending',
          snapshot: buildActressConflictDecisionSnapshot(derived.selectedGroup),
          pendingId: derived.selectedCandidate.pendingId,
          replacementMainNames: []
        })
      },
      requestDiscard: (candidate) => dispatch({ type: 'requestDiscard', candidate })
    },
    dialogs: {
      otherOwner: {
        open: state.otherOwnerOpen,
        search: state.otherOwnerSearch,
        options: state.otherOwnerOptions,
        loading: state.otherOwnerLoading,
        selected: state.selectedOtherOwner,
        changeSearch: (value) => dispatch({ type: 'changeOtherOwnerSearch', value }),
        choose: (item) => {
          void chooseOtherOwnerRemote({
            deps: remoteDeps,
            item,
            onChosen: (chosen, revision) =>
              dispatch({ type: 'chooseOtherOwner', item: chosen, revision })
          })
        },
        close: () => dispatch({ type: 'closeOtherOwner' })
      },
      editName: {
        open: state.editNameOpen,
        value: state.editedName,
        change: (value) => dispatch({ type: 'changeEditedName', value }),
        submit: () => {
          if (
            !derived.selectedGroup ||
            !derived.editSourceType ||
            !derived.canSubmitEditedName
          ) {
            return
          }
          if (derived.selectedCandidate && derived.selectedConflict) {
            resolveDecision({
              kind: 'editName',
              snapshot: buildActressConflictDecisionSnapshot(derived.selectedGroup),
              pendingId: derived.selectedCandidate.pendingId,
              name: derived.selectedConflict.name,
              nameType: derived.selectedConflict.type,
              newName: editedNameRef.current,
              replacementMainNames: []
            })
          } else if (derived.selectedClaim) {
            resolveDecision({
              kind: 'editPendingNameClaim',
              snapshot: buildActressConflictDecisionSnapshot(derived.selectedGroup),
              claimId: derived.selectedClaim.claimId,
              actressId: derived.selectedClaim.actressId,
              name: derived.selectedClaim.name,
              nameType: derived.selectedClaim.type,
              newName: editedNameRef.current,
              replacementMainNames: []
            })
          }
        },
        close: () => dispatch({ type: 'closeEditName' }),
        canSubmit: derived.canSubmitEditedName && !state.resolving
      },
      merge: {
        open: state.mergeOpen,
        actors: derived.mergeActors,
        submit: (decision) => {
          if (!derived.selectedGroup) return
          const pending = derived.selectedGroup.candidates.find(
            (item) =>
              item.actressId === decision.keepActressId ||
              item.actressId === decision.mergeActressId
          )
          resolveDecision({
            kind: 'mergeActresses',
            snapshot: buildActressConflictDecisionSnapshot(derived.selectedGroup),
            ...(pending ? { pendingId: pending.pendingId } : {}),
            ...decision,
            replacementMainNames: []
          })
        },
        close: () => dispatch({ type: 'closeMerge' })
      },
      replacement: {
        kind: state.replacementDialog,
        claimants: derived.requiredReplacementClaimants,
        mainNames: state.replacementMainNames,
        status: state.replacementValidationStatus,
        errors: state.replacementValidationErrors,
        change: (actressId, value) =>
          dispatch({ type: 'changeReplacementMainName', actressId, value }),
        submit: () => {
          if (replacementDialogRef.current === 'illegal') submitIllegalName()
          else submitOwnership()
        },
        close: () => dispatch({ type: 'closeReplacement' }),
        canSubmit: derived.canSubmitReplacement && !state.resolving
      },
      discard: {
        candidate: state.discardCandidate,
        busy: state.discarding,
        confirm: () => {
          void discardConflictCandidate({
            deps: remoteDeps,
            discarding: discardingRef.current,
            discardCandidate: discardCandidateRef.current,
            groups,
            selectedGroupName: derived.selectedGroup?.normalizedName ?? null,
            apply: applyPatch,
            applyRefresh
          })
        },
        cancel: () => dispatch({ type: 'cancelDiscard' })
      }
    },
    busy: {
      resolving: state.resolving
    }
  }
}
