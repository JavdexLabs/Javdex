import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ActressNameConflictGroup, ResolveActressConflictInput } from '@shared/actressConflictTypes'
import { createLatestRequestGate } from './latestRequestGate'
import {
  beginReplacementValidationStatus,
  discardConflictCandidate,
  resolveConflictDecision,
  runNameInspection,
  runReplacementValidation,
  type ConflictReviewRemoteDeps,
  type SessionPatch
} from './conflictReviewRemote'
import type { ConflictReviewSessionState } from './conflictReviewSession'
import { initialConflictReviewSessionState } from './conflictReviewSession'

const candidate = {
  pendingId: 10,
  revision: 1,
  actressId: 2,
  actressRevision: 3,
  actressMainName: '候选演员',
  actressAvatarPath: null,
  plugin: { id: 'test', name: 'Test', version: '1' },
  queryName: '候选演员',
  selectedFields: ['aliases'],
  applicableFields: ['aliases'],
  mode: 'fillEmpty' as const,
  result: { aliases: ['冲突名'] },
  warnings: [],
  createdAt: '2026-08-07T00:00:00.000Z',
  resources: [],
  conflicts: [{ name: '冲突名', normalizedName: '冲突名', type: 'alias' as const }],
  fieldImpactsWhenAssignedToCandidate: [],
  fieldImpacts: [],
  willApplyAfterDecision: true,
  remainingConflictCountAfterDecision: 0
}

function group(withMainClaimant = false): ActressNameConflictGroup {
  return {
    status: 'conflict',
    normalizedName: '冲突名',
    displayName: '冲突名',
    currentOwner: withMainClaimant
      ? {
          actressId: 1,
          revision: 4,
          mainName: '冲突名',
          avatarPath: null,
          nameTypes: ['main'],
          hasPendingScrape: false
        }
      : null,
    claimants: withMainClaimant
      ? [
          {
            actressId: 1,
            revision: 4,
            mainName: '冲突名',
            avatarPath: null,
            nameTypes: ['main'],
            hasPendingScrape: false
          }
        ]
      : [],
    pendingNameClaims: [],
    candidates: [candidate] as unknown as ActressNameConflictGroup['candidates'],
    mergePairs: []
  }
}

function createHarness(overrides?: Partial<ConflictReviewRemoteDeps['api']>) {
  const toasts: Array<{ message: string; tone: string }> = []
  const resolvedInputs: ResolveActressConflictInput[] = []
  let discarded = 0
  let validationCalls = 0
  let lastReplacementName: string | undefined
  let resolveResult: { status: 'success'; remainingPending: number } | { status: 'stale'; message: string } = {
    status: 'success',
    remainingPending: 0
  }
  const inspectionResolvers: Array<(value: { normalizedName: string; status: 'available' | 'conflict' }) => void> =
    []
  let groups = [group()]
  let state: ConflictReviewSessionState = { ...initialConflictReviewSessionState }
  const apply = (patch: SessionPatch): void => {
    state = { ...state, ...patch }
  }

  const deps: ConflictReviewRemoteDeps = {
    api: {
      pageActresses: async () => ({ items: [], hasMore: false, offset: 0 }),
      getActressIdentity: async () => null,
      inspectConflictName: () =>
        new Promise((resolve) => inspectionResolvers.push(resolve)),
      validateIllegalNameReplacements: async (input) => {
        validationCalls += 1
        lastReplacementName = input.replacementMainNames[0]?.mainName
        return { status: 'valid' as const }
      },
      resolveConflict: async (input) => {
        resolvedInputs.push(input)
        return resolveResult
      },
      discardConflict: async () => {
        discarded += 1
        return { remainingPending: 0 }
      },
      ...overrides
    },
    toast: {
      show(message, tone) {
        toasts.push({ message, tone })
      }
    },
    invalidateLibrary: async () => undefined,
    refetchGroups: async () => groups
  }

  return {
    deps,
    apply,
    getState: () => state,
    setState: (next: ConflictReviewSessionState) => {
      state = next
    },
    toasts,
    resolvedInputs,
    getDiscarded: () => discarded,
    getValidationCalls: () => validationCalls,
    getLastReplacementName: () => lastReplacementName,
    setResolveResult: (next: typeof resolveResult) => {
      resolveResult = next
    },
    inspectionResolvers,
    setGroups: (next: ActressNameConflictGroup[]) => {
      groups = next
    },
    getGroups: () => groups
  }
}

