import { it } from 'node:test'
import assert from 'node:assert/strict'
import { AssetReadQueue, AssetReadQueueFullError } from './readQueue'

it('defaults to four active reads and 256 queued requests with reusable cancellation capacity', async () => {
  const queue = new AssetReadQueue()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let active = 0
  let peak = 0
  const read = async () => { active++; peak = Math.max(peak, active); await gate; active-- }
  const abort = new AbortController()
  const requests = Array.from({ length: 260 }, (_, i) => queue.run(read, i === 259 ? abort.signal : undefined))
  const cancelled = assert.rejects(requests.pop()!, { name: 'AbortError' })
  await assert.rejects(queue.run(read), AssetReadQueueFullError)
  assert.equal(active, 4)
  abort.abort()
  await cancelled
  requests.push(queue.run(read))
  release()
  await Promise.all(requests)
  assert.equal(peak, 4)
})

it('bounds active and queued reads, removes cancelled work and releases capacity after failures', async () => {
  const queue = new AssetReadQueue(1, 1)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let opened = 0
  const first = queue.run(async () => { opened++; await gate; return 1 })
  const abort = new AbortController()
  const cancelled = queue.run(async () => { opened++; return 2 }, abort.signal)
  const rejected = assert.rejects(cancelled, { name: 'AbortError' })
  await assert.rejects(queue.run(async () => 3), AssetReadQueueFullError)
  abort.abort()
  await rejected
  const next = queue.run(async () => { opened++; throw Error('read failed') })
  const failed = assert.rejects(next, /read failed/)
  assert.equal(opened, 1)
  release()
  assert.equal(await first, 1)
  await failed
  assert.equal(await queue.run(async () => 4), 4)
  assert.equal(opened, 2)
})

it('does not free an active slot before an aborted reader actually settles', async () => {
  const queue = new AssetReadQueue(1, 1)
  const abort = new AbortController()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const active = queue.run(async () => { await gate; abort.signal.throwIfAborted() }, abort.signal)
  const rejected = assert.rejects(active, { name: 'AbortError' })
  let opened = false
  const next = queue.run(async () => { opened = true })
  abort.abort()
  await Promise.resolve()
  assert.equal(opened, false)
  release()
  await rejected
  await next
  assert.equal(opened, true)
  await assert.rejects(queue.run(async () => { throw Error('must not open') }, abort.signal), { name: 'AbortError' })
})
