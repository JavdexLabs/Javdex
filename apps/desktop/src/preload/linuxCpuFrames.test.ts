import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

const code = transpileModule(readFileSync(new URL('./linuxCpuFrames.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText
const token = '11111111-1111-4111-8111-111111111111'
function fixture(options: { contextFails?: boolean; mainFrame?: boolean } = {}) {
  let nextToken = 0, draws = 0, clears = 0, allocations = 0, drawFails = false
  let displayed: Uint8ClampedArray | null = null
  const ipc = new EventEmitter()
  const messages: Array<{ channel: string; data: Record<string, unknown> }> = []
  const context = {
    createImageData: (width: number, height: number) => { allocations++; return { data: new Uint8ClampedArray(width * height * 4) } },
    putImageData: (value: { data: Uint8ClampedArray }) => { if (drawFails) throw new Error('draw failed'); draws++; displayed = value.data.slice() },
    clearRect: () => { clears++; displayed = null }
  }
  const canvas = { width: 0, height: 0, isConnected: true, dataset: { playbackCpuSurface: token },
    getContext: (kind: string, settings: { alpha: boolean; willReadFrequently: boolean }) => {
      assert.equal(kind, '2d'); assert.equal(settings.alpha, false); assert.equal(settings.willReadFrequently, true)
      if (options.contextFails) throw new Error('Canvas unavailable')
      return context
    } }
  const exports = {} as typeof import('./linuxCpuFrames')
  runInNewContext(code, { exports, Uint8Array, process: { platform: 'linux', isMainFrame: options.mainFrame ?? true },
    crypto: { randomUUID: () => `33333333-3333-4333-8333-${String(++nextToken).padStart(12, '0')}` },
    document: { querySelectorAll: (selector: string) => { assert.equal(selector, 'canvas[data-playback-cpu-surface]'); return [canvas] } },
    require(id: string) {
      assert.equal(id, 'electron')
      return { ipcRenderer: { on: ipc.on.bind(ipc), send: (channel: string, data: Record<string, unknown>) => messages.push({ channel, data }) } }
    } }
  )
  const bind = exports.installLinuxCpuFrameReceiver()
  const binding = () => [...messages].reverse().find(item => item.channel.endsWith('ready'))!.data
  return { bind, messages, canvas, binding, counts: () => ({ draws, clears, allocations }), pixels: () => displayed,
    failDraw: () => { drawFails = true },
    state: (generation = 1, visible = true, current = binding()) => ipc.emit('playback:cpu-frame-state', {}, { ...current, generation, visible }),
    receive: (sequence = 1, extra: Record<string, unknown> = {}, pixels: unknown = new Uint8Array(32 * 18 * 4).fill(123)) => ipc.emit('playback:cpu-frame', {},
      { ...binding(), protocol: 'javdex-cpu-frame-v1', sequence, slot: 0, generation: 1, width: 32, height: 18,
        pixelFormat: 'rgba', stride: 128, size: 2304, producerComplete: true, ...extra }, pixels) }
}

test('CPU-only receiver submits RGBA Canvas2D pixels synchronously before releasing its producer slot', () => {
  const f = fixture(); const cleanup = f.bind(token); f.state(); f.receive()
  assert.equal(f.canvas.width, 32); assert.equal(f.canvas.height, 18)
  assert.equal(f.counts().draws, 1); assert.equal(f.counts().allocations, 1)
  assert.ok(f.pixels()!.every(value => value === 123))
  assert.equal(f.messages.at(-1)!.channel, 'playback:cpu-frame-release')
  assert.equal(f.messages.at(-1)!.data.outcome, 'drawn')
  const prior = f.pixels(); f.state()
  assert.equal(f.pixels(), prior, 'pause leaves the canvas pixels intact without retaining a producer frame')
  cleanup(); cleanup(); assert.equal(f.pixels(), null)
  assert.equal(f.messages.at(-1)!.channel, 'playback:cpu-frame-removed')
})
test('duplicate, stale-generation, hidden and disconnected frames drop without pixel allocation', () => {
  const f = fixture(); f.bind(token); f.state(); f.receive()
  f.receive(); f.receive(2, { generation: 2 })
  f.state(2); assert.equal(f.pixels(), null)
  f.receive(2); f.receive(3, { generation: 2 })
  f.state(2, false); f.receive(4, { generation: 2 })
  f.state(2, true); f.canvas.isConnected = false; f.receive(5, { generation: 2 })
  assert.equal(f.counts().draws, 2); assert.equal(f.counts().allocations, 1, 'one ImageData is reused at the same resolution')
  const releases = f.messages.filter(message => message.channel.endsWith('release'))
  assert.equal(releases.length, 7)
  assert.equal(releases.filter(message => message.data.outcome === 'drawn').length, 2)
})
test('rebind and close release late frames against their original binding instead of drawing stale pixels', () => {
  const f = fixture(); const firstCleanup = f.bind(token); f.state(); const first = f.binding()
  f.receive(); f.bind(token); f.state(); firstCleanup()
  f.receive(2, first)
  assert.equal(f.messages.at(-1)!.data.bindingToken, first.bindingToken)
  assert.equal(f.messages.at(-1)!.data.outcome, 'dropped')
  f.receive(3); assert.equal(f.counts().draws, 2)
  const cleanup = f.bind(token); f.state(); const last = f.binding(); cleanup(); f.receive(4, last)
  assert.equal(f.counts().draws, 2)
  assert.equal(f.messages.at(-1)!.data.outcome, 'dropped')
})
test('drawing failures and invalid binary payloads notify failure and release dropped frames', () => {
  for (const kind of ['draw', 'short', 'array', 'array-buffer']) {
    const f = fixture(); f.bind(token); f.state()
    if (kind === 'draw') f.failDraw()
    f.receive(1, {}, kind === 'short' ? new Uint8Array(1) : kind === 'array' ? Array(2304).fill(0)
      : kind === 'array-buffer' ? new ArrayBuffer(2304) : new Uint8Array(2304))
    assert.equal(f.counts().draws, 0)
    assert.equal(f.messages.at(-2)!.channel, 'playback:cpu-frame-failed')
    assert.equal(f.messages.at(-1)!.data.outcome, 'dropped')
  }
})
test('oversized or unsupported frame metadata never allocates an image or submits canvas pixels', () => {
  for (const invalid of [{ width: 1281 }, { height: 721 }, { stride: 129 }, { size: 2305 }, { slot: 3 },
    { sequence: 0 }, { generation: 0 }, { generation: 0x100000000 }, { pixelFormat: 'bgra' }, { producerComplete: false }]) {
    const f = fixture(); f.bind(token); f.state(); f.receive(1, invalid)
    assert.equal(f.counts().allocations, 0)
    assert.equal(f.messages.at(-1)!.channel, 'playback:cpu-frame-failed')
  }
})
test('untrusted canvas selectors are rejected, and unavailable context fails closed', () => {
  const f = fixture(); f.bind('[data-secret]')(); assert.deepEqual(f.messages, [])
  for (const options of [{ contextFails: true }, { mainFrame: false }]) {
    const disabled = fixture(options); assert.doesNotThrow(() => disabled.bind(token)())
    assert.equal(disabled.messages.at(-1)!.channel, 'playback:cpu-frame-failed')
  }
})

test('one bounded ImageData is reused until resolution changes and disposed on rebind', () => {
  const f = fixture(); f.bind(token); f.state()
  for (let sequence = 1; sequence <= 30; sequence++) f.receive(sequence)
  assert.equal(f.counts().draws, 30); assert.equal(f.counts().allocations, 1)
  f.receive(31, { width: 16, height: 36, stride: 64 })
  assert.equal(f.counts().allocations, 2, 'same byte size with a different shape reallocates')
  f.receive(32, { width: 16, height: 36, stride: 64 })
  assert.equal(f.counts().allocations, 2)
  f.bind(token); f.state(); f.receive(33)
  assert.equal(f.counts().allocations, 3, 'a replacement binding owns its own image')
})
