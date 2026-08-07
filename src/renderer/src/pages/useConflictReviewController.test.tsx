import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TestRenderer, { act } from 'react-test-renderer'
import type { ActressNameConflictGroup, ResolveActressConflictInput, ValidateIllegalNameReplacementsInput } from '@shared/actressConflictTypes'
import type { ElectronApi } from '../../../preload/index'

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
  mode: 'fillEmpty',
  result: { aliases: ['冲突名'] },
  warnings: [],
  createdAt: '2026-08-07T00:00:00.000Z',
  resources: [],
  conflicts: [{ name: '冲突名', normalizedName: '冲突名', type: 'alias' }],
  fieldImpactsWhenAssignedToCandidate: [],
  fieldImpacts: [],
  willApplyAfterDecision: true,
  remainingConflictCountAfterDecision: 0
} as const

function group(withMainClaimant = false): ActressNameConflictGroup {
  return {
    status: 'conflict',
    normalizedName: '冲突名',
    displayName: '冲突名',
    currentOwner: withMainClaimant
      ? { actressId: 1, revision: 4, mainName: '冲突名', avatarPath: null, nameTypes: ['main'], hasPendingScrape: false }
      : null,
    claimants: withMainClaimant
      ? [{ actressId: 1, revision: 4, mainName: '冲突名', avatarPath: null, nameTypes: ['main'], hasPendingScrape: false }]
      : [],
    pendingNameClaims: [],
    candidates: [candidate] as unknown as ActressNameConflictGroup['candidates'],
    mergePairs: []
  }
}

let groups = [group()]
let resolvedInputs: ResolveActressConflictInput[] = []
let discarded = 0
let validationCalls = 0
let lastReplacementName: string | undefined
let resolveResult: { status: 'success'; remainingPending: number } | { status: 'stale'; message: string } = {
  status: 'success',
  remainingPending: 0
}
const inspectionResolvers: Array<(value: { normalizedName: string; status: 'available' | 'conflict' }) => void> = []

const fakeApi = {
  actressScrape: {
    listConflicts: async () => groups,
    conflictSummary: async () => ({ groupCount: groups.length, conflictGroupCount: groups.length, applicableGroupCount: 0, pendingScrapeCount: 1, pendingNameClaimGroupCount: 0 }),
    inspectConflictName: async () => new Promise<{ normalizedName: string; status: 'available' | 'conflict' }>((resolve) => inspectionResolvers.push(resolve)),
    validateIllegalNameReplacements: async (input: ValidateIllegalNameReplacementsInput) => {
      validationCalls += 1
      lastReplacementName = input.replacementMainNames[0]?.mainName
      return { status: 'valid' as const }
    },
    resolveConflict: async (input: ResolveActressConflictInput) => {
      resolvedInputs.push(input)
      return resolveResult
    },
    discardConflict: async () => {
      discarded += 1
      return { remainingPending: 0 }
    }
  },
  actresses: {
    list: async () => [],
    get: async () => null
  }
} as unknown as ElectronApi

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { api: fakeApi }
})

type ControllerHook = typeof import('./useConflictReviewController')['useConflictReviewController']
type Controller = ReturnType<ControllerHook>
let controllerHook: ControllerHook | null = null

let renderer: TestRenderer.ReactTestRenderer | null = null

async function mountController(): Promise<() => Controller> {
  controllerHook ??= (await import('./useConflictReviewController')).useConflictReviewController
  const useController = controllerHook
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let current: Controller | null = null
  function Harness(): null {
    current = useController()
    return null
  }
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>
    )
    await Promise.resolve()
    await Promise.resolve()
  })
  return () => {
    assert.ok(current)
    return current
  }
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  renderer?.unmount()
  renderer = null
  groups = [group()]
  resolvedInputs = []
  discarded = 0
  validationCalls = 0
  lastReplacementName = undefined
  resolveResult = { status: 'success', remainingPending: 0 }
  inspectionResolvers.length = 0
})

