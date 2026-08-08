import type { ActressListItem } from '@shared/actressTypes'
import type {
  ActressNameConflictGroup,
  PendingActressNameClaim,
  PendingActressScrapeCandidate,
  ResolveActressConflictInput,
  ValidateIllegalNameReplacementsInput
} from '@shared/actressConflictTypes'
import { buildActressConflictDecisionSnapshot, inspectConflictNameEdit } from './actressConflictReviewState'
import type { LatestRequestGate } from './latestRequestGate'
import type {
  ConflictReviewOwnerOption,
  ConflictReviewSessionState,
  ReplacementDialog
} from './conflictReviewSession'
import type { ConflictReviewProposedOwner } from './actressConflictReviewState'

export type ToastTone = 'success' | 'error' | 'info'

export interface ConflictReviewRemoteApi {
  listActresses(search: string): Promise<ActressListItem[]>
  getActress(id: number): Promise<{ revision?: number } | null>
  inspectConflictName(input: {
    actressId: number
    name: string
    pendingId?: number
  }): Promise<{ normalizedName: string; status: 'available' | 'conflict' }>
  validateIllegalNameReplacements(
    input: ValidateIllegalNameReplacementsInput
  ): Promise<
    | { status: 'valid' }
    | { status: 'invalid'; errors: Array<{ actressId: number; message: string }> }
    | { status: 'stale' }
  >
  resolveConflict(
    input: ResolveActressConflictInput
  ): Promise<{ status: 'success'; remainingPending: number } | { status: 'stale'; message: string }>
  discardConflict(input: {
    pendingId: number
    expectedRevision: number
  }): Promise<{ remainingPending: number }>
}

export interface ConflictReviewRemoteDeps {
  api: ConflictReviewRemoteApi
  toast: { show(message: string, tone: ToastTone): void }
  invalidateLibrary(): Promise<void>
  refetchGroups(): Promise<ActressNameConflictGroup[]>
}

export type SessionPatch = Partial<ConflictReviewSessionState>

export function runOwnerSearch(options: {
  gate: LatestRequestGate
  deps: ConflictReviewRemoteDeps
  open: boolean
  search: string
  ownerOptions: ConflictReviewOwnerOption[]
  selectedOtherOwner: ActressListItem | null
  apply: (patch: SessionPatch) => void
}): () => void {
  const requestId = options.gate.next()
  if (!options.open) return () => options.gate.invalidate(requestId)
  options.apply({ otherOwnerLoading: true })
  void options.deps.api
    .listActresses(options.search.trim())
    .then((items) => {
      if (!options.gate.isLatest(requestId)) return
      const visibleItems = items
        .filter((item) => options.ownerOptions.every((owner) => owner.actressId !== item.id))
        .slice(0, 40)
      const keepSelected =
        options.search.trim() === '' &&
        options.selectedOtherOwner != null &&
        !visibleItems.some((item) => item.id === options.selectedOtherOwner?.id)
      options.apply({
        otherOwnerOptions: keepSelected
          ? [options.selectedOtherOwner!, ...visibleItems].slice(0, 40)
          : visibleItems
      })
    })
    .catch((error) => {
      if (options.gate.isLatest(requestId)) {
        options.deps.toast.show(String((error as Error).message), 'error')
      }
    })
    .finally(() => {
      if (options.gate.isLatest(requestId)) options.apply({ otherOwnerLoading: false })
    })
  return () => options.gate.invalidate(requestId)
}

export function runNameInspection(options: {
  gate: LatestRequestGate
  deps: ConflictReviewRemoteDeps
  editNameOpen: boolean
  selectedGroup: ActressNameConflictGroup | null
  groups: ActressNameConflictGroup[]
  editSourceName: string
  debouncedEditedName: string
  selectedCandidate: PendingActressScrapeCandidate | null
  selectedClaim: PendingActressNameClaim | null
  apply: (patch: SessionPatch) => void
}): () => void {
  const requestId = options.gate.next()
  options.apply({ liveEditInspection: null })
  if (!options.editNameOpen || !options.selectedGroup) {
    options.apply({ editInspectionLoading: false })
    return () => options.gate.invalidate(requestId)
  }
  const local = inspectConflictNameEdit(
    options.editSourceName,
    options.debouncedEditedName,
    options.groups
  )
  const actressId = options.selectedCandidate?.actressId ?? options.selectedClaim?.actressId
  if (actressId == null || local.status === 'empty' || local.status === 'unchanged') {
    options.apply({ editInspectionLoading: false })
    return () => options.gate.invalidate(requestId)
  }
  options.apply({ editInspectionLoading: true })
  void options.deps.api
    .inspectConflictName({
      actressId,
      name: options.debouncedEditedName,
      ...(options.selectedCandidate ? { pendingId: options.selectedCandidate.pendingId } : {})
    })
    .then((inspection) => {
      if (options.gate.isLatest(requestId)) options.apply({ liveEditInspection: inspection })
    })
    .catch((error) => {
      if (options.gate.isLatest(requestId)) {
        options.deps.toast.show(String((error as Error).message), 'error')
      }
    })
    .finally(() => {
      if (options.gate.isLatest(requestId)) options.apply({ editInspectionLoading: false })
    })
  return () => options.gate.invalidate(requestId)
}

export function beginReplacementValidationStatus(options: {
  gate: LatestRequestGate
  replacementDialog: ReplacementDialog
  requiredCount: number
  replacementInputs: Array<{ actressId: number; mainName: string }>
}): SessionPatch {
  options.gate.next()
  const status = !options.replacementDialog
    ? 'idle'
    : options.requiredCount === 0
      ? 'valid'
      : options.replacementInputs.some((replacement) => !replacement.mainName.trim())
        ? 'idle'
        : 'checking'
  return { replacementValidationErrors: {}, replacementValidationStatus: status }
}

