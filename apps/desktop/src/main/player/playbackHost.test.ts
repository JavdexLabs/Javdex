import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import type { HostRequest, HostResponse } from './playbackHostProtocol'
import { createCpuFramePortReceiver, type CpuPixelsPort } from '../../preload/cpuFramePort'

// Normalize only ESM-local bindings so the CJS VM import loader is not shadowed.
const source = readFileSync(new URL('./playbackHost.ts', import.meta.url), 'utf8')
  .replace('import.meta.url', "'file:///fixture/playbackHost.js'")
  .replace('const require = createRequire', 'const loadRuntime = createRequire')
  .replace('require(runtime)', 'loadRuntime(runtime)').replace('require(interopFile)', 'loadRuntime(interopFile)')
const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
const cpuChannelId = '11111111-1111-4111-8111-111111111111'
function fixture() {
  const sent: HostResponse[] = [], pixels: unknown[] = [], ticks: Array<() => void> = [], budgets: boolean[] = []
  const parent = Object.assign(new EventEmitter(), { postMessage: (value: HostResponse) => sent.push(value) })
  const port = Object.assign(new EventEmitter(), { start() {}, close() { port.emit('close') }, postMessage(value: unknown) { pixels.push(value) } })
  let sequence = 0, timeline = 1, destroyed = 0, exitCode = 0
  const native = { create() {}, setVisible() {}, setBounds() {}, command() {}, generatedSubtitles() {}, resetTiming(value: number) { timeline = value }, setRenderBudget() {},
    nextFrame(writable: boolean) { budgets.push(writable); return writable ? { sequence: ++sequence, timeline, width: 1, height: 1, stride: 64, size: 64, pixels: Buffer.alloc(64) } : undefined },
    state: () => ({ alive: true }), destroy() { destroyed++ } }
  runInNewContext(code, { exports: {}, Buffer, process: { argv: ['node', 'entry', '/fixture/runtime.node', 'cpu', '', ''], platform: 'darwin', parentPort: parent, env: {}, set exitCode(n: number) { exitCode = n }, exit(n: number) { exitCode = n } },
    setInterval(callback: () => void) { ticks.push(callback); return { unref() {} } }, console: { error() {} },
    require(id: string) { assert.equal(id, 'node:module'); return { createRequire: () => () => ({ software: native }) } }
  })
  return { sent, pixels, budgets, port, native, ticks, exit: () => exitCode, destroyed: () => destroyed,
    request(data: HostRequest, ports: unknown[] = []) { parent.emit('message', { data, ports }) } }
}
test('Mac CPU utility preserves two-copy credit across the private pixels and metadata channels', () => {
  const f = fixture(); f.request({ type: 'create', bounds: { width: 1, height: 1 } })
  assert.equal(f.budgets.at(-1), false); assert.equal(f.pixels.length, 0)
  f.request({ type: 'cpu-frame-port', cpuChannelId }, [f.port])
  f.ticks[0](); f.ticks[0](); f.ticks[0]()
  assert.equal(f.pixels.length, 2); assert.equal(f.budgets.at(-1), false)
  const frames = f.sent.filter((x): x is Extract<HostResponse, { type: 'frame' }> => x.type === 'frame')
  assert.equal(frames.length, 2); assert.equal(frames[0].frame.pixels, undefined); assert.equal(frames[0].frame.cpuChannelId, cpuChannelId)
  f.request({ type: 'release', sequence: 1 }); assert.equal(f.pixels.length, 4)
  const retired = f.pixels[2] as { type: string; cpuChannelId: string; sequence: number }
  assert.equal(retired.type, 'retired'); assert.equal(retired.cpuChannelId, cpuChannelId); assert.equal(retired.sequence, 1)
  assert.equal((f.pixels[3] as { sequence: number }).sequence, 3)
  f.request({ type: 'release', sequence: 1 }); assert.equal(f.pixels.length, 4, 'duplicate release cannot retire twice')
  f.request({ type: 'destroy' }); assert.equal(f.destroyed(), 1); assert.equal(f.exit(), 0)
})
test('normal CPU detach stops production; unexpected port close is reported to the owner', () => {
  const f = fixture(); f.request({ type: 'cpu-frame-port', cpuChannelId }, [f.port])
  f.request({ type: 'create', bounds: { width: 1, height: 1 } })
  f.port.close(); assert.ok(f.sent.some(x => x.type === 'cpu-frame-port-closed' && x.cpuChannelId === cpuChannelId))
  f.ticks[0](); assert.equal(f.budgets.at(-1), false)
  const g = fixture(); g.request({ type: 'cpu-frame-port', cpuChannelId }, [g.port])
  g.request({ type: 'cpu-frame-detached', cpuChannelId })
  assert.equal(g.sent.some(x => x.type === 'cpu-frame-port-closed'), false)
})
test('CPU utility rejects malformed private port attachment without opening the native engine', () => {
  const f = fixture(); f.request({ type: 'cpu-frame-port', cpuChannelId })
  assert.equal(f.sent.at(-1)?.type, 'failed'); assert.equal(f.exit(), 1); assert.equal(f.pixels.length, 0)
})
test('seek retirement stays ahead of replacement pixels when the main metadata channel lags', () => {
  const f = fixture(), binding = { surfaceToken: 'cpu:11111111-1111-4111-8111-111111111111', bindingToken: '22222222-2222-4222-8222-222222222222' }
  const current = { ...binding, timeline: 1 }, received: number[] = [], failures: string[] = []
  const receiver = createCpuFramePortReceiver({ current: () => current,
    consume: async frame => { received.push(frame.sequence) }, release() {}, fail: value => { failures.push(value.bindingToken) } })
  const port: CpuPixelsPort = { onmessage: null, onmessageerror: null, start() {}, close() {} }
  receiver.attach({ ...binding, cpuChannelId }, port)
  f.request({ type: 'create', bounds: { width: 1, height: 1 } })
  f.request({ type: 'cpu-frame-port', cpuChannelId }, [f.port]); f.ticks[0](); f.ticks[0]()
  f.request({ type: 'timing', timeline: 2 })
  // Main discards its queued old frames and returns their producer credits.
  f.request({ type: 'release', sequence: 1 }); f.request({ type: 'release', sequence: 2 })
  // Deliver the private channel in order while all main metadata/flushes lag.
  for (const data of f.pixels) port.onmessage?.({ data })
  assert.deepEqual(failures, [])
  for (const value of f.sent) if (value.type === 'frame' && value.frame.sequence >= 3)
    receiver.frame({ ...binding, ...value.frame })
  current.timeline = 2; receiver.flush()
  assert.deepEqual(received, [3, 4]); assert.deepEqual(failures, [])
  receiver.dispose(current); f.request({ type: 'destroy' })
})
