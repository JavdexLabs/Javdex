import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import TestRenderer, { act } from 'react-test-renderer'
import { pendingCenterPath } from '../listView/pendingRoutes'
import type { ElectronApi } from '../../../preload/index'
import type {
  PendingVideoScrape,
  PendingVideoScrapeConfirmInput,
  PendingVideoScrapeResolutionResult
} from '@shared/videoScrapeTypes'
import type {
  PendingResourceIdentity,
  PendingResourceIdentityResolution
} from '@shared/libraryTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

const pending: PendingVideoScrape = {
  id: 1,
  videoId: 10,
  revision: 1,
  selectedFields: ['publisher', 'releaseDate', 'director'],
  applicableFields: ['publisher', 'releaseDate', 'director'],
  updateMode: 'replace',
  warnings: [],
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
  stagedBytes: 0,
  sources: [
    {
      id: 2,
      position: 0,
      pluginName: 'Test',
      pluginSource: 'user',
      pluginVersion: '1.0.0',
      sourceName: 'Test',
      selectedFields: ['publisher', 'releaseDate', 'director'],
      selectedCandidateId: null,
      candidates: [
        {
          id: 3,
          position: 0,
          result: {
            code: 'ABC-123',
            title: '候选影片',
            publisher: '同一发行商',
            releaseDate: '2026-08-01',
            director: '同名导演'
          },
          sourceUrl: 'https://example.test/video/3',
          stagedCoverPath: null,
          stagedSamplePaths: [],
          stagedActressAvatarPaths: []
        }
      ]
    }
  ]
}

const confirmationResults: PendingVideoScrapeResolutionResult[] = [
  {
    status: 'skipped',
    applied: false,
    warnings: [],
    directorChoice: {
      scrapedName: '同名导演',
      candidates: [
        {
          id: 70,
          mainName: '导演甲',
          aliases: ['同名导演'],
          description: '已有影片导演'
        }
      ]
    }
  },
  { status: 'merge-required', applied: false, conflictVideoId: 20, warnings: [] },
  { status: 'applied', applied: true, warnings: [] }
]

let renderer: TestRenderer.ReactTestRenderer | null = null
let queryClient: QueryClient | null = null
let confirmationInputs: PendingVideoScrapeConfirmInput[] = []
let resolved = false
let identityMode = false
let identityResolved = false
let identityResolutionInputs: PendingResourceIdentityResolution[] = []

const identity: PendingResourceIdentity = {
  id: 4,
  libraryId: 1,
  rootId: 1,
  sourceKind: 'local',
  targetKind: null,
  targetDisplay: null,
  displayName: 'FILE-001.mp4',
  filenameCode: 'FILE-001',
  nfoCode: 'NFO-002',
  revision: 3,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z'
}

const fakeApi = {
  mediaLibraries: {
    list: async () => [{ id: 1, name: '测试媒体库' }]
  },
  scan: {
    listPending: async () => [],
    listPendingResourceIdentities: async () =>
      identityMode && !identityResolved ? [identity] : [],
    resolvePendingResourceIdentity: async (
      _libraryId: number,
      _identityId: number,
      resolution: PendingResourceIdentityResolution
    ) => {
      identityResolutionInputs.push(resolution)
      identityResolved = true
      return { status: 'assigned' as const, videoId: 22, warnings: [] }
    }
  },
  actressScrape: {
    listConflicts: async () => [],
    conflictSummary: async () => ({ groupCount: 0, conflictGroupCount: 0, applicableGroupCount: 0 })
  },
  scrape: {
    listPending: async () => (identityMode || resolved ? [] : [pending]),
    discardPending: async () => true,
    confirmPending: async (input: PendingVideoScrapeConfirmInput) => {
      confirmationInputs.push(input)
      const result = confirmationResults[confirmationInputs.length - 1]
      assert.ok(result)
      if (result.status === 'applied') resolved = true
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

function nodeText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('')
}

function button(label: string): TestRenderer.ReactTestInstance {
  assert.ok(renderer)
  const match = renderer.root
    .findAllByType('button')
    .find((candidate) => nodeText(candidate) === label)
  assert.ok(match, `button not found: ${label}`)
  return match
}

function modalTitles(): string[] {
  assert.ok(renderer)
  return renderer.root
    .findAllByProps({ role: 'dialog' })
    .flatMap((dialog) => dialog.findAllByType('h3').map(nodeText))
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  assert.fail('pending center did not settle')
}

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
  queryClient?.clear()
  queryClient = null
  confirmationInputs = []
  resolved = false
  identityMode = false
  identityResolved = false
  identityResolutionInputs = []
})

