import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactPreview, createBulkPreviewQueue } from './bulkPreview'
import type { VideoLifecycleImpact } from '@shared/videoLifecycleTypes'

const targets = Array.from({ length: 100 }, (_, id) => ({ id }))
const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }
test('bulk IPC concurrency is bounded across obsolete jobs and queued work is cancelled', async () => {
  const queue = createBulkPreviewQueue(4)
  const first = new AbortController()
  const second = new AbortController()
  let active = 0, max = 0
  const calls: number[] = [], release: (() => void)[] = []
  const old = queue.run(targets, async ({ id }) => {
    calls.push(id); active++; max = Math.max(max, active)
    await new Promise<void>(resolve => release.push(resolve))
    active--; return id
  }, first.signal)
  await tick()
  assert.equal(active, 4)
  first.abort()
  const next = queue.run(targets.slice(0, 8), async ({ id }) => {
    active++; max = Math.max(max, active); await tick(); active--; return id
  }, second.signal)
  await tick()
  assert.equal(active, 4)
  release.forEach(done => done())
  assert.equal(await old, undefined)
  assert.equal((await next)?.size, 8)
  assert.deepEqual(calls, [0, 1, 2, 3])
  assert.equal(max, 4)
})

test('failed preview drains in-flight requests, stops queued calls, and retry succeeds', async () => {
  const queue = createBulkPreviewQueue(2)
  let count = 0
  await assert.rejects(queue.run(targets, async () => { count++; throw new Error('preview failed') }, new AbortController().signal), /preview failed/)
  assert.equal(count, 2)
  const result = await queue.run(targets, async ({ id }) => ({ revision: `rev-${id}` }), new AbortController().signal)
  assert.equal(result?.size, 100)
  assert.deepEqual(result?.get(99), { revision: 'rev-99' })
})

test('aborted queued job never starts and rejected obsolete IPC is observed', async () => {
  const queue = createBulkPreviewQueue(1)
  const controller = new AbortController()
  let reject!: (error: Error) => void
  const first = queue.run(targets, () => new Promise((_yes, no) => { reject = no }), controller.signal)
  await tick()
  controller.abort()
  const queued = queue.run(targets, async () => { assert.fail('cancelled job started') }, controller.signal)
  reject(new Error('late IPC rejection'))
  assert.equal(await first, undefined)
  assert.equal(await queued, undefined)
})

test('bulk impact keeps exact revision and counts without retaining wide detail arrays', () => {
  const impact = { videoId: 7, revision: 'exact revision', sourcePaths: ['a', 'b'], resourceIds: [1, 2, 3], resources: [{ displayLocator: 'large' }] } as VideoLifecycleImpact
  assert.deepEqual(compactPreview(impact, false), { videoId: 7, revision: 'exact revision', sourcePathCount: 2, resourceCount: 3 })
  assert.equal(compactPreview(impact, true).detail, impact)
})
