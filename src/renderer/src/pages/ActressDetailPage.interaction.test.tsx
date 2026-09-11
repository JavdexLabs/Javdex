import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActressProfile, ActressVideoPageQuery } from '@shared/actressTypes'
import type { ElectronApi } from '../../../preload/index'

let metadataResponse: ((id: number) => Promise<ActressProfile>) | null = null
let editResponse: (() => Promise<boolean>) | null = null
let fail = false
let hold: (() => Promise<unknown>) | null = null
let total = 125
const calls: Array<{ id: number; query: ActressVideoPageQuery }> = []
const metadataCalls: number[] = []
function metadata(id: number): ActressProfile {
  return { id, main_name: `Actor-${id}`, gender: 'female', names: [], aliases: [], gallery_count: 0, display_gallery_count: 0, first_gallery: null, links: [], avatar_path: null, avatar_source_path: null, scraped_status: 0 } as unknown as ActressProfile
}
function page(id: number, offset: number) {
  return { videos: Array.from({ length: Math.min(60, Math.max(0, total - offset)) }, (_, n) => ({ id: id * 1000 + offset + n, code: `WORK-${id}-${offset+n}`, title: null, cover_path: null, scraped_status: 0, resource_kinds: [] })), total, limit: 60, offset }
}
const fake = {
  actresses: {
    galleryPage: async () => ({ items: [], total: 0, limit: 60, offset: 0 }),
    get: () => { throw new Error('Full actress detail forbidden') },
    metadata: () => { throw new Error('Full gallery metadata forbidden') },
    profile: async (id: number) => { metadataCalls.push(id); return metadataResponse ? metadataResponse(id) : metadata(id) },
    edit: async () => editResponse ? editResponse() : true,
    mergeCandidates: async () => ({ items: [], hasMore: false, offset: 0 }),
    videoPage: async (id: number, query: ActressVideoPageQuery) => {
      if (query.withCover) return { videos: [], total: 0, limit: 60, offset: 0 }
      calls.push({ id, query })
      if (hold) { const run = hold; hold = null; return run() }
      if (fail) { fail = false; throw new Error('Page failed') }
      return page(id, query.offset ?? 0)
    }
  },
  settings: { get: async () => ({}) },
  actressScrape: { listPlugins: async () => [], listPluginDetails: async () => [] },
  agentMetadata: { onSnapshotChanged: () => () => {} }
} as unknown as ElectronApi
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { api: fake, requestAnimationFrame: (fn: () => void) => fn() }) })
Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: { style: { overflow: '' } }, activeElement: null } })
let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient
let navigate: NavigateFunction
function Nav() { navigate = useNavigate(); return null }
const text = (node: TestRenderer.ReactTestInstance): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('')
async function click(label: string) {
  await act(async () => {
    const button = renderer!.root.findAllByType('button').find(node => text(node) === label || node.props['aria-label'] === label)!
    assert.ok(button, label)
    assert.ok(!button.props.disabled, label)
    button.props.onClick()
  })
}
async function mount() {
  const Component = (await import('./ActressDetailPage')).default
  const { ImagePreviewOverlayProvider } = await import('../components/ImagePreviewOverlayContext')
  const { AppBackgroundProvider } = await import('../components/AppBackgroundContext')
  const { AgentMetadataCollectorProvider } = await import('../components/agentMetadata/AgentMetadataCollectorContext')
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    renderer = TestRenderer.create(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/actresses/1']}><AppBackgroundProvider><ImagePreviewOverlayProvider><AgentMetadataCollectorProvider><Nav /><Routes><Route path="/actresses/:id" element={<Component />}><Route path=":videoId" element={<div>Nested video</div>} /></Route></Routes></AgentMetadataCollectorProvider></ImagePreviewOverlayProvider></AppBackgroundProvider></MemoryRouter></QueryClientProvider>)
  })
}
afterEach(async () => { await act(async () => renderer?.unmount()); client?.clear(); renderer = undefined; calls.length = 0; metadataCalls.length = 0; total = 125; fail = false; hold = null; metadataResponse = null; editResponse = null })

