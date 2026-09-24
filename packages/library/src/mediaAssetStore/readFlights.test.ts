import { it } from 'node:test'
import assert from 'node:assert/strict'
import { AssetReadFlights } from './readFlights'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

it('shares a read while one consumer cancels and preserves independent result buffers', async () => {
  const flights = new AssetReadFlights()
  const pending = gate()
  let calls = 0
  let underlying: AbortSignal | undefined
  const read = async (signal: AbortSignal) => {
    calls++; underlying = signal
    await pending.promise
    return { body: Buffer.from('image'), mime: 'image/png' }
  }
  const abort = new AbortController()
  const a = flights.run('image', read, abort.signal)
  const rejected = assert.rejects(a, { name: 'AbortError' })
  const b = flights.run('image', read)
  const c = flights.run('image', read)
  await Promise.resolve()
  abort.abort()
  await rejected
  assert.equal(underlying?.aborted, false)
  pending.release()
  const [first, second] = await Promise.all([b, c])
  first.body.fill(0)
  assert.equal(second.body.toString(), 'image')
  assert.equal(calls, 1)
  await flights.run('image', read)
  assert.equal(calls, 2, 'completed flights are not a second permanent cache')
})

it('drains the last cancelled consumer without deleting a newer flight under the same key', async () => {
  const flights = new AssetReadFlights()
  const old = gate()
  const next = gate()
  const abort = new AbortController()
  let calls = 0
  let oldSignal: AbortSignal | undefined
  const oldRead = async (signal: AbortSignal) => {
    calls++; oldSignal = signal
    await old.promise
    return { body: Buffer.from('old'), mime: 'image/png' }
  }
  let settled = false
  const first = flights.run('image', oldRead, abort.signal).finally(() => { settled = true })
  const rejected = assert.rejects(first, { name: 'AbortError' })
  await Promise.resolve()
  abort.abort()
  await Promise.resolve()
  assert.equal(oldSignal?.aborted, true)
  assert.equal(settled, false)
  const nextRead = async () => { calls++; await next.promise; return { body: Buffer.from('new'), mime: 'image/png' } }
  const second = flights.run('image', nextRead)
  old.release()
  await rejected
  const third = flights.run('image', nextRead)
  next.release()
  assert.ok((await Promise.all([second, third])).every((image) => image.body.toString() === 'new'))
  assert.equal(calls, 2)
})

it('fans out failures and permits a fresh attempt', async () => {
  const flights = new AssetReadFlights()
  let calls = 0
  const fail = async () => { calls++; throw Error('read failed') }
  await Promise.all([
    assert.rejects(flights.run('image', fail), /read failed/),
    assert.rejects(flights.run('image', fail), /read failed/)
  ])
  assert.equal(calls, 1)
  assert.equal((await flights.run('image', async () => ({ body: Buffer.from('ok'), mime: 'image/png' }))).body.toString(), 'ok')
})

it('aborts the underlying work only after all consumers cancel and drains the final slot', async () => {
  const flights = new AssetReadFlights()
  const pending = gate()
  let signal: AbortSignal | undefined
  const read = async (value: AbortSignal) => { signal = value; await pending.promise; return { body: Buffer.from('image'), mime: 'image/png' } }
  const a = new AbortController()
  const b = new AbortController()
  const first = assert.rejects(flights.run('image', read, a.signal), { name: 'AbortError' })
  let settled = false
  const last = assert.rejects(flights.run('image', read, b.signal).finally(() => { settled = true }), { name: 'AbortError' })
  await Promise.resolve()
  a.abort()
  await first
  assert.equal(signal?.aborted, false)
  b.abort()
  await Promise.resolve()
  assert.equal(signal?.aborted, true)
  assert.equal(settled, false)
  pending.release()
  await last
})
