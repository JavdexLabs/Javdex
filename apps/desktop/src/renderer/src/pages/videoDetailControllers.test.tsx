import assert from 'node:assert/strict'
import { before, afterEach, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { VideoLifecycleImpact, VideoLifecycleResult } from '@shared/videoLifecycleTypes'
import type { VideoResource } from '@shared/videoTypes'
import type { ElectronApi } from '../../../preload/index'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function impact(id = 1, revision = 'first'): VideoLifecycleImpact {
  return { kind: 'delete-globally', revision, videoId: id, sourceLibraryId: null, targetLibraryId: null,
    resourceIds: [], sourcePaths: [], remainingLibraryIds: [], removesCanonicalVideo: true,
    playlistCount: 0, assetCount: 0, libraries: [], resources: [], playlists: [], mediaAssets: [],
    pendingScrapeCount: 0, pendingAgentDraftCount: 0, pendingStagingAssetCount: 0, sourceFilesPreserved: false }
}
const resource = { id: 7, video_id: 1, library_id: 1, kind: 'local', display_name: 'old', locator: '/file' } as VideoResource
const fake = { videos: {
  previewDeleteGlobally: async (_id: number) => impact(),
  previewRemoveFromLibrary: async (_library: number, _id: number) => impact(),
  deleteGlobally: async (_input: unknown): Promise<unknown> => ({}),
  removeFromLibrary: async (_input: unknown): Promise<unknown> => ({}),
  getResource: async () => resource,
  updateLocalResourceLabel: async (..._args: unknown[]) => true,
  setPrimaryResource: async () => true,
  removeResource: async (..._args: unknown[]): Promise<unknown> => ({ videoDeleted: false })
} }
Object.assign(globalThis, { window: { api: fake as unknown as ElectronApi } })
let useVideoLifecycleController: typeof import('./useVideoLifecycleController').useVideoLifecycleController
let useVideoResourceController: typeof import('./useVideoResourceController').useVideoResourceController
before(async () => {
  ;({ useVideoLifecycleController } = await import('./useVideoLifecycleController'))
  ;({ useVideoResourceController } = await import('./useVideoResourceController'))
})
const messages: string[] = []
let refreshes = 0
let invalidations = 0
let renderer: TestRenderer.ReactTestRenderer | undefined
function Lifecycle({ id = 1 }: { id?: number }) {
  const controller = useVideoLifecycleController({ scopeKey: String(id), videoId: id, libraryId: 1,
    onCommitted: () => { refreshes++ },
    onSuccess: message => messages.push(message), onError: message => messages.push(message) })
  const action = controller.deletion
  return <><button onClick={action.open}>open</button><button onClick={action.close}>close</button>
    <button disabled={!action.impact || action.busy} onClick={action.commit}>commit</button>
    <output>{action.isOpen ? action.loading ? 'loading' : action.busy ? 'busy' : action.impact?.revision : 'closed'}</output></>
}
function Resources({ id = 1, sourceMembershipRemoved = false }: { id?: number; sourceMembershipRemoved?: boolean }) {
  const c = useVideoResourceController({ scopeKey: String(id), videoId: id,
    libraryId: 1,
    notify: message => messages.push(message), invalidateVideos: () => { invalidations++ },
    refresh: () => { refreshes++ }, leave: () => messages.push('leave') })
  return <><button onClick={() => c.openResourceEditor({ ...resource, display_locator: '/file' })}>edit</button>
    <button onClick={() => c.setLocalResourceLabel('new')}>label</button>
    <button onClick={c.saveLocalResourceLabel}>save</button>
    <button onClick={() => c.closeResourceEditor()}>close-edit</button>
    <button onClick={c.resourceUpdated}>updated</button>
    <button onClick={() => c.openResourceMove({ ...resource, kind: 'direct', display_locator: '/file' })}>move</button>
    <button onClick={c.closeResourceMove}>close-move</button>
    <button onClick={() => c.resourceMoved({ operationId: 'move', kind: 'move-resource', videoId: id,
      sourceLibraryId: 1, targetLibraryId: 2, resourceIds: [7], promotedResourceId: null,
      canonicalVideoDeleted: false, sourceMembershipRemoved } satisfies VideoLifecycleResult)}>moved</button>
    <button onClick={() => c.openResourceRemoval({ ...resource, display_locator: '/file' })}>remove</button>
    <button onClick={() => c.doRemoveResource()}>commit</button>
    <output>{c.editResourceTarget ? c.localResourceLabel : c.moveResourceTarget ? 'moving' : c.removingResource ? 'busy' : 'closed'}</output></>
}
const button = (label: string) => renderer!.root.findAllByType('button').find(node => node.children[0] === label)!
const output = () => renderer!.root.findByType('output').children.join('')
async function click(label: string) { await act(async () => { await button(label).props.onClick() }) }
async function mount(element: React.ReactElement) { await act(async () => { renderer = TestRenderer.create(element) }) }
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined; messages.length = 0; refreshes = 0; invalidations = 0
  fake.videos.previewDeleteGlobally = async () => impact()
  fake.videos.previewRemoveFromLibrary = async () => impact()
  fake.videos.deleteGlobally = async () => ({})
  fake.videos.removeFromLibrary = async () => ({})
  fake.videos.getResource = async () => resource
  fake.videos.updateLocalResourceLabel = async () => true
  fake.videos.removeResource = async () => ({ videoDeleted: false })
})

