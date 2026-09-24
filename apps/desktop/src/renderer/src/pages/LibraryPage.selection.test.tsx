import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { VideoQuery } from '@shared/videoTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
const storage = { getItem: () => null, setItem() {}, removeItem() {} }
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: {}, body: { style: {}, appendChild() {} }, activeElement: null, createElement: () => ({ style: {}, offsetWidth: 100, appendChild() {}, remove() {} }) } })
Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ getPropertyValue: () => '' }) })
const commits: { videoId: number; expectedRevision: string }[] = []
const previews: number[] = []
let failList = false
let holdPreview: Promise<void> | undefined
let previewFailure = false
const rows = Array.from({ length: 700 }, (_, i) => ({ id: i + 1, code: `CODE-${i + 1}`, title: 'wide data', preferredLibraryId: 1, membershipAddedAt: '', libraries: [] }))
const preview = async (id: number) => {
  previews.push(id)
  await holdPreview
  if (previewFailure) throw new Error('preview failed')
  return { videoId: id, revision: `revision-${id}`, sourcePaths: ['path'], resourceIds: [id], libraries: [], resources: [], playlists: [], mediaAssets: [] }
}
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  addEventListener() {}, removeEventListener() {}, localStorage: storage,
  api: {
    mediaLibraries: { get: async () => ({ id: 1, name: 'test', status: 'active', icon: 'folder', color: null, config: {}, rootCount: 1 }) },
    videos: {
      years: async () => [],
      list: async (_scope: unknown, query: VideoQuery) => {
        if (query.limit === 1) return { items: [{ ...rows[0], title: 'wide-count-only'.repeat(10000) }], total: 700 }
        if (failList) throw new Error('list failed')
        return { items: rows.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 60)), total: rows.length }
      },
      previewDeleteGlobally: preview,
      previewRemoveFromLibrary: (_library: number, id: number) => preview(id),
      deleteGlobally: async (input: { videoId: number; expectedRevision: string }) => { commits.push(input) },
      removeFromLibrary: async (input: { videoId: number; expectedRevision: string }) => { commits.push(input) }
    },
    scrape: { listPlugins: async () => [], listPluginDetails: async () => [], onVideoBatchProgress: () => () => {} },
    actressScrape: { onBatchProgress: () => () => {} },
    settings: { get: async () => ({}) },
    batchScrape: { getState: async () => ({ progress: null }) }
  }
} })
let LibraryPage: typeof import('./LibraryPage').default
let Grid: typeof import('../components/VirtualPosterGrid').default
let Modal: typeof import('../components/Modal').default
let SelectionToolbar: typeof import('../components/SelectionToolbar').default
let BatchScrapeProvider: typeof import('../contexts/BatchScrapeContext').BatchScrapeProvider
before(async () => {
  LibraryPage = (await import('./LibraryPage')).default
  Grid = (await import('../components/VirtualPosterGrid')).default
  Modal = (await import('../components/Modal')).default
  SelectionToolbar = (await import('../components/SelectionToolbar')).default
  BatchScrapeProvider = (await import('../contexts/BatchScrapeContext')).BatchScrapeProvider
})
let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient
async function wait(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  assert.ok(check(), 'UI condition did not settle')
}
async function mount(): Promise<void> {
  commits.length = 0; previews.length = 0; holdPreview = undefined; previewFailure = false
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    renderer = TestRenderer.create(<QueryClientProvider client={client}><MemoryRouter><BatchScrapeProvider><LibraryPage libraryId={1} /></BatchScrapeProvider></MemoryRouter></QueryClientProvider>)
  })
}
const grid = () => renderer!.root.findByType(Grid)
const modal = () => renderer!.root.findByType(Modal)
function bulk(key: string): void {
  const action = renderer!.root.findByType(SelectionToolbar).props.actions.find((value: { key: string }) => value.key === key)
  assert.ok(action, key)
  action.onClick()
}
afterEach(async () => { await act(async () => renderer?.unmount()); client?.clear(); failList = false })

