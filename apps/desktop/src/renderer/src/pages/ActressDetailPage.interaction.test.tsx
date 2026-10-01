import { continuousViewport } from '../test/continuousViewport'
import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActressProfile, ActressVideoPageQuery } from '@shared/actressTypes'
import type { ExpectedVersions } from '@shared/protocol/versions'
import type { ElectronApi } from '../../../preload/index'

let metadataResponse: ((id: number) => Promise<ActressProfile>) | null = null
let editResponse: (() => Promise<boolean>) | null = null
let fail = false
let hold: (() => Promise<unknown>) | null = null
let total = 125
const actorTotals = new Map<number, number>()
const calls: Array<{ id: number; query: ActressVideoPageQuery }> = []
const metadataCalls: number[] = []
const editCalls: Array<{ id: number; expectedVersions: ExpectedVersions }> = []
function metadata(id: number): ActressProfile {
  return { id, main_name: `Actor-${id}`, gender: 'female', names: [], aliases: [], gallery_count: 0, display_gallery_count: 0, first_gallery: null, links: [], avatar_path: null, avatar_source_path: null, scraped_status: 0, generation: 1, revision: 1 } as unknown as ActressProfile
}
function page(id: number, offset: number) {
  const actorTotal = actorTotals.get(id) ?? total
  return { videos: Array.from({ length: Math.min(60, Math.max(0, actorTotal - offset)) }, (_, n) => ({ id: id * 1000 + offset + n, code: `WORK-${id}-${offset+n}`, title: null, cover_path: null, scraped_status: 0, resource_kinds: [] })), total: actorTotal, limit: 60, offset }
}
const fake = {
  actresses: {
    galleryPage: async () => ({ items: [], total: 0, limit: 60, offset: 0 }),
    get: () => { throw new Error('Full actress detail forbidden') },
    metadata: () => { throw new Error('Full gallery metadata forbidden') },
    profile: async (id: number) => { metadataCalls.push(id); return metadataResponse ? metadataResponse(id) : metadata(id) },
    edit: async (id: number, _input: unknown, expectedVersions: ExpectedVersions) => {
      editCalls.push({ id, expectedVersions })
      return editResponse ? editResponse() : true
    },
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
let viewport=continuousViewport(), position=0
let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient
let navigate: NavigateFunction
let url = ''
function Nav() { navigate = useNavigate(); url = useLocation().pathname + useLocation().search; return null }
const text = (node: TestRenderer.ReactTestInstance): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('')
async function click(label: string) {
  if(label==='下一页'){position+=60;await viewport.scroll(renderer!,position);return}
  await act(async () => {
    const button = renderer!.root.findAllByType('button').find(node => text(node) === label || node.props['aria-label'] === label)!
    assert.ok(button, label)
    assert.ok(!button.props.disabled, label)
    button.props.onClick()
  })
}
async function mount(entry = '/actresses/1') {
  const Component = (await import('./ActressDetailPage')).default
  const { ImagePreviewOverlayProvider } = await import('../components/ImagePreviewOverlayContext')
  const { AppBackgroundProvider } = await import('../components/AppBackgroundContext')
  const { AgentMetadataCollectorProvider } = await import('../components/agentMetadata/AgentMetadataCollectorContext')
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    renderer = TestRenderer.create(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}><AppBackgroundProvider><ImagePreviewOverlayProvider><AgentMetadataCollectorProvider><Nav /><Routes><Route path="/actresses/:id" element={<Component />}><Route path=":videoId" element={<div>Nested video<Outlet /></div>}><Route path="actress/:actressId" element={<Component fromVideo />} /></Route></Route></Routes></AgentMetadataCollectorProvider></ImagePreviewOverlayProvider></AppBackgroundProvider></MemoryRouter></QueryClientProvider>, {createNodeMock:viewport.createNodeMock})
  })
}
afterEach(async () => { await act(async () => renderer?.unmount()); client?.clear(); renderer = undefined;viewport=continuousViewport();position=0; url=''; calls.length = 0; metadataCalls.length = 0; editCalls.length = 0; actorTotals.clear(); total = 125; fail = false; hold = null; metadataResponse = null; editResponse = null })

