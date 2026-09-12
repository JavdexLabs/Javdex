import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TestRenderer, { act } from 'react-test-renderer'
import type {
  OrganizationDetail,
  OrganizationMergeInput,
  OrganizationMergeOption,
  OrganizationMergeResult
} from '@shared/classificationTypes'
import type { ElectronApi } from '../../../preload/index'

Object.defineProperty(globalThis, 'React', {
  configurable: true,
  value: React
})

const target: OrganizationDetail = {
  id: 10,
  mainName: '保留机构',
  imagePath: null,
  fallbackCoverPath: null,
  videoCount: 2,
  updatedAt: '2026-08-10T00:00:00.000Z',
  summary: null,
  countryRegion: null,
  foundedYear: null,
  endedYear: null,
  status: 'active',
  parent: null,
  aliases: [],
  links: [],
  roles: ['maker'],
  makerVideoCount: 2,
  publisherVideoCount: 0,
  releaseYearStart: null,
  releaseYearEnd: null
}

const source: OrganizationMergeOption = {
  id: 20,
  mainName: '跨角色来源机构',
  aliases: ['来源别名'],
  roles: ['maker', 'publisher'],
  videoCount: 5,
  makerVideoCount: 3,
  publisherVideoCount: 2
}

const result: OrganizationMergeResult = {
  targetId: target.id,
  sourceId: source.id,
  transferredMakerVideoCount: 3,
  transferredPublisherVideoCount: 2,
  transferredChildCount: 1,
  transferredSeriesCount: 1,
  imagePath: null,
  cleanupFailures: []
}

let receivedInput: OrganizationMergeInput | null = null
let mergeFailure: Error | null = null
const fakeApi = {
  organizations: {
    mergeOptions: async () => [source],
    merge: async (input: OrganizationMergeInput) => {
      receivedInput = input
      if (mergeFailure) throw mergeFailure
      return result
    }
  }
} as unknown as ElectronApi

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    api: fakeApi,
    addEventListener() {},
    removeEventListener() {}
  }
})

Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    activeElement: null,
    body: { style: { overflow: '' } }
  }
})

type MergeModal = typeof import('./OrganizationMergeModal')['default']
let MergeModalComponent: MergeModal | null = null
let renderer: TestRenderer.ReactTestRenderer | null = null
let queryClient: QueryClient | null = null

async function mount(onMerged: (value: OrganizationMergeResult) => void): Promise<void> {
  MergeModalComponent ??= (await import('./OrganizationMergeModal')).default
  const OrganizationMergeModal = MergeModalComponent
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient = client
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <OrganizationMergeModal target={target} onCancel={() => {}} onMerged={onMerged} />
      </QueryClientProvider>
    )
    await Promise.resolve()
    await Promise.resolve()
  })
  await waitFor(() => candidateButtons().length === 1)
}

function candidateButtons(): TestRenderer.ReactTestInstance[] {
  return renderer?.root.findAllByProps({ role: 'option' }) ?? []
}

function confirmButton(): TestRenderer.ReactTestInstance {
  assert.ok(renderer)
  const button = renderer.root
    .findAllByType('button')
    .find((item) => item.props.children === '确认合并')
  assert.ok(button)
  return button
}

function renderedText(): string {
  return JSON.stringify(renderer?.toJSON())
}

async function selectSource(): Promise<void> {
  await act(async () => candidateButtons()[0].props.onClick())
}

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
  queryClient?.clear()
  queryClient = null
  receivedInput = null
  mergeFailure = null
})

describe('OrganizationMergeModal interaction', () => {
  it('selects a cross-role source and submits the explicit source-to-target direction', async () => {
    let merged: OrganizationMergeResult | null = null
    await mount((value) => {
      merged = value
    })

    await selectSource()
    assert.match(renderedText(), /制作商 \/ 发行商/)
    assert.match(renderedText(), /制作 3 部 · 发行 2 部/)
    assert.equal(confirmButton().props.disabled, false)

    await act(async () => {
      confirmButton().props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => merged != null)

    assert.deepEqual(receivedInput, { targetId: target.id, sourceId: source.id })
    assert.deepEqual(merged, result)
  })

  it('keeps the modal open and shows an actionable error when the merge is rejected', async () => {
    let merged = false
    mergeFailure = new Error('系列名称冲突；请先修改或合并冲突系列')
    await mount(() => {
      merged = true
    })
    await selectSource()

    await act(async () => {
      confirmButton().props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => renderedText().includes('系列名称冲突'))

    assert.equal(merged, false)
    assert.deepEqual(receivedInput, { targetId: target.id, sourceId: source.id })
    assert.match(renderedText(), /系列名称冲突；请先修改或合并冲突系列/)
    assert.match(renderedText(), /合并机构/)
    assert.equal(confirmButton().props.disabled, false)
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  assert.fail('organization merge modal did not settle')
}