test('actual Library selection survives window eviction and both bulk commands use original revisions', async () => {
  await mount()
  await wait(() => renderer!.root.findAllByType(Grid).length === 1)
  act(() => grid().props.onToggleSelect(rows[0], 0))
  for (const offset of [200, 400, 600]) {
    act(() => grid().props.catalogWindow.onVisibleRange(offset, offset + 9))
    await wait(() => grid().props.videos.some((video: { id: number }) => video.id === offset + 1))
  }
  assert.ok(!grid().props.videos.some((video: { id: number }) => video.id === 1))
  assert.deepEqual([...grid().props.selectedIds], [1])
  act(() => grid().props.onToggleSelect(rows[600], 600))
  act(() => bulk('remove'))
  await wait(() => !modal().props.confirmDisabled)
  assert.deepEqual(previews.sort((a, b) => a - b), [1, 601])
  await act(async () => modal().props.onConfirm())
  await wait(() => commits.length === 2)
  assert.deepEqual(commits.map(({ videoId, expectedRevision }) => ({ videoId, expectedRevision })), [
    { videoId: 1, expectedRevision: 'revision-1' }, { videoId: 601, expectedRevision: 'revision-601' }
  ])
  await wait(() => renderer!.root.findAllByType(Modal).length === 0)
  act(() => grid().props.onToggleSelect(rows[600], 600))
  act(() => bulk('delete'))
  await wait(() => !modal().props.confirmDisabled)
  await act(async () => modal().props.onConfirm())
  await wait(() => commits.length === 3)
  assert.equal(commits[2].expectedRevision, 'revision-601')
})

test('actual bulk dialog gates held preview, cancels queued IPC on close, and retries failures', async () => {
  await mount()
  await wait(() => renderer!.root.findAllByType(Grid).length === 1)
  for (let i = 0; i < 20; i++) act(() => grid().props.onToggleSelect(rows[i], i))
  let release!: () => void
  holdPreview = new Promise(resolve => { release = resolve })
  await act(async () => bulk('delete'))
  assert.equal(previews.length, 4)
  assert.equal(modal().props.confirmDisabled, true)
  act(() => modal().props.onCancel())
  await act(async () => release())
  assert.equal(previews.length, 4)
  previewFailure = true
  await act(async () => bulk('delete'))
  await wait(() => renderer!.root.findAllByType(Modal).length === 0)
  previewFailure = false
  act(() => bulk('delete'))
  await wait(() => !modal().props.confirmDisabled)
  assert.equal(commits.length, 0)
})

test('initial catalog failure presents actionable retry instead of empty library', async () => {
  failList = true
  await mount()
  await wait(() => renderer!.root.findAllByType('button').some(button => button.children.join('') === '重试'))
  failList = false
  act(() => renderer!.root.findAllByType('button').find(button => button.children.join('') === '重试')!.props.onClick())
  await wait(() => renderer!.root.findAllByType(Grid).length === 1)
})

test('actual Shift crosses nonresident pages using half-open window identities', async () => {
  await mount()
  await wait(() => renderer!.root.findAllByType(Grid).length === 1)
  act(() => grid().props.onToggleSelect(rows[0], 0))
  for (const offset of [200, 400, 600]) {
    act(() => grid().props.catalogWindow.onVisibleRange(offset, offset + 9))
    await wait(() => grid().props.videos.some((video: { id: number }) => video.id === offset + 1))
  }
  await act(async () => grid().props.onToggleSelect(rows[600], 600, { shiftKey: true, preventDefault() {} }))
  await wait(() => grid().props.selectedIds.size === 601)
  assert.deepEqual([...grid().props.selectedIds], Array.from({ length: 601 }, (_, index) => index + 1))
  assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0)
})


test('unscraped count query caches only total, never its wide candidate DTO', async () => {
  await mount()
  const countQuery = () => client.getQueryCache().getAll().find(query =>
    query.queryKey.includes('unscraped-count'))
  await wait(() => countQuery()?.state.status === 'success')
  assert.deepEqual(countQuery()!.state.data, { total: 700 })
})
