import assert from 'node:assert/strict'
import { afterEach, before, beforeEach, it } from 'node:test'
import React, { useState } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { ScopedVideoDetail } from '@shared/catalogTypes'
import type { ExpectedVersions } from '@shared/protocol/versions'
import VideoDetailRatings from '../components/VideoDetailRatings'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
const detail = (id = 1): ScopedVideoDetail => ({ id, activeLibraryId: 7, rating: 0,
  generation: 1, revision: 1, external_stats: [] } as unknown as ScopedVideoDetail)
let server: ScopedVideoDetail
const writes: Array<{ id: number; rating: number; revision: number }> = []
const messages: string[] = []
let invalidations = 0
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
let writeGate: ReturnType<typeof deferred> | null
let readGate: ReturnType<typeof deferred> | null
const fake = { videos: {
  setRating: async (id: number, rating: number, expected: ExpectedVersions) => {
    writes.push({ id, rating, revision: expected.V!.revision })
    await writeGate?.promise
    if (expected.V!.revision !== server.revision) throw new Error('影片资料已更新，请刷新后重新确认')
    server = { ...server, rating, revision: server.revision! + 1 }
    return true
  },
  get: async (scope: unknown, id: number) => {
    assert.deepEqual(scope, { kind: 'library', libraryId: 7 })
    assert.equal(id, 1)
    await readGate?.promise
    return { ...server }
  }
} }
Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: fake } })
let useVideoRatingController: typeof import('./useVideoRatingController').useVideoRatingController
before(async () => { ({ useVideoRatingController } = await import('./useVideoRatingController')) })
let renderer: TestRenderer.ReactTestRenderer | undefined
let controller: ReturnType<typeof useVideoRatingController>
function Harness({ id = 1 }: { id?: number }) {
  const [video, setVideo] = useState(detail(id))
  controller = useVideoRatingController({ scopeKey: String(id), video: video.id === id ? video : detail(id),
    updateVideo: setVideo, invalidateVideos: () => { invalidations++ }, notifyError: message => messages.push(message) })
  return <><VideoDetailRatings video={video} rating={controller.rating} onRatingChange={controller.handleRating} />
    <output>{`${video.id}:${video.rating}:${video.revision}:${controller.rating}`}</output></>
}
const output = () => renderer!.root.findByType('output').children.join('')
async function mount() { await act(async () => { renderer = TestRenderer.create(<Harness />) }) }
beforeEach(() => { server = detail(); writes.length = 0; messages.length = 0; invalidations = 0; writeGate = null; readGate = null })
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined })

it('refreshes the authoritative version between successive edits and clearing a rating', async () => {
  await mount()
  await act(async () => { await controller.handleRating(2) })
  await act(async () => { await controller.handleRating(4) })
  await act(async () => { await controller.handleRating(0) })
  assert.deepEqual(writes.map(write => [write.rating, write.revision]), [[2, 1], [4, 2], [0, 3]])
  assert.equal(output(), '1:0:4:0')
  assert.equal(invalidations, 3)
  assert.deepEqual(messages, [])
})

it('serializes rapid clicks and saves the latest choice after the refreshed version arrives', async () => {
  writeGate = deferred()
  readGate = deferred()
  await mount()
  let drain!: Promise<void>
  act(() => { drain = controller.handleRating(1) })
  act(() => { void controller.handleRating(3); void controller.handleRating(5) })
  assert.equal(controller.rating, 5)
  assert.equal(writes.length, 1)
  await act(async () => { writeGate!.resolve(); await writeGate!.promise })
  assert.equal(writes.length, 1, 'must not write the queued choice before refreshing the version')
  await act(async () => { readGate!.resolve(); await drain })
  assert.deepEqual(writes.map(write => [write.rating, write.revision]), [[1, 1], [5, 2]])
  assert.equal(output(), '1:5:3:5')
  assert.deepEqual(messages, [])
})

it('keeps the existing current-star click-to-clear behavior during continuous editing', async () => {
  await mount()
  const fifthStar = () => renderer!.root.findAllByType('button').find(node => node.props['aria-label'] === '5 星')!
  await act(async () => { fifthStar().props.onClick({ stopPropagation() {} }) })
  // The event starts the asynchronous write; flush it before the next edit.
  await act(async () => {})
  await act(async () => { fifthStar().props.onClick({ stopPropagation() {} }) })
  await act(async () => {})
  assert.equal(server.rating, 0)
  assert.deepEqual(writes.map(write => [write.rating, write.revision]), [[5, 1], [0, 2]])
})

it('reports real external conflicts without retrying and refreshes before the next explicit edit', async () => {
  await mount()
  server = { ...server, rating: 4, revision: 9 }
  await act(async () => { await controller.handleRating(2) })
  assert.equal(writes.length, 1)
  assert.deepEqual(messages, ['影片资料已更新，请刷新后重新确认'])
  assert.equal(output(), '1:4:9:4')
  await act(async () => { await controller.handleRating(3) })
  assert.equal(writes[1].revision, 9)
  assert.equal(server.rating, 3)
})

it('discards queued writes and UI updates when navigation changes the video', async () => {
  writeGate = deferred()
  await mount()
  let drain!: Promise<void>
  act(() => { drain = controller.handleRating(2); void controller.handleRating(5) })
  act(() => renderer!.update(<Harness id={2} />))
  await act(async () => { writeGate!.resolve(); await drain })
  assert.equal(writes.length, 1)
  assert.equal(controller.rating, 0)
  assert.deepEqual(messages, [])
  assert.equal(output(), '1:0:1:0', 'the previous video response must not update the mounted page')
})

it('does not surface an obsolete write failure after leaving the page', async () => {
  writeGate = deferred()
  await mount()
  let drain!: Promise<void>
  act(() => { drain = controller.handleRating(2) })
  act(() => renderer!.unmount())
  server = { ...server, revision: 5 }
  await act(async () => { writeGate!.resolve(); await drain })
  assert.deepEqual(messages, [])
})
