import { useEffect, useMemo, useReducer, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ActressPickerItem } from '@shared/actressTypes'
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
    summaryError: boolean
    retry(): void
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
      options: ActressPickerItem[]
      loading: boolean
      offset: number
      hasMore: boolean
      error: string | null
      choosingId: number | null
      previousPage(): void
      nextPage(): void
      retry(): void
      selected: ActressPickerItem | null
      changeSearch(value: string): void
      choose(item: ActressPickerItem): void
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
  refetchGroups: (selectedName?: string | null) => Promise<ActressNameConflictGroup[]>
): ConflictReviewRemoteDeps {
  return {
    api: {
      pageActresses: (query) => api.actresses.pickerPage(query),
      getActressIdentity: (id) => api.actresses.pickerGet(id),
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

export function useConflictReviewController({ enabled = true, summaryEnabled = true, paged }: {
  enabled?: boolean; summaryEnabled?: boolean
  paged?: { selectedName: string | null; sessionKey?: string; onResolved(previousName: string | null): Promise<void> }
} = {}): ConflictReviewViewModel {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [state, dispatch] = useReducer(reduceConflictReviewSession, initialConflictReviewSessionState)
  const resolvingRef = useRef(false)
  const discardingRef = useRef(false)
  const discardDialogIdentity = useRef<object | null>(null)
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
  const ownerChoiceGate = useRef(createLatestRequestGate())
  useEffect(() => () => { ownerChoiceGate.current.next() }, [])
  const replacementValidationGate = useRef(createLatestRequestGate())
  const debouncedOwnerSearch = useDebounce(state.otherOwnerSearch, 250)
  const debouncedEditedName = useDebounce(state.editedName, 250)

  const groupsQuery = useQuery({
    queryKey: actressKeys.conflicts(),
    queryFn: () => api.actressScrape.listConflicts(),
    enabled: enabled && !paged
  })
  const summaryQuery = useQuery({
    queryKey: actressKeys.conflictSummary(),
    queryFn: () => api.actressScrape.conflictSummary(),
    enabled: summaryEnabled
  })
  const lastName = useRef<string | null>(null)
  if (paged?.selectedName != null) lastName.current = paged.selectedName
  const detailName = paged?.selectedName ?? lastName.current
  const sessionKey = paged?.sessionKey ?? detailName
  const selectionSession = useRef({ key: sessionKey })
  if (selectionSession.current.key !== sessionKey) selectionSession.current = { key: sessionKey }
  const renderSession = selectionSession.current
  const detailQuery = useQuery({
    queryKey: [...actressKeys.conflicts(), 'detail', detailName],
    queryFn: () => api.actressScrape.getConflict(detailName!),
    enabled: Boolean(paged && enabled && paged.selectedName != null),
    gcTime: 0
  })
  // Keep one selected snapshot while another category/overlay disables reads.
  const detailGroups = useMemo(() => detailQuery.data ? [detailQuery.data] : EMPTY_GROUPS, [detailQuery.data])
  const groups = paged ? detailGroups : groupsQuery.data ?? EMPTY_GROUPS
  const pagedRef = useRef(paged)
  pagedRef.current = paged
  const detailRefetchRef = useRef(detailQuery.refetch)
  detailRefetchRef.current = detailQuery.refetch
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
        async (previousName) => {
          if (pagedRef.current) {
            const refreshed = await detailRefetchRef.current()
            await pagedRef.current.onResolved(previousName ?? null)
            return refreshed.data ? [refreshed.data] : []
          }
          const refreshed = await refetchGroupsRef.current()
          return refreshed.data ?? []
        }
      ),
    [queryClient]
  )

  useEffect(() => {
    dispatch({ type: 'syncSelectedGroup', group: derived.selectedGroup })
  }, [derived.selectedGroup, state.selectionGroupName])

  const ownerPickerKey = JSON.stringify([derived.selectedGroup?.normalizedName, enabled, state.otherOwnerOpen, state.otherOwnerSearch, state.otherOwnerOffset])
  const ownerPickerSession = useRef({ group: renderSession, key: ownerPickerKey })
  if (ownerPickerSession.current.group !== renderSession || ownerPickerSession.current.key !== ownerPickerKey) {
    ownerPickerSession.current = { group: renderSession, key: ownerPickerKey }
  }
  useEffect(() => {
    dispatch({ type: 'patch', patch: { otherOwnerChoosingId: null } })
  }, [ownerPickerKey, renderSession])
  const ownerOptionsKey = derived.ownerOptions.map((owner) => owner.actressId).join(',')
  useEffect(() => {
    return runOwnerSearch({
      gate: ownerSearchGate.current,
      deps: remoteDeps,
      open: state.otherOwnerOpen && enabled,
      ready: state.otherOwnerSearch === debouncedOwnerSearch,
      offset: state.otherOwnerOffset,
      search: debouncedOwnerSearch,
      ownerOptions: derived.ownerOptions,
      apply: applyPatch
    })
    // ownerOptions identity changes every derive; key contents instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    debouncedOwnerSearch,
    ownerOptionsKey,
    remoteDeps,
    state.otherOwnerOpen,
    state.otherOwnerSearch,
    state.otherOwnerOffset,
    state.otherOwnerRetry,
    enabled
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
    if (pagedRef.current && (args.previousSelectedName !== lastName.current || renderSession !== selectionSession.current)) return
    dispatch({
      type: 'applyRefresh',
      previousGroups: args.previousGroups,
      refreshedGroups: args.refreshedGroups,
      previousSelectedName: args.previousSelectedName,
      stale: args.stale
    })
  }

  const resolveDecision = (input: Parameters<typeof resolveConflictDecision>[0]['input']): void => {
    ownerChoiceGate.current.next()
    dispatch({ type: 'patch', patch: { otherOwnerChoosingId: null } })
    const operationSession = selectionSession.current
    const isCurrent = (): boolean => !pagedRef.current || selectionSession.current === operationSession
    void resolveConflictDecision({
      deps: remoteDeps,
      resolving: resolvingRef.current,
      groups,
      selectedGroupName: derived.selectedGroup?.normalizedName ?? null,
      input,
      apply: (patch) => {
        if (isCurrent()) applyPatch(patch)
        else if (patch.resolving !== undefined) applyPatch({resolving:patch.resolving})
      },
      applyRefresh,
      resetTransient: () => { if (isCurrent()) dispatch({ type: 'resetTransient' }) }
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
      loading: enabled && (paged ? detailQuery.isLoading : groupsQuery.isLoading),
      error: (paged ? detailQuery.error : groupsQuery.error)?.message ?? null,
      retry: () => { void (paged ? detailQuery.refetch() : groupsQuery.refetch()) },
      summary: summaryQuery.data,
      summaryError: summaryQuery.isError,
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
      selectOwner: (owner) => {
        ownerChoiceGate.current.next()
        dispatch({ type: 'selectOwner', owner })
      },
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
      requestDiscard: (candidate) => {
        discardDialogIdentity.current = {}
        dispatch({ type: 'requestDiscard', candidate })
      }
    },
    dialogs: {
      otherOwner: {
        open: state.otherOwnerOpen,
        search: state.otherOwnerSearch,
        options: state.otherOwnerOptions,
        loading: state.otherOwnerLoading,
        offset: state.otherOwnerOffset,
        hasMore: state.otherOwnerHasMore,
        error: state.otherOwnerError,
        choosingId: state.otherOwnerChoosingId,
        previousPage: () => { if (!state.otherOwnerLoading && state.otherOwnerOffset > 0) dispatch({ type: 'changeOtherOwnerPage', offset: Math.max(0, state.otherOwnerOffset - 40) }) },
        nextPage: () => { if (!state.otherOwnerLoading && state.otherOwnerHasMore) dispatch({ type: 'changeOtherOwnerPage', offset: state.otherOwnerOffset + 40 }) },
        retry: () => dispatch({ type: 'retryOtherOwner' }),
        selected: state.selectedOtherOwner,
        changeSearch: (value) => dispatch({ type: 'changeOtherOwnerSearch', value }),
        choose: (item) => {
          const requestId = ownerChoiceGate.current.next()
          const session = ownerPickerSession.current
          const isCurrent = () => ownerChoiceGate.current.isLatest(requestId) && ownerPickerSession.current === session
          dispatch({ type: 'patch', patch: { otherOwnerChoosingId: item.id } })
          void chooseOtherOwnerRemote({
            deps: remoteDeps,
            item,
            isCurrent,
            onChosen: (chosen, revision) =>
              dispatch({ type: 'chooseOtherOwner', item: chosen, revision })
          }).finally(() => { if (isCurrent()) dispatch({ type: 'patch', patch: { otherOwnerChoosingId: null } }) })
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
          const operationSession = selectionSession.current
          const operationDialog = discardDialogIdentity.current
          void discardConflictCandidate({
            deps: remoteDeps,
            discarding: discardingRef.current,
            discardCandidate: discardCandidateRef.current,
            groups,
            selectedGroupName: derived.selectedGroup?.normalizedName ?? null,
            apply: (patch) => {
              if (!pagedRef.current || selectionSession.current === operationSession) applyPatch(patch)
              else {
                const completion: Partial<ConflictReviewSessionState> = {}
                if (patch.discarding !== undefined) completion.discarding = patch.discarding
                if (patch.discardCandidate === null && discardDialogIdentity.current === operationDialog) completion.discardCandidate = null
                if (Object.keys(completion).length > 0) applyPatch(completion)
              }
            },
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