describe('PendingCenterPage scrape resolution', () => {
  it('carries an explicit director through merge-and-apply without stacking prompts', async () => {
    const PendingCenterPage = (await import('./PendingCenterPage')).default
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={queryClient!}>
          <MemoryRouter initialEntries={['/pending?type=scrape']}>
            <PendingCenterPage />
          </MemoryRouter>
        </QueryClientProvider>
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => renderer?.root.findAllByProps({ name: 'source-2' }).length === 1)

    await act(async () => {
      renderer?.root.findByProps({ name: 'source-2' }).props.onChange()
    })
    await act(async () => {
      button('应用所选候选').props.onClick()
      await Promise.resolve()
    })
    await waitFor(() => modalTitles().includes('选择导演'))

    await act(async () => {
      renderer?.root.findByProps({ name: 'pending-director' }).props.onChange()
    })
    await act(async () => {
      button('选择并应用').props.onClick()
      await Promise.resolve()
    })
    await waitFor(() => modalTitles().includes('合并并应用候选'))
    assert.deepEqual(modalTitles(), ['合并并应用候选'])

    await act(async () => {
      button('保留 #10').props.onClick()
      await Promise.resolve()
    })
    await waitFor(() => confirmationInputs.length === 3)

    assert.deepEqual(confirmationInputs, [
      {
        pendingScrapeId: 1,
        selections: [{ sourceId: 2, candidateId: 3 }]
      },
      {
        pendingScrapeId: 1,
        selections: [{ sourceId: 2, candidateId: 3 }],
        directorSelectionId: 70
      },
      {
        pendingScrapeId: 1,
        selections: [{ sourceId: 2, candidateId: 3 }],
        directorSelectionId: 70,
        mergeRetainedVideoId: 10
      }
    ])
  })

  it('previews either persisted identity and submits only after explicit confirmation', async () => {
    identityMode = true
    const PendingCenterPage = (await import('./PendingCenterPage')).default
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={queryClient!}>
          <MemoryRouter initialEntries={['/pending?type=scan']}>
            <PendingCenterPage />
          </MemoryRouter>
        </QueryClientProvider>
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() =>
      Boolean(renderer && nodeText(renderer.root).includes('FILE-001 ↔ NFO-002'))
    )

    const choices = renderer!.root.findAllByProps({ name: 'resource-identity' }).filter((node) => node.type === 'input')
    assert.equal(choices.length, 2)
    assert.ok(choices.every((node) => node.props.type === 'radio' && !node.props.checked))
    assert.equal(button('确认番号').props.disabled, true)
    await act(async () => choices[0].props.onChange())
    assert.ok(nodeText(renderer!.root).includes('将采用 FILE-001'))
    await act(async () => choices[1].props.onChange())
    assert.ok(nodeText(renderer!.root).includes('将采用 NFO-002'))
    assert.deepEqual(identityResolutionInputs, [])
    assert.equal(button('确认番号').props.disabled, false)
    await act(async () => {
      button('确认番号').props.onClick()
      await Promise.resolve()
    })
    await waitFor(() => identityResolutionInputs.length === 1)
    assert.deepEqual(identityResolutionInputs, [
      { expectedRevision: 3, choice: 'nfo' }
    ])
  })

  it('shows the library filter only for scan decisions', async () => {
    identityMode = true
    const PendingCenterPage = (await import('./PendingCenterPage')).default
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={queryClient!}>
          <MemoryRouter initialEntries={[pendingCenterPath({ type: 'scan', libraryId: 1 })]}>
            <PendingCenterPage />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })
    await waitFor(() => Boolean(renderer && nodeText(renderer.root).includes('FILE-001 ↔ NFO-002')))
    const filters = (): TestRenderer.ReactTestInstance[] => renderer!.root.findAllByProps({ 'aria-label': '按媒体库筛选扫描待确认项' })
    assert.ok(filters().length > 0)
    await act(async () => button('全部1').props.onClick())
    assert.equal(filters().length, 0)
    await act(async () => button('影片刮削').props.onClick())
    assert.equal(filters().length, 0)
  })

  it('clears the library filter from the scoped empty state and keeps the scan tab selected', async () => {
    identityMode = true
    identityResolved = true
    const PendingCenterPage = (await import('./PendingCenterPage')).default
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={queryClient!}>
          <MemoryRouter initialEntries={[pendingCenterPath({ type: 'scan', libraryId: 1 })]}>
            <PendingCenterPage />
          </MemoryRouter>
        </QueryClientProvider>
      )
    })
    await waitFor(() => Boolean(renderer && nodeText(renderer.root).includes('此媒体库没有扫描待确认项')))
    await act(async () => button('查看所有媒体库').props.onClick())
    assert.ok(nodeText(renderer!.root).includes('没有扫描资源待确认项'))
    assert.equal(button('扫描资源').props['aria-selected'], true)
    assert.equal(renderer!.root.findByProps({ role: 'tabpanel' }).props['aria-labelledby'], 'pending-types-scan')
    assert.equal(button('所有媒体库').props['aria-label'], '按媒体库筛选扫描待确认项')
  })
})
