import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { channel } from 'node:diagnostics_channel'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { graphicsPlaybackFailure } from './playbackGraphicsFailure'
import type { HostRequest, HostResponse } from './playbackHostProtocol'

const code = transpileModule(readFileSync(new URL('./isolatedPlaybackHost.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
}).outputText
function fixture(mode: 'gpu' | 'cpu' = 'gpu') {
  const messages: HostRequest[] = [], acquired: Buffer[] = [], released: Buffer[] = []
  const intervals: Array<() => void> = [], timeouts: Array<() => void> = []
  let time = 0, killed = false
  const child = Object.assign(new EventEmitter(), { pid: 77, stderr: null,
    postMessage(value: HostRequest) { messages.push(value) }, kill() { killed = true; child.emit('exit', 1) } })
  const exports = {} as typeof import('./isolatedPlaybackHost')
  runInNewContext(code, { exports, Buffer, performance: { now: () => time }, process: { platform: 'win32', env: {} },
    setInterval: (callback: () => void) => { intervals.push(callback); return { unref() {} } }, clearInterval() {},
    setTimeout: (callback: () => void) => { timeouts.push(callback); return { unref() {} } }, console,
    clearTimeout() {}, require(name: string) {
      if (name === 'electron') return { app: { getAppPath: () => '/fixture' }, utilityProcess: { fork: () => child } }
      if (name === 'node:path') return path
      if (name === 'node:crypto') return { randomUUID: () => '11111111-1111-4111-8111-111111111111' }
      if (name === 'node:diagnostics_channel') return { channel }
      if (name === './playbackGraphicsFailure') return { graphicsPlaybackFailure }
      if (name === 'node:module') return { createRequire: () => () => ({ acquire() { const resource = Buffer.alloc(8, acquired.length + 1); acquired.push(resource); return resource },
        release(resource: Buffer) { released.push(resource) } }) }
      throw Error(name)
    } })
  const host = exports.createIsolatedPlaybackHost('/fixture/playback.node', mode)
  host.create({ width: 640, height: 360, scale: 1 })
  const emit = (message: HostResponse): void => { child.emit('message', message) }
  const frame = (sequence: number, resourceId = sequence, slot = (sequence - 1) % 3): void => emit({ type: 'frame', frame: { sequence, resourceId, slot, width: 640, height: 360, ntHandle: Buffer.alloc(8) } })
  return { host, emit, frame, messages, acquired, released, intervals, timeouts,
    advance: (ms: number) => { time += ms; for (const callback of intervals) callback() }, killed: () => killed }
}
test('isolated host preserves command order until ready and keeps imported resources until explicit final release', t => {
  const f = fixture(); t.after(() => f.host.destroy())
  f.host.command(['loadfile', '/authorized media.mkv', 'replace'])
  assert.equal(f.messages.length, 0)
  f.emit({ type: 'ready' })
  assert.deepEqual(f.messages.map(m => m.type), ['create', 'command'])
  f.frame(1); assert.equal(f.host.nextFrame()?.ntHandle, f.acquired[0])
  f.host.destroy()
  assert.equal(f.released.length, 0, 'producer shutdown cannot invalidate a consumer-held texture')
  f.host.releaseFrame(1); f.host.releaseFrame(1)
  assert.equal(f.released.length, 1)
})
test('isolated host releases queued frames on timeline changes without releasing consumer-held frames', t => {
  const f = fixture(); t.after(() => { f.host.destroy(); f.host.releaseFrame(1) })
  f.emit({ type: 'ready' }); f.frame(1); f.host.nextFrame(); f.frame(2)
  f.host.resetTiming(2)
  assert.equal(f.released.length, 0, 'the allocation remains cached until its producer retires it')
  assert.ok(f.messages.some(m => m.type === 'release' && m.sequence === 2))
  assert.equal(f.host.nextFrame(), undefined)
})
test('duplicate host frame IDs fail without overwriting or leaking an imported resource', t => {
  const f = fixture(); t.after(() => { f.host.destroy(); f.host.releaseFrame(1) })
  f.emit({ type: 'ready' }); f.frame(1); f.host.nextFrame(); f.frame(1)
  assert.equal(f.acquired.length, 1)
  assert.throws(() => f.host.state(), (error: unknown) => (error as { playbackFailureCode: string }).playbackFailureCode === 'FRAME_CHANNEL_FAILED')
  assert.equal(f.released.length, 0)
})
test('resource imports remain stable across frames and retire only when a slot receives a new allocation', t => {
  const f = fixture(); t.after(() => { f.host.destroy(); f.host.releaseFrame(3) })
  f.emit({ type: 'ready' }); f.frame(1, 41, 0)
  const first = f.host.nextFrame()!.ntHandle; f.host.releaseFrame(1)
  f.frame(2, 41, 0)
  assert.equal(f.host.nextFrame()!.ntHandle, first)
  assert.equal(f.acquired.length, 1); assert.equal(f.released.length, 0)
  f.host.releaseFrame(2); f.frame(3, 42, 0); f.host.nextFrame()
  assert.equal(f.acquired.length, 2); assert.deepEqual(f.released, [first])
})
test('a producer cannot reuse an allocation that is still held by its consumer', t => {
  const f = fixture(); t.after(() => { f.host.destroy(); f.host.releaseFrame(1) })
  f.emit({ type: 'ready' }); f.frame(1, 41, 0); f.host.nextFrame(); f.frame(2, 41, 0)
  assert.throws(() => f.host.inspect(), (error: unknown) => (error as { playbackFailureCode: string }).playbackFailureCode === 'FRAME_CHANNEL_FAILED')
  assert.equal(f.released.length, 0)
})
test('host heartbeat failure is bounded and leaves the main process responsive', t => {
  const f = fixture(); t.after(() => f.host.destroy())
  f.emit({ type: 'ready' }); f.advance(5001)
  assert.throws(() => f.host.inspect(), (error: unknown) => (error as { playbackFailureCode: string }).playbackFailureCode === 'HELPER_HEARTBEAT_TIMEOUT')
  for (const callback of f.timeouts) callback()
  assert.equal(f.killed(), true)
})
test('CPU host returns copy credits only on consumer acknowledgement', t => {
  const f = fixture('cpu'); t.after(() => f.host.destroy())
  f.emit({ type: 'ready' })
  f.emit({ type: 'frame', frame: { sequence: 1, width: 1, height: 1, stride: 64, size: 64, pixels: new Uint8Array(64) } })
  assert.ok(Buffer.isBuffer(f.host.nextFrame()?.pixels))
  assert.equal(f.messages.some(m => m.type === 'release'), false)
  f.host.releaseFrame(1)
  assert.equal(f.messages.filter(m => m.type === 'release').length, 1)
  assert.equal(f.acquired.length, 0)
})
test('host request queues are bounded before startup and while the native thread is stalled', t => {
  const f = fixture(); t.after(() => f.host.destroy())
  for (let n = 0; n < 63; n++) f.host.setVisible(true)
  assert.throws(() => f.host.setVisible(true), /未响应/)
  f.emit({ type: 'ready' }); assert.equal(f.messages.length, 64)
  assert.throws(() => f.host.setVisible(true), (error: unknown) => (error as { playbackFailureCode: string }).playbackFailureCode === 'HELPER_HEARTBEAT_TIMEOUT')
})