test('lifecycle refreshes a failed commit preview and submits its new revision', async () => {
  const calls: Array<{ expectedRevision: string; operationId: string }> = []
  fake.videos.deleteGlobally = async input => {
    calls.push(input as typeof calls[number])
    if (calls.length === 1) throw new Error('changed')
    return {}
  }
  await mount(<Lifecycle />)
  await click('open')
  fake.videos.previewDeleteGlobally = async () => impact(1, 'second')
  await click('commit')
  assert.equal(output(), 'second')
  await click('commit')
  assert.deepEqual(calls.map(call => call.expectedRevision), ['first', 'second'])
  assert.equal(output(), 'closed')
  assert.deepEqual(messages, ['changed', '已删除影片'])
})

test('closed or navigated previews cannot reopen the confirmation', async () => {
  const pending = deferred<VideoLifecycleImpact>()
  fake.videos.previewDeleteGlobally = () => pending.promise
  await mount(<Lifecycle />)
  let request: Promise<void>
  await act(async () => { request = button('open').props.onClick() })
  await click('close')
  await act(async () => { renderer!.update(<Lifecycle id={2} />); pending.resolve(impact()); await request })
  assert.equal(output(), 'closed')
  assert.deepEqual(messages, [])
})

test('commit rejects duplicate clicks and does not navigate a different video on completion', async () => {
  const pending = deferred<unknown>(); let calls = 0
  fake.videos.deleteGlobally = () => { calls++; return pending.promise }
  await mount(<Lifecycle />); await click('open')
  let request: Promise<void>
  await act(async () => { const commit = button('commit').props.onClick; request = commit(); void commit() })
  assert.equal(calls, 1)
  await click('close'); assert.equal(output(), 'busy')
  await act(async () => { renderer!.update(<Lifecycle id={2} />) })
  await act(async () => { pending.resolve({}); await request })
  assert.equal(output(), 'closed'); assert.deepEqual(messages, [])
  assert.equal(refreshes, 1)
})

test('lifecycle no longer exposes the retired manual membership removal action', async () => {
  let keys: string[] = []
  function Probe() {
    keys = Object.keys(useVideoLifecycleController({ scopeKey: '1', videoId: 1, libraryId: 1,
      onCommitted: () => {}, onSuccess: () => {}, onError: () => {} }))
    return null
  }
  await mount(<Probe />)
  assert.deepEqual(keys, ['deletion'])
})

test('resource editor saves the label and refreshes after completion', async () => {
  let args: unknown[] = []
  fake.videos.updateLocalResourceLabel = async (...values) => { args = values; return true }
  await mount(<Resources />); await click('edit'); await click('label'); await click('save')
  assert.deepEqual(args, [1, 1, 7, 'new']); assert.equal(refreshes, 1); assert.equal(output(), 'closed')
})

test('resource lookup cannot open an editor after switching video', async () => {
  const pending = deferred<VideoResource>(); fake.videos.getResource = () => pending.promise
  await mount(<Resources />)
  let request: Promise<void>
  await act(async () => { request = button('edit').props.onClick() })
  await act(async () => { renderer!.update(<Resources id={2} />) })
  await act(async () => { pending.resolve(resource); await request })
  assert.equal(output(), 'closed'); assert.deepEqual(messages, [])
})

