import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCpuFramePortReceiver, type CpuPixelsPort } from './cpuFramePort'
import type { CpuFrameEnvelope } from '../main/player/playbackHostProtocol'

const surfaceToken = 'cpu:11111111-1111-4111-8111-111111111111'
const bindingToken = '22222222-2222-4222-8222-222222222222'
const cpuChannelId = '33333333-3333-4333-8333-333333333333'
const replacement = '44444444-4444-4444-8444-444444444444'
function port() {
  let closed = 0
  const value: CpuPixelsPort = { onmessage: null, onmessageerror: null, start() {}, close() { closed++ } }
  return { value, closed: () => closed, pixel(sequence: number, timeline = 1, id = cpuChannelId, pixels = new Uint8Array(64)) {
    value.onmessage?.({ data: { cpuChannelId: id, sequence, timeline, pixels } })
  } }
}
function fixture() {
  const current = { surfaceToken, bindingToken, timeline: 1 }, packets: Array<CpuFrameEnvelope & { pixels: Uint8Array }> = []
  const releases: Array<{ bindingToken: string; sequence: number }> = [], failures: string[] = []
  let consume = async (frame: CpuFrameEnvelope & { pixels: Uint8Array }) => { packets.push(frame) }
  const receiver = createCpuFramePortReceiver({ current: () => current,
    consume: frame => consume(frame), release: (binding, sequence) => { releases.push({ bindingToken: binding.bindingToken, sequence }) },
    fail: binding => { failures.push(binding.bindingToken) } })
  const auth = { surfaceToken, bindingToken, cpuChannelId }, p = port(); receiver.attach(auth, p.value)
  const envelope = (sequence: number, timeline = current.timeline, id = cpuChannelId) => ({ ...current, cpuChannelId: id,
    sequence, timeline, width: 1, height: 1, stride: 64, size: 64 })
  return { current, receiver, p, auth, envelope, packets, releases, failures,
    consume: (value: typeof consume) => { consume = value } }
}
for (const pixelsFirst of [false, true]) test(`CPU port joins either channel order (pixels first: ${pixelsFirst})`, () => {
  const f = fixture()
  if (pixelsFirst) f.p.pixel(1); else f.receiver.frame(f.envelope(1))
  assert.equal(f.packets.length, 0)
  if (pixelsFirst) f.receiver.frame(f.envelope(1)); else f.p.pixel(1)
  assert.equal(f.packets.length, 1); assert.equal(f.packets[0].pixels.byteLength, 64)
  assert.deepEqual(f.failures, []); f.receiver.dispose(f.current)
})
test('future pixels and metadata survive a later control-channel flush', () => {
  const f = fixture(); f.p.pixel(1, 2); f.receiver.frame(f.envelope(1, 2))
  assert.equal(f.packets.length, 0)
  f.current.timeline = 2; f.receiver.flush()
  assert.equal(f.packets.length, 1); assert.equal(f.packets[0].timeline, 2)
  f.receiver.dispose(f.current)
})
test('flush drops old input, preserving a still newer timeline', () => {
  const f = fixture(); f.p.pixel(1, 1); f.p.pixel(2, 3); f.receiver.frame(f.envelope(2, 3))
  f.current.timeline = 2; f.receiver.flush(); assert.equal(f.packets.length, 0)
  f.current.timeline = 3; f.receiver.flush(); assert.equal(f.packets.length, 1)
  assert.equal(f.packets[0].sequence, 2); f.receiver.dispose(f.current)
})
test('old envelopes return copy credit and do not wait for pixels', () => {
  const f = fixture(); f.current.timeline = 2; f.p.pixel(1, 1); f.receiver.frame(f.envelope(1, 1))
  assert.equal(f.packets.length, 0); assert.deepEqual(f.releases, [{ bindingToken, sequence: 1 }])
  f.receiver.dispose(f.current)
})
test('main retirement handles pixels arriving after the discard notification', () => {
  const f = fixture(); f.receiver.retire({ ...f.auth, sequence: 1 }); f.p.pixel(1)
  for (const n of [2, 3]) { f.p.pixel(n); f.receiver.frame(f.envelope(n)) }
  assert.deepEqual(f.packets.map(p => p.sequence), [2, 3]); assert.deepEqual(f.failures, [])
  f.receiver.dispose(f.current)
})
for (const envelopeFirst of [true, false]) test(`newer retirement returns earlier unmatched copy credit (envelope first: ${envelopeFirst})`, () => {
  const f = fixture()
  if (envelopeFirst) f.receiver.frame(f.envelope(1))
  // Main discards frame 2 during a seek while frame 1's private pixels lag.
  f.receiver.retire({ ...f.auth, sequence: 2 })
  if (!envelopeFirst) f.receiver.frame(f.envelope(1))
  f.current.timeline = 2; f.receiver.flush()
  f.p.pixel(1, 1)
  assert.deepEqual(f.releases, [{ bindingToken, sequence: 1 }])
  assert.equal(f.packets.length, 0)
  for (const n of [3, 4]) { f.p.pixel(n, 2); f.receiver.frame(f.envelope(n, 2)) }
  assert.deepEqual(f.packets.map(p => p.sequence), [3, 4]); assert.deepEqual(f.failures, [])
  f.receiver.dispose(f.current)
})
test('stale port callbacks and stale binding envelopes cannot reach a replacement display', () => {
  const f = fixture(), late = f.p.value.onmessage!
  f.p.pixel(1); f.receiver.frame(f.envelope(2))
  f.current.bindingToken = replacement
  const next = port(); f.receiver.attach({ ...f.current, cpuChannelId: replacement }, next.value)
  late({ data: { cpuChannelId, sequence: 2, timeline: 1, pixels: new Uint8Array(64) } })
  f.receiver.frame({ ...f.envelope(3), bindingToken })
  next.pixel(4, 1, replacement); f.receiver.frame(f.envelope(4, 1, replacement))
  assert.equal(f.packets.length, 1); assert.equal(f.packets[0].bindingToken, replacement)
  assert.deepEqual(f.failures, []); assert.equal(f.p.closed(), 1); f.receiver.dispose(f.current)
})
test('unauthenticated replacement port is closed without disturbing the active port', () => {
  const f = fixture(), wrong = port(); f.receiver.attach({ ...f.auth, bindingToken: replacement }, wrong.value)
  assert.equal(wrong.closed(), 1); assert.equal(f.p.closed(), 0)
  f.p.pixel(1); f.receiver.frame(f.envelope(1)); assert.equal(f.packets.length, 1)
  f.receiver.dispose(f.current)
})
test('mismatched sizes fail closed and release queued metadata once', () => {
  const f = fixture(); f.receiver.frame(f.envelope(1)); f.p.pixel(1, 1, cpuChannelId, new Uint8Array(32))
  assert.equal(f.packets.length, 0); assert.deepEqual(f.failures, [bindingToken]); assert.equal(f.p.closed(), 1)
  assert.deepEqual(f.releases, [{ bindingToken, sequence: 1 }]); f.receiver.dispose(f.current)
})
test('pixel and envelope timeline mismatch cannot submit mixed frames', () => {
  const f = fixture(); f.receiver.frame(f.envelope(1, 2)); f.p.pixel(1, 1)
  assert.equal(f.packets.length, 0); assert.deepEqual(f.failures, [bindingToken])
})
for (const side of ['pixels', 'envelopes'] as const) test(`${side} waiting queue cannot grow beyond two`, () => {
  const f = fixture()
  for (const n of [1, 2, 3]) if (side === 'pixels') f.p.pixel(n); else f.receiver.frame(f.envelope(n))
  assert.equal(f.packets.length, 0); assert.deepEqual(f.failures, [bindingToken]); assert.equal(f.p.closed(), 1)
})
test('wrong-channel retirement cannot discard active data', () => {
  const f = fixture(); f.p.pixel(1); f.receiver.retire({ ...f.auth, cpuChannelId: replacement, sequence: 1 })
  f.receiver.frame(f.envelope(1)); assert.equal(f.packets.length, 1); f.receiver.dispose(f.current)
})
test('late rejection of an old consumption cannot fail the replacement channel', async () => {
  const f = fixture(); let reject!: (reason: Error) => void
  f.consume(() => new Promise<void>((_done, fail) => { reject = fail }))
  f.receiver.frame(f.envelope(1)); f.p.pixel(1)
  f.current.bindingToken = replacement
  const next = port(); f.receiver.attach({ ...f.current, cpuChannelId: replacement }, next.value)
  reject(new Error('old writer cancelled')); await new Promise(setImmediate)
  assert.deepEqual(f.failures, []); assert.equal(next.closed(), 0); f.receiver.dispose(f.current)
})
test('malformed and duplicate packets cannot be consumed', () => {
  const f = fixture(); f.p.pixel(1); f.receiver.frame(f.envelope(1)); f.p.pixel(1)
  assert.equal(f.packets.length, 1); assert.deepEqual(f.failures, [bindingToken])
})
test('copy-credit cleanup tolerates an already closed port and endpoint', () => {
  const current = { surfaceToken, bindingToken, timeline: 1 }
  const r = createCpuFramePortReceiver({ current: () => current, consume: async () => {}, release() { throw Error('gone') }, fail() { throw Error('gone') } })
  const p = port(); r.attach({ ...current, cpuChannelId }, p.value)
  r.frame({ ...current, cpuChannelId, sequence: 1, width: 1, height: 1, stride: 64, size: 64 })
  p.value.close = () => { throw Error('gone') }
  assert.doesNotThrow(() => r.dispose(current)); assert.doesNotThrow(() => r.dispose(current))
})
test('legacy CPU metadata stays on the existing receiver', () => {
  const f = fixture(); assert.equal(f.receiver.frame({ ...f.envelope(1), cpuChannelId: undefined }), false)
  f.receiver.dispose(f.current)
})


test('a lost credit endpoint during stale-envelope disposal fails inside the channel boundary', () => {
  const current = { surfaceToken, bindingToken, timeline: 2 }; let failures = 0
  const r = createCpuFramePortReceiver({ current: () => current, consume: async () => {}, release() { throw Error('gone') }, fail() { failures++ } })
  const p = port(); r.attach({ ...current, cpuChannelId }, p.value)
  assert.doesNotThrow(() => r.frame({ ...current, timeline: 1, cpuChannelId, sequence: 1, width: 1, height: 1, stride: 64, size: 64 }))
  assert.equal(failures, 1); assert.equal(p.closed(), 1)
})