it('loads metadata once while paging 60/60/5 works and preserving the full count', async () => {
  await mount()
  const PosterCard = (await import('../components/PosterCard')).default
  assert.equal(renderer!.root.findAllByType(PosterCard).length, 60)
  assert.ok(text(renderer!.root).includes('125 部'))
  await click('下一页')
  assert.equal(renderer!.root.findAllByType(PosterCard).length, 60)
  await click('下一页')
  assert.equal(renderer!.root.findAllByType(PosterCard).length, 5)
  assert.deepEqual(metadataCalls, [1])
  assert.deepEqual(calls.map(call => call.query.offset), [0,60,120])
  await act(async () => navigate('/actresses/1/1120'))
  await act(async () => navigate('/actresses/1'))
  assert.equal(renderer!.root.findAllByType(PosterCard).length, 5)
})

it('retries page errors, clamps a removed last page, and rejects late actor results', async () => {
  await mount()
  fail = true
  await click('下一页')
  assert.ok(text(renderer!.root).includes('Page failed'))
  await click('重试')
  total = 30
  await click('下一页')
  assert.deepEqual(calls.slice(-2).map(call => call.query.offset), [120, 0])
  assert.ok(text(renderer!.root).includes('共 30 部'))
  total = 125
  let resolve!: (value: unknown) => void
  hold = () => new Promise(done => { resolve = done })
  // Refresh the visible page by navigating to another actor, then leave before it completes.
  await act(async () => navigate('/actresses/2'))
  await act(async () => navigate('/actresses/3'))
  await act(async () => resolve(page(2, 0)))
  assert.ok(text(renderer!.root).includes('Actor-3'))
  const PosterCard = (await import('../components/PosterCard')).default
  assert.ok(renderer!.root.findAllByType(PosterCard).every(node => node.props.video.id >= 3000))
})

it('does not invalidate the new actor metadata when the old editor save settles late', async () => {
  await mount()
  await click('编辑')
  const EditModal = (await import('../components/EditActressModal')).default
  const save = renderer!.root.findByType(EditModal).props.onSave
  let finishEdit!: (value: boolean) => void
  editResponse = () => new Promise(done => { finishEdit = done })
  let operation!: Promise<void>
  await act(async () => { operation = save({ main_name: 'Updated A' }); await Promise.resolve() })
  let finishMetadata!: (value: ActressProfile) => void
  metadataResponse = id => id === 2 ? new Promise(done => { finishMetadata = done }) : Promise.resolve(metadata(id))
  await act(async () => navigate('/actresses/2'))
  await act(async () => { finishEdit(true); await operation })
  await act(async () => finishMetadata(metadata(2)))
  assert.ok(text(renderer!.root).includes('Actor-2'))
  assert.deepEqual(metadataCalls, [1,2])
})

it('retains an open merge plan and its full count while the visible works refresh', async () => {
  await mount()
  await click('更多')
  await click('合并演员')
  const MergeModal = (await import('../components/MergeActressModal')).default
  const modal = renderer!.root.findByType(MergeModal)
  assert.equal(modal.props.keepVideoCount, 125)
  const input = modal.findByType('input')
  await act(async () => input.props.onChange({ target: { value: 'Keep this search' } }))
  let resolve!: (value: unknown) => void
  hold = () => new Promise(done => { resolve = done })
  const { notifyAvatarAutoCropSaved } = await import('../avatarAutoCrop/events')
  await act(async () => notifyAvatarAutoCropSaved(1))
  const PosterCard = (await import('../components/PosterCard')).default
  assert.equal(renderer!.root.findAllByType(PosterCard).length, 60)
  const during = renderer!.root.findByType(MergeModal)
  assert.equal(during, modal)
  assert.equal(during.props.keepVideoCount, 125)
  assert.equal(during.findByType('input').props.value, 'Keep this search')
  await act(async () => resolve(page(1, 0)))
})

it('does not reuse the prior actor page when an intervening actor request is still pending', async () => {
  await mount()
  let finishB!: (value: unknown) => void
  hold = () => new Promise(done => { finishB = done })
  await act(async () => navigate('/actresses/2'))
  let finishA!: (value: unknown) => void
  hold = () => new Promise(done => { finishA = done })
  await act(async () => navigate('/actresses/1'))
  const PosterCard = (await import('../components/PosterCard')).default
  assert.equal(renderer!.root.findAllByType(PosterCard).length, 0)
  await act(async () => finishB(page(2, 0)))
  assert.equal(renderer!.root.findAllByType(PosterCard).length, 0)
  await act(async () => finishA(page(1, 0)))
  assert.equal(renderer!.root.findAllByType(PosterCard).length, 60)
})