test('resource saves reject duplicate clicks and cannot close a later edit session', async () => {
  const pending = deferred<boolean>(); let calls = 0
  fake.videos.updateLocalResourceLabel = () => { calls++; return pending.promise }
  await mount(<Resources />); await click('edit')
  let request: Promise<void>
  await act(async () => { const save = button('save').props.onClick; request = save(); void save() })
  assert.equal(calls, 1)
  await click('close-edit'); await click('edit'); await click('label')
  await act(async () => { pending.resolve(true); await request })
  assert.equal(output(), 'new'); assert.deepEqual(messages, [])
  assert.equal(invalidations, 1); assert.equal(refreshes, 0)
})

test('a failed resource save keeps the edit session and allows retry', async () => {
  let calls = 0
  fake.videos.updateLocalResourceLabel = async () => { if (++calls === 1) throw new Error('save failed'); return true }
  await mount(<Resources />); await click('edit'); await click('label')
  await act(async () => { await assert.rejects(button('save').props.onClick(), /save failed/) })
  assert.equal(output(), 'new'); assert.deepEqual(messages, [])
  await click('save'); assert.equal(output(), 'closed'); assert.equal(calls, 2)
})

test('obsolete resource failures and modal completions leave the new session alone', async () => {
  const pending = deferred<boolean>()
  fake.videos.updateLocalResourceLabel = () => pending.promise
  await mount(<Resources />); await click('edit')
  const oldUpdated = button('updated').props.onClick
  let request: Promise<void>
  await act(async () => { request = button('save').props.onClick() })
  await click('close-edit'); await click('edit'); await click('label')
  await act(async () => { pending.reject(new Error('obsolete')); await request; oldUpdated() })
  assert.equal(output(), 'new'); assert.deepEqual(messages, [])
  assert.equal(invalidations, 1); assert.equal(refreshes, 0)
})

test('closing a pending resource editor cancels its eventual opening', async () => {
  const pending = deferred<VideoResource>(); fake.videos.getResource = () => pending.promise
  await mount(<Resources />)
  let request: Promise<void>
  await act(async () => { request = button('edit').props.onClick() })
  await click('close-edit')
  await act(async () => { pending.resolve(resource); await request })
  assert.equal(output(), 'closed')
})

test('an obsolete move completion cannot close a new move confirmation', async () => {
  await mount(<Resources />); await click('move')
  const oldMoved = button('moved').props.onClick
  await click('close-move'); await click('move')
  await act(async () => { oldMoved() })
  assert.equal(output(), 'moving'); assert.deepEqual(messages, [])
  assert.equal(invalidations, 1)
  await click('moved'); assert.equal(output(), 'closed'); assert.equal(refreshes, 1)
})

test('resource removal preserves confirmation after failure and allows retry', async () => {
  let calls = 0
  fake.videos.removeResource = async () => { if (++calls === 1) throw new Error('busy file'); return { videoDeleted: true } }
  await mount(<Resources />); await click('remove'); await click('commit'); await click('commit')
  assert.equal(calls, 2); assert.ok(messages.includes('busy file')); assert.ok(messages.includes('leave'))
})

test('resource removal leaves the detail when its empty source affiliation is pruned', async () => {
  fake.videos.removeResource = async () => ({ videoDeleted: false, membershipRemoved: true })
  await mount(<Resources />); await click('remove'); await click('commit')
  assert.deepEqual(messages, ['资源已移除，影片已自动移出当前媒体库', 'leave'])
  assert.equal(refreshes, 0)
})

test('move completion leaves a pruned affiliation but stale completions cannot leave a new video', async () => {
  await mount(<Resources sourceMembershipRemoved />); await click('move')
  const oldMoved = button('moved').props.onClick
  await act(async () => renderer!.update(<Resources id={2} sourceMembershipRemoved />))
  await act(async () => oldMoved())
  assert.deepEqual(messages, [])
  await click('move'); await click('moved')
  assert.deepEqual(messages, ['资源已移动到目标媒体库', 'leave'])
  assert.equal(refreshes, 0)
})