it('keeps distinct parent and leaf actress identities in an actress-video-actress stack', async () => {
  actorTotals.set(2, 10)
  await mount('/actresses/1/1120/actress/2?relatedVideoOffset=60')
  assert.deepEqual([...new Set(metadataCalls)].sort(), [1, 2])
  const initialMetadataCalls = [...metadataCalls]
  const panes = renderer!.root.findAllByType('div').filter(node => 'data-detail-pane' in node.props)
  assert.equal(panes.length, 2)
  assert.equal(panes[0].props['data-stacked'], true)
  assert.equal(panes[1].props['data-stacked'], undefined)
  const parent = panes[0]
  assert.ok(text(parent).includes('Actor-1'))
  assert.ok(text(panes[1]).includes('Actor-2'))
  const leafBack = panes[1].findAllByType('button').find(node => text(node) === '返回')!
  assert.ok(leafBack)
  await act(async () => leafBack.props.onClick())
  assert.equal(url, '/actresses/1/1120?relatedVideoOffset=60')
  assert.equal(renderer!.root.findAllByType('div').filter(node => 'data-detail-pane' in node.props)[0], parent)
  assert.ok(text(parent).includes('Actor-1'))
  assert.deepEqual(metadataCalls, initialMetadataCalls)
})

it('keeps the leaf works offset when its parent has fewer works and drops only the leaf offset on return', async () => {
  actorTotals.set(1, 10)
  await mount('/actresses/1/1000/actress/2?actressVideoOffset=60')
  assert.ok(calls.some(call => call.id === 2 && call.query.offset === 60))
  assert.equal(url, '/actresses/1/1000/actress/2?actressVideoOffset=60')
  const panes = renderer!.root.findAllByType('div').filter(node => 'data-detail-pane' in node.props)
  const back = panes[1].findAllByType('button').find(node => text(node) === '返回')!
  await act(async () => back.props.onClick())
  assert.equal(url, '/actresses/1/1000')
})

it('loads metadata once while paging 60/60/5 works and preserving the full count', async () => {
  await mount()
  const PosterCard = (await import('../components/PosterCard')).default
  assert.ok(renderer!.root.findAllByType(PosterCard).length > 0 && renderer!.root.findAllByType(PosterCard).length <= 12)
  assert.ok(text(renderer!.root).includes('125 部'))
  await click('下一页')
  assert.ok(renderer!.root.findAllByType(PosterCard).length > 0 && renderer!.root.findAllByType(PosterCard).length <= 12)
  await click('下一页')
  assert.ok(renderer!.root.findAllByType(PosterCard).length >= 5 && renderer!.root.findAllByType(PosterCard).length <= 12)
  assert.deepEqual(metadataCalls, [1])
  assert.deepEqual(calls.map(call => call.query.offset), [0,60,120])
  assert.match(url, /relatedVideoOffset=120/)
  const search = url.includes('?') ? url.slice(url.indexOf('?')) : ''
  await act(async () => navigate(`/actresses/1/1120${search}`))
  await act(async () => navigate(-1))
  assert.match(url, /relatedVideoOffset=120/)
  assert.ok(renderer!.root.findAllByType(PosterCard).length >= 5 && renderer!.root.findAllByType(PosterCard).length <= 12)
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
  assert.ok(text(renderer!.root).includes('30 部'))
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
  assert.deepEqual(editCalls, [{ id: 1, expectedVersions: { A: { generation: 1, revision: 1 } } }])
  let finishMetadata!: (value: ActressProfile) => void
  metadataResponse = id => id === 2 ? new Promise(done => { finishMetadata = done }) : Promise.resolve(metadata(id))
  await act(async () => navigate('/actresses/2'))
  await act(async () => { finishEdit(true); await operation })
  await act(async () => finishMetadata(metadata(2)))
  assert.ok(text(renderer!.root).includes('Actor-2'))
  assert.deepEqual(metadataCalls, [1,2])
})

it('keeps the version captured when the actress editor opened', async () => {
  await mount()
  await click('编辑')
  metadataResponse = async id => ({ ...metadata(id), revision: 2 })
  const { notifyAvatarAutoCropSaved } = await import('../avatarAutoCrop/events')
  await act(async () => notifyAvatarAutoCropSaved(1))
  const EditModal = (await import('../components/EditActressModal')).default
  await act(async () => renderer!.root.findByType(EditModal).props.onSave({ main_name: 'Updated A' }))
  assert.deepEqual(editCalls, [{ id: 1, expectedVersions: { A: { generation: 1, revision: 1 } } }])
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
  assert.ok(renderer!.root.findAllByType(PosterCard).length > 0 && renderer!.root.findAllByType(PosterCard).length <= 12)
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
  assert.ok(renderer!.root.findAllByType(PosterCard).length > 0 && renderer!.root.findAllByType(PosterCard).length <= 12)
})
