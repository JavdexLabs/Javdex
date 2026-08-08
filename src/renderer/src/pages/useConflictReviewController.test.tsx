import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TestRenderer, { act } from 'react-test-renderer'
import type { ActressNameConflictGroup, ResolveActressConflictInput } from '@shared/actressConflictTypes'
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

function group(): ActressNameConflictGroup {
  return {
    status: 'conflict',
    normalizedName: '冲突名',
    displayName: '冲突名',
    currentOwner: null,
    claimants: [],
    pendingNameClaims: [],
    candidates: [candidate] as unknown as ActressNameConflictGroup['candidates'],
    mergePairs: []
  }
}

let groups = [group()]
let resolvedInputs: ResolveActressConflictInput[] = []
let resolveResult: { status: 'success'; remainingPending: number } | { status: 'stale'; message: string } = {
  status: 'success',
  remainingPending: 0
}

const fakeApi = {
  actressScrape: {
    listConflicts: async () => groups,
    conflictSummary: async () => ({
      groupCount: groups.length,
      conflictGroupCount: groups.length,
      applicableGroupCount: 0,
      pendingScrapeCount: 1,
      pendingNameClaimGroupCount: 0
    }),
    inspectConflictName: async () => ({ normalizedName: 'x', status: 'available' as const }),
    validateIllegalNameReplacements: async () => ({ status: 'valid' as const }),
    resolveConflict: async (input: ResolveActressConflictInput) => {
      resolvedInputs.push(input)
      return resolveResult
    },
    discardConflict: async () => ({ remainingPending: 0 })
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
  resolveResult = { status: 'success', remainingPending: 0 }
})

describe('useConflictReviewController', () => {
  it('wires queue selection and resets dialog draft when switching groups', async () => {
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
    await waitFor(() => current().queue.selectedGroup != null)

    act(() => current().detail.selectOwner({ actressId: 2, revision: 3, mainName: '候选演员' }))
    assert.equal(current().detail.proposedOwner?.actressId, 2)
    act(() => current().detail.openIllegalName())
    assert.equal(current().dialogs.replacement.kind, 'illegal')

    act(() => current().queue.chooseGroup(second))
    assert.equal(current().queue.selectedGroup?.normalizedName, '第二组')
    assert.equal(current().detail.selection?.source?.kind, 'scrape')
    assert.equal(current().detail.selection?.source?.id, 20)
    assert.equal(current().detail.proposedOwner, null)
    assert.equal(current().dialogs.replacement.kind, null)
  })

  it('routes resolve through the nested view-model commands', async () => {
    const current = await mountController()
    await waitFor(() => current().queue.selectedGroup != null)

    act(() => current().detail.selectOwner({ actressId: 2, revision: 3, mainName: '候选演员' }))
    assert.equal(current().detail.proposedOwner?.actressId, 2)
    act(() => current().detail.confirmOwnership())
    await waitFor(() => resolvedInputs.at(-1)?.kind === 'assignToExistingActress')
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return
    await settle(10)
  }
  assert.fail('controller state did not settle')
}