describe('useConflictReviewController', () => {
  it('reflects the proposed owner and resets the decision draft when switching groups', async () => {
    const second = group()
    second.normalizedName = '第二组'
    second.displayName = '第二组'
    second.candidates = [{
      ...second.candidates[0],
      pendingId: 20,
      conflicts: [{ name: '第二组', normalizedName: '第二组', type: 'alias' }]
    }]
    groups = [group(), second]
    const current = await mountController()
    await waitFor(() => current().selectedGroup != null)

    act(() => current().selectOwner({ actressId: 2, revision: 3, mainName: '候选演员' }))
    assert.equal(current().proposedOwner?.actressId, 2)
    act(() => current().openIllegalName())
    assert.equal(current().replacementDialog, 'illegal')

    act(() => current().chooseGroup(second))
    assert.equal(current().selectedGroup?.normalizedName, '第二组')
    assert.equal(current().selection?.source?.kind, 'scrape')
    assert.equal(current().selection?.source?.id, 20)
    assert.equal(current().proposedOwner, null)
    assert.equal(current().replacementDialog, null)
  })

  it('routes ownership, merge, illegal-name, discard and stale refresh through intent actions', async () => {
    const current = await mountController()
    await waitFor(() => current().selectedGroup != null)
    assert.equal(current().selectedGroup?.normalizedName, '冲突名')

    act(() => current().selectOwner({ actressId: 2, revision: 3, mainName: '候选演员' }))
    act(() => current().confirmOwnership())
    await settle()
    assert.equal(resolvedInputs.at(-1)?.kind, 'assignToExistingActress')

    act(() => current().submitMerge({ keepActressId: 2, keepActressRevision: 3, mergeActressId: 1, mergeActressRevision: 4, finalMainName: '候选演员' }))
    await settle()
    assert.equal(resolvedInputs.at(-1)?.kind, 'mergeActresses')

    act(() => current().openIllegalName())
    act(() => current().submitIllegalName())
    await settle()
    assert.equal(resolvedInputs.at(-1)?.kind, 'markIllegalName')

    act(() => current().requestDiscard(current().selectedCandidate!))
    await act(async () => current().discard())
    assert.equal(discarded, 1)

    resolveResult = { status: 'stale', message: 'stale' }
    act(() => current().selectOwner({ actressId: 2, revision: 3, mainName: '候选演员' }))
    act(() => current().confirmOwnership())
    await settle()
    assert.equal(current().staleMessage, '数据已变化，已刷新，请重新确认')
    assert.notEqual(current().focusAfterRefresh, undefined)
  })

  it('validates replacement main names before assigning ownership', async () => {
    groups = [group(true)]
    const current = await mountController()
    await waitFor(() => current().selectedGroup != null)
    act(() => current().selectOwner({ actressId: 2, revision: 3, mainName: '候选演员' }))
    act(() => current().confirmOwnership())
    assert.equal(current().replacementDialog, 'ownership')
    act(() => current().changeReplacementMainName(1, '正确主名'))
    await settle(300)
    assert.ok(validationCalls >= 1)
    assert.equal(lastReplacementName, '正确主名')
    assert.equal(current().replacementValidationStatus, 'valid')
  })

  it('ignores an older live name inspection after a newer request wins', async () => {
    const current = await mountController()
    await waitFor(() => current().selectedGroup != null)
    act(() => current().openEditName())
    act(() => current().changeEditedName('第一个名称'))
    await settle(300)
    act(() => current().changeEditedName('第二个名称'))
    await settle(300)
    assert.equal(inspectionResolvers.length, 2)
    inspectionResolvers[1]({ normalizedName: '第二个名称', status: 'available' })
    await settle()
    inspectionResolvers[0]({ normalizedName: '第一个名称', status: 'available' })
    await settle()
    assert.equal(current().editInspection.normalizedName, '第二个名称')
  })

  it('invalidates an in-flight inspection when the controller unmounts', async () => {
    const current = await mountController()
    await waitFor(() => current().selectedGroup != null)
    act(() => current().openEditName())
    act(() => current().changeEditedName('卸载中的名称'))
    await settle(300)
    assert.equal(inspectionResolvers.length, 1)

    act(() => renderer?.unmount())
    inspectionResolvers[0]({ normalizedName: '不应应用', status: 'available' })
    await settle()

    assert.notEqual(current().editInspection.normalizedName, '不应应用')
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return
    await settle(10)
  }
  assert.fail('controller state did not settle')
}
