import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

const code = transpileModule(readFileSync(new URL('./linuxSharedTexture.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText
const token = '11111111-1111-4111-8111-111111111111'
test('pixel diagnostic distinguishes opaque black from colored and transparent samples with row padding', () => {
  const exports = {} as typeof import('./linuxSharedTexture')
  runInNewContext(code, { exports, require: () => ({}) })
  const data = new Uint8Array([
    0, 0, 0, 255, 255, 0, 0, 255, 99, 99, 99, 99,
    0, 0, 0, 0, 0, 32, 0, 255
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(exports.summarizePixels(data, 2, 2, 12))),
    { samples: 4, nonblack: 2, maximum: 255, opaque: 3 })
})
function fixture(options: { registerFails?: boolean; contextFails?: boolean } = {}) {
  let nextToken = 0, draws = 0, closes = 0, releases = 0, clears = 0, drawFails = false
  const listeners = new Map<string, (_event: unknown, value: unknown) => void>()
  let cpuReceiver!: (_event: unknown, value: unknown) => void
  let cpuPixels: Uint8ClampedArray = new Uint8ClampedArray()
  let receiver!: (data: unknown, metadata: unknown) => Promise<void>
  const messages: Array<{ channel: string; data: { surfaceToken: string; bindingToken: string } }> = []
  const canvas = { width: 0, height: 0, isConnected: true, dataset: { playbackSurface: token },
    getContext: () => {
      if (options.contextFails) throw new Error('Canvas context unavailable')
      return { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: (image: { data: Uint8ClampedArray }) => { cpuPixels = image.data; draws++ }, drawImage: () => { if (drawFails) throw new Error('draw failed'); draws++ }, clearRect: () => { clears++ } }
    } }
  const exports = {} as typeof import('./linuxSharedTexture')
  runInNewContext(code, { exports, Uint8Array, performance, setTimeout, clearTimeout, process: { platform: 'linux', isMainFrame: true },
    crypto: { randomUUID: () => `33333333-3333-4333-8333-${String(++nextToken).padStart(12, '0')}` },
    document: { querySelectorAll: () => [canvas] },
    require(id: string) {
      assert.equal(id, 'electron')
      return { ipcRenderer: { on: (channel: string, callback: typeof cpuReceiver) => { listeners.set(channel, callback); if (channel === 'playback:cpu-frame') cpuReceiver = callback }, send: (channel: string, data: typeof messages[number]['data']) => {
          if (channel === 'playback:frame-clock') { listeners.get(channel)!(null, { ...data, mainTime: performance.now() }); return }
          messages.push({ channel, data })
        } },
        sharedTexture: { setSharedTextureReceiver: (callback: typeof receiver) => { if (options.registerFails) throw new Error('Receiver unavailable'); receiver = callback } } }
    } }
  )
  const bind = exports.installLinuxSharedTextureReceiver()
  const packet = { importedSharedTexture: { getVideoFrame: () => ({ displayWidth: 320, displayHeight: 180, close: () => { closes++ } }),
    release: () => { releases++ } } }
  return { bind, messages, listeners, canvas, cpu: (value: unknown) => cpuReceiver(null, value), cpuPixels: () => cpuPixels, counts: () => ({ draws, closes, releases, clears }),
    failDraw: () => { drawFails = true },
    receive: (sequence: number, binding = [...messages].reverse().find(item => item.channel.endsWith('ready'))!.data, extra = {}) => receiver(packet, { ...binding, sequence, ...extra }) }
}
test('draws on the mounted canvas and releases VideoFrame and imported texture in finally', async () => {
  const f = fixture(); const unbind = f.bind(token)
  await f.receive(1)
  assert.equal(f.canvas.width, 320); assert.equal(f.canvas.height, 180)
  assert.deepEqual(f.counts(), { draws: 1, closes: 1, releases: 1, clears: 0 })
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-submitted')
  unbind(); unbind()
  assert.equal(f.counts().clears, 1)
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-removed')
})
test('stale sessions, duplicate frames, detached canvases and old mount tokens cannot draw', async () => {
  const f = fixture(); const firstCleanup = f.bind(token)
  const old = f.messages.at(-1)!.data
  await f.receive(1)
  await f.receive(1)
  await f.receive(2, { ...old, surfaceToken: 'old-session' })
  f.bind(token); firstCleanup()
  await f.receive(2, old)
  await f.receive(2)
  f.canvas.isConnected = false
  await f.receive(3)
  assert.deepEqual(f.counts(), { draws: 2, closes: 2, releases: 6, clears: 0 })
})
test('drawing failures always close the frame and imported reference and notify main', async () => {
  const f = fixture(); f.bind(token); f.failDraw()
  await f.receive(1)
  assert.deepEqual(f.counts(), { draws: 0, closes: 1, releases: 1, clears: 0 })
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-failed')
})
test('unbound frames release without attempting to create a VideoFrame', async () => {
  const f = fixture(); const cleanup = f.bind(token); const binding = f.messages.at(-1)!.data
  cleanup(); await f.receive(1, binding)
  assert.deepEqual(f.counts(), { draws: 0, closes: 0, releases: 1, clears: 1 })
})
test('invalid tokens cannot select arbitrary DOM elements or send registration IPC', () => {
  const f = fixture(); f.bind('[data-secret]')()
  assert.deepEqual(f.messages, [])
})

for (const options of [{ registerFails: true }, { contextFails: true }]) test(`unsupported shared-texture setup fails closed without breaking the preload (${JSON.stringify(options)})`, () => {
  const f = fixture(options)
  assert.doesNotThrow(() => f.bind(token)())
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-failed')
  assert.deepEqual(f.counts(), { draws: 0, closes: 0, releases: 0, clears: 0 })
})

test('CPU frames strip row padding, acknowledge only successful drawing and reject stale/oversized input', () => {
  const f = fixture(); f.bind(token)
  const binding = f.messages.at(-1)!.data
  const pixels = new Uint8Array(128); pixels.set([255, 0, 0, 255]); pixels.set([0, 255, 0, 255], 64)
  const frame = { ...binding, sequence: 1, width: 1, height: 2, stride: 64, size: 128, pixels }
  f.cpu(frame)
  assert.deepEqual([...f.cpuPixels()], [255, 0, 0, 255, 0, 255, 0, 255])
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-submitted')
  f.cpu(frame); assert.equal(f.counts().draws, 1)
  f.cpu({ ...frame, sequence: 2, width: 8193 })
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-failed')
})

test('CPU canvas remains usable when shared-texture receiver registration is unavailable', () => {
  const f = fixture({ registerFails: true }), cpuToken = 'cpu:' + token
  f.canvas.dataset.playbackSurface = cpuToken
  f.bind(cpuToken)
  const binding = f.messages.at(-1)!.data
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-ready')
  f.cpu({ ...binding, sequence: 1, width: 1, height: 1, stride: 64, size: 64, pixels: new Uint8Array(64) })
  assert.equal(f.counts().draws, 1)
})

test('scheduled GPU frames wait for target time and receipt reports submission, not presentation', async () => {
  const f = fixture(); f.bind(token)
  const due = performance.now() + 35
  const drawing = f.receive(1, undefined, { targetTime: due })
  assert.equal(f.counts().draws, 0)
  await drawing
  assert.ok(performance.now() >= due - 1)
  assert.equal(f.counts().draws, 1)
  assert.equal(f.counts().releases, 1)
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-submitted')
})
test('unbind or timeline flush cancels delayed frames and releases exactly once', async () => {
  for (const flush of [false, true]) {
    const f = fixture(); const unbind = f.bind(token)
    const binding = f.messages.find(m => m.channel.endsWith('ready'))!.data
    const drawing = f.receive(1, binding, { targetTime: performance.now() + 60 })
    if (flush) f.listeners.get('playback:frame-flush')!(null, { ...binding, timeline: 1 })
    else unbind()
    await drawing
    assert.equal(f.counts().draws, 0)
    assert.equal(f.counts().closes, 1)
    assert.equal(f.counts().releases, 1)
    if (flush) {
      await f.receive(2, binding, { timeline: 0 })
      await f.receive(3, binding, { timeline: 1 })
      assert.equal(f.counts().draws, 1)
    }
  }
})
test('new immediate frame cannot be overwritten by an older scheduled frame', async () => {
  const f = fixture(); f.bind(token)
  const delayed = f.receive(1, undefined, { targetTime: performance.now() + 25 })
  await f.receive(2)
  await delayed
  assert.equal(f.counts().draws, 1)
  assert.equal(f.counts().releases, 2)
})
