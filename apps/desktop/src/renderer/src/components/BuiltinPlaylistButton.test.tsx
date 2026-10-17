import assert from 'node:assert/strict'
import { afterEach, before, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import type { VideoCard } from '@shared/videoTypes'
import { ToastProvider } from './Toast'

const requests: Array<{ resolve: (value: typeof memberships) => void; reject: (error: Error) => void }> = []
const writes: unknown[][] = []
const memberships = [
  { id: 12, system_kind: 'watch_later', contains_video: false, generation: 1, revision: 4 },
  { id: 27, system_kind: 'favorites', contains_video: false, generation: 2, revision: 9 }
]
let finishWrite: () => Promise<boolean> = async () => true
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { api: { playlists: {
  listForVideo: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  addVideo: (...args: unknown[]) => { writes.push(['add', ...args]); return finishWrite() },
  removeVideo: (...args: unknown[]) => { writes.push(['remove', ...args]); return finishWrite() }
} } }) })

let PlaylistButton: typeof import('./BuiltinPlaylistButton')['default']
let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient
let subscriptions: Array<() => void> = []
let reads: string[] = []
const pageKey = ['videos', 'list', 'library:1', 'test', {}, 'window-page', 0]
before(async () => { PlaylistButton = (await import('./BuiltinPlaylistButton')).default })
afterEach(() => {
  act(() => renderer?.unmount())
  subscriptions.forEach(unsubscribe => unsubscribe())
  subscriptions = []
  client?.clear()
  renderer = undefined
  requests.length = 0
  writes.length = 0
  finishWrite = async () => true
  reads = []
})

const video: VideoCard = { id: 7, code: 'TEST-007', title: '测试影片', cover_path: null, scraped_status: 1, is_favorite: 0, is_watch_later: 0 }
async function mount(kind: 'favorites' | 'watch_later', selected = false): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const item = { ...video, is_favorite: Number(selected), is_watch_later: Number(selected) }
  const page = { items: [item, { ...item, id: 8 }], total: 2 }
  client.setQueryData(pageKey, page)
  client.setQueryData(['media-libraries', 'detail', 1], { id: 1, videoCount: 2 })
  for (const queryKey of [pageKey, ['media-libraries', 'detail', 1]]) {
    const observer = new QueryObserver(client, { queryKey, staleTime: Infinity,
      queryFn: async () => { reads.push(String(queryKey[0])); return client.getQueryData(queryKey)! } })
    subscriptions.push(observer.subscribe(() => {}))
  }
  await act(async () => { renderer = TestRenderer.create(<QueryClientProvider client={client}><ToastProvider>
    <PlaylistButton video={item} kind={kind} />
    <PlaylistButton video={item} kind={kind} />
  </ToastProvider></QueryClientProvider>) })
}
function buttons(): TestRenderer.ReactTestInstance[] {
  return renderer!.root.findAllByType('button').filter(button => button.props['aria-pressed'] !== undefined)
}

for (const kind of ['favorites', 'watch_later'] as const) {
  it(`${kind} keeps its icon stable and blocks duplicate clicks until the write succeeds`, async () => {
    await mount(kind)
    const original = buttons()[0]
    const icon = original.findByType('svg')
    const fill = icon.props.fill
    let complete!: (value: boolean) => void
    finishWrite = () => new Promise(resolve => { complete = resolve })
    let stopped = 0
    const event = { stopPropagation() { stopped++ } }
    let pending!: Promise<void>
    act(() => {
      pending = original.props.onClick(event)
      void original.props.onClick(event)
    })
    assert.equal(requests.length, 1, 'a same-frame second click must not start another request')
    assert.equal(stopped, 2, 'even blocked clicks must not open the card')
    assert.equal(buttons()[0].props.disabled, undefined, 'native disabled opacity must not dim the icon')
    assert.equal(buttons()[0].props['aria-disabled'], true)
    assert.equal(buttons()[0].props['aria-busy'], true)
    assert.equal(buttons()[0].props['aria-pressed'], false)
    assert.equal(buttons()[0].findByType('svg'), icon)
    assert.equal(icon.props.fill, fill)
    await act(async () => requests[0].resolve(memberships))
    const target = memberships.find(item => item.system_kind === kind)!
    assert.deepEqual(writes, [['add', target.id, video.id, { P: { generation: target.generation, revision: target.revision } }]])
    assert.equal(buttons()[0].props['aria-busy'], true, 'remain locked through the write, not only the membership lookup')
    await act(async () => { complete(true); await pending })
    assert.equal(buttons()[0], original, 'keep the same button mounted')
    assert.ok(buttons().every(button => button.props['aria-pressed'] === true), 'synchronize other copies after success')
    assert.equal(buttons()[0].props['aria-busy'], false)
    assert.deepEqual(reads, [], 'membership must not refetch the wall or unrelated library metadata')
    const page = client.getQueryData<{ items: VideoCard[]; total: number }>(pageKey)!
    assert.equal(page.items[0][kind === 'favorites' ? 'is_favorite' : 'is_watch_later'], 1)
    assert.equal(page.items[1][kind === 'favorites' ? 'is_favorite' : 'is_watch_later'], 0)
    assert.equal(page.total, 2, 'the library count must stay stable')

    finishWrite = async () => true
    act(() => { pending = buttons()[0].props.onClick(event) })
    await act(async () => { requests[1].resolve(memberships.map(item => ({ ...item, contains_video: true }))); await pending })
    assert.equal(writes[1][0], 'remove')
    assert.equal(writes[1][1], target.id)
    assert.ok(buttons().every(button => button.props['aria-pressed'] === false))
    assert.equal(client.getQueryData<{ items: VideoCard[] }>(pageKey)!.items[0][kind === 'favorites' ? 'is_favorite' : 'is_watch_later'], 0)
    assert.deepEqual(reads, [])
  })
}

it('keeps the confirmed selection on read/write failure, shows the error and permits retry', async () => {
  await mount('favorites', true)
  let pending!: Promise<void>
  const event = { stopPropagation() {} }
  act(() => { pending = buttons()[0].props.onClick(event) })
  await act(async () => { requests[0].reject(new Error('读取失败')); await pending })
  assert.equal(buttons()[0].props['aria-pressed'], true)
  assert.equal(buttons()[0].props['aria-busy'], false)
  assert.match(JSON.stringify(renderer!.toJSON()), /读取失败/)
  finishWrite = async () => { throw new Error('保存失败') }
  act(() => { pending = buttons()[0].props.onClick(event) })
  await act(async () => { requests[1].resolve(memberships.map(item => ({ ...item, contains_video: true }))); await pending })
  assert.equal(buttons()[0].props['aria-pressed'], true)
  assert.equal(buttons()[0].props['aria-busy'], false)
  assert.match(JSON.stringify(renderer!.toJSON()), /保存失败/)
  finishWrite = async () => true
  act(() => { pending = buttons()[0].props.onClick(event) })
  await act(async () => { requests[2].resolve(memberships.map(item => ({ ...item, contains_video: true }))); await pending })
  assert.equal(buttons()[0].props['aria-pressed'], false)
})