export function runReplacementValidation(options: {
  gate: LatestRequestGate
  deps: ConflictReviewRemoteDeps
  replacementDialog: ReplacementDialog
  selectedGroup: ActressNameConflictGroup | null
  requiredCount: number
  debouncedReplacementInputs: Array<{ actressId: number; mainName: string }>
  proposedOwner: ConflictReviewProposedOwner | null
  apply: (patch: SessionPatch) => void
  onStale: () => void
}): () => void {
  if (
    !options.replacementDialog ||
    !options.selectedGroup ||
    options.requiredCount === 0 ||
    options.debouncedReplacementInputs.some((replacement) => !replacement.mainName.trim())
  ) {
    return () => undefined
  }
  const requestId = options.gate.next()
  void options.deps.api
    .validateIllegalNameReplacements({
      snapshot: buildActressConflictDecisionSnapshot(options.selectedGroup),
      replacementMainNames: options.debouncedReplacementInputs,
      ...(options.replacementDialog === 'ownership' && options.proposedOwner
        ? { destinationOwnerActressId: options.proposedOwner.actressId }
        : {})
    })
    .then((result) => {
      if (!options.gate.isLatest(requestId)) return
      if (result.status === 'valid') {
        options.apply({ replacementValidationStatus: 'valid' })
      } else if (result.status === 'invalid') {
        options.apply({
          replacementValidationStatus: 'invalid',
          replacementValidationErrors: Object.fromEntries(
            result.errors.map((error) => [error.actressId, error.message])
          )
        })
      } else {
        options.onStale()
        void options.deps.invalidateLibrary()
      }
    })
    .catch((error) => {
      if (!options.gate.isLatest(requestId)) return
      options.apply({ replacementValidationStatus: 'invalid' })
      options.deps.toast.show(String((error as Error).message), 'error')
    })
  return () => options.gate.invalidate(requestId)
}

export async function resolveConflictDecision(options: {
  deps: ConflictReviewRemoteDeps
  resolving: boolean
  groups: ActressNameConflictGroup[]
  selectedGroupName: string | null
  input: ResolveActressConflictInput
  apply: (patch: SessionPatch) => void
  applyRefresh: (args: {
    previousGroups: ActressNameConflictGroup[]
    refreshedGroups: ActressNameConflictGroup[]
    previousSelectedName: string | null
    stale: boolean
  }) => void
  resetTransient: () => void
}): Promise<void> {
  if (options.resolving) return
  const previousGroups = options.groups
  const previousSelectedName = options.selectedGroupName
  options.apply({ resolving: true })
  try {
    const outcome = await options.deps.api.resolveConflict(options.input)
    await options.deps.invalidateLibrary()
    const refreshed = await options.deps.refetchGroups()
    if (outcome.status === 'stale') {
      options.apply({ replacementDialog: null })
      options.deps.toast.show(outcome.message, 'info')
    } else {
      options.resetTransient()
      options.deps.toast.show('名称冲突已处理', 'success')
    }
    options.applyRefresh({
      previousGroups,
      refreshedGroups: refreshed,
      previousSelectedName,
      stale: outcome.status === 'stale'
    })
  } catch (error) {
    options.deps.toast.show(String((error as Error).message), 'error')
  } finally {
    options.apply({ resolving: false })
  }
}

export async function discardConflictCandidate(options: {
  deps: ConflictReviewRemoteDeps
  discarding: boolean
  discardCandidate: PendingActressScrapeCandidate | null
  groups: ActressNameConflictGroup[]
  selectedGroupName: string | null
  apply: (patch: SessionPatch) => void
  applyRefresh: (args: {
    previousGroups: ActressNameConflictGroup[]
    refreshedGroups: ActressNameConflictGroup[]
    previousSelectedName: string | null
    stale: boolean
  }) => void
}): Promise<void> {
  if (!options.discardCandidate || options.discarding) return
  const previousGroups = options.groups
  const previousSelectedName = options.selectedGroupName
  options.apply({ discarding: true })
  try {
    await options.deps.api.discardConflict({
      pendingId: options.discardCandidate.pendingId,
      expectedRevision: options.discardCandidate.revision
    })
    options.apply({ discardCandidate: null })
    await options.deps.invalidateLibrary()
    const refreshed = await options.deps.refetchGroups()
    options.applyRefresh({
      previousGroups,
      refreshedGroups: refreshed,
      previousSelectedName,
      stale: false
    })
    options.deps.toast.show('已丢弃错误匹配并清理暂存资源', 'success')
  } catch (error) {
    const message = String((error as Error).message)
    await options.deps.invalidateLibrary()
    const refreshed = await options.deps.refetchGroups()
    options.apply({ discardCandidate: null })
    options.applyRefresh({
      previousGroups,
      refreshedGroups: refreshed,
      previousSelectedName,
      stale: true
    })
    options.deps.toast.show(message, 'error')
  } finally {
    options.apply({ discarding: false })
  }
}

export async function chooseOtherOwnerRemote(options: {
  deps: ConflictReviewRemoteDeps
  item: ActressListItem
  onChosen: (item: ActressListItem, revision: number) => void
}): Promise<void> {
  try {
    const detail = options.item.revision == null
      ? await options.deps.api.getActress(options.item.id)
      : null
    const revision = options.item.revision ?? detail?.revision
    if (revision == null) throw new Error('无法读取演员当前版本，请刷新后重试')
    options.onChosen(options.item, revision)
  } catch (error) {
    options.deps.toast.show(String((error as Error).message), 'error')
  }
}