describe('conflictReviewRemote', () => {
  it('resolves ownership/merge/illegal and surfaces stale refresh', async () => {
    const harness = createHarness()
    const selected = group()
    const applyRefreshCalls: Array<{ stale: boolean }> = []
    let resetCount = 0

    await resolveConflictDecision({
      deps: harness.deps,
      resolving: false,
      groups: [selected],
      selectedGroupName: selected.normalizedName,
      input: {
        kind: 'assignToExistingActress',
        snapshot: {
          status: 'conflict',
          normalizedName: '冲突名',
          currentOwnerActressId: null,
          currentOwnerRevision: null,
          claimants: [],
          pendingNameClaims: [],
          candidates: []
        },
        ownerActressId: 2,
        ownerActressRevision: 3,
        replacementMainNames: []
      },
      apply: harness.apply,
      applyRefresh: (args) => applyRefreshCalls.push({ stale: args.stale }),
      resetTransient: () => {
        resetCount += 1
      }
    })
    assert.equal(harness.resolvedInputs.at(-1)?.kind, 'assignToExistingActress')
    assert.equal(resetCount, 1)
    assert.equal(applyRefreshCalls.at(-1)?.stale, false)
    assert.ok(harness.toasts.some((toast) => toast.tone === 'success'))

    harness.setResolveResult({ status: 'stale', message: 'stale' })
    await resolveConflictDecision({
      deps: harness.deps,
      resolving: false,
      groups: [selected],
      selectedGroupName: selected.normalizedName,
      input: {
        kind: 'markIllegalName',
        snapshot: {
          status: 'conflict',
          normalizedName: '冲突名',
          currentOwnerActressId: null,
          currentOwnerRevision: null,
          claimants: [],
          pendingNameClaims: [],
          candidates: []
        },
        replacementMainNames: []
      },
      apply: harness.apply,
      applyRefresh: (args) => applyRefreshCalls.push({ stale: args.stale }),
      resetTransient: () => {
        resetCount += 1
      }
    })
    assert.equal(applyRefreshCalls.at(-1)?.stale, true)
    assert.ok(harness.toasts.some((toast) => toast.message === 'stale' && toast.tone === 'info'))
  })

  it('discards a candidate and refreshes the queue', async () => {
    const harness = createHarness()
    const selected = group()
    let refreshed = false
    await discardConflictCandidate({
      deps: harness.deps,
      discarding: false,
      discardCandidate: selected.candidates[0],
      groups: [selected],
      selectedGroupName: selected.normalizedName,
      apply: harness.apply,
      applyRefresh: () => {
        refreshed = true
      }
    })
    assert.equal(harness.getDiscarded(), 1)
    assert.equal(refreshed, true)
    assert.equal(harness.getState().discardCandidate, null)
  })

  it('validates replacement main names', async () => {
    const harness = createHarness()
    const selected = group(true)
    const gate = createLatestRequestGate()
    const statusPatch = beginReplacementValidationStatus({
      gate,
      replacementDialog: 'ownership',
      requiredCount: 1,
      replacementInputs: [{ actressId: 1, mainName: '正确主名' }]
    })
    assert.equal(statusPatch.replacementValidationStatus, 'checking')
    runReplacementValidation({
      gate,
      deps: harness.deps,
      replacementDialog: 'ownership',
      selectedGroup: selected,
      requiredCount: 1,
      debouncedReplacementInputs: [{ actressId: 1, mainName: '正确主名' }],
      proposedOwner: { actressId: 2, revision: 3, mainName: '候选演员' },
      apply: harness.apply,
      onStale: () => undefined
    })
    await Promise.resolve()
    await Promise.resolve()
    assert.ok(harness.getValidationCalls() >= 1)
    assert.equal(harness.getLastReplacementName(), '正确主名')
    assert.equal(harness.getState().replacementValidationStatus, 'valid')
  })

  it('ignores an older live name inspection after a newer request wins', async () => {
    const harness = createHarness()
    const selected = group()
    const gate = createLatestRequestGate()
    const cleanup1 = runNameInspection({
      gate,
      deps: harness.deps,
      editNameOpen: true,
      selectedGroup: selected,
      groups: [selected],
      editSourceName: '冲突名',
      debouncedEditedName: '第一个名称',
      selectedCandidate: selected.candidates[0],
      selectedClaim: null,
      apply: harness.apply
    })
    const cleanup2 = runNameInspection({
      gate,
      deps: harness.deps,
      editNameOpen: true,
      selectedGroup: selected,
      groups: [selected],
      editSourceName: '冲突名',
      debouncedEditedName: '第二个名称',
      selectedCandidate: selected.candidates[0],
      selectedClaim: null,
      apply: harness.apply
    })
    assert.equal(harness.inspectionResolvers.length, 2)
    harness.inspectionResolvers[1]({ normalizedName: '第二个名称', status: 'available' })
    await new Promise((resolve) => setImmediate(resolve))
    harness.inspectionResolvers[0]({ normalizedName: '第一个名称', status: 'available' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(harness.getState().liveEditInspection?.normalizedName, '第二个名称')
    cleanup1()
    cleanup2()
  })

  it('invalidates an in-flight inspection cleanup', async () => {
    const harness = createHarness()
    const selected = group()
    const gate = createLatestRequestGate()
    const cleanup = runNameInspection({
      gate,
      deps: harness.deps,
      editNameOpen: true,
      selectedGroup: selected,
      groups: [selected],
      editSourceName: '冲突名',
      debouncedEditedName: '卸载中的名称',
      selectedCandidate: selected.candidates[0],
      selectedClaim: null,
      apply: harness.apply
    })
    assert.equal(harness.inspectionResolvers.length, 1)
    cleanup()
    harness.inspectionResolvers[0]({ normalizedName: '不应应用', status: 'available' })
    await Promise.resolve()
    assert.notEqual(harness.getState().liveEditInspection?.normalizedName, '不应应用')
  })
})
