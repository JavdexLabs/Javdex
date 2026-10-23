import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

const code = transpileModule(readFileSync(new URL('./sharedTextureReceiver.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText
const token = '11111111-1111-4111-8111-111111111111'
test('pixel diagnostic distinguishes opaque black from colored and transparent samples with row padding', () => {
  const exports = {} as typeof import('./sharedTextureReceiver')
  runInNewContext(code, { exports, require: () => ({}) })
  const data = new Uint8Array([
    0, 0, 0, 255, 255, 0, 0, 255, 99, 99, 99, 99,
    0, 0, 0, 0, 0, 32, 0, 255
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(exports.summarizePixels(data, 2, 2, 12))),
    { samples: 4, nonblack: 2, maximum: 255, opaque: 3 })
})
function fixture(options: { platform?: 'linux' | 'darwin'; registerFails?: boolean; contextFails?: boolean; probePixels?: 'valid' | 'black' | 'throw'; clockShift?: number; copyWait?: Promise<void> } = {}) {
  let nextToken = 0, draws = 0, closes = 0, releases = 0, clears = 0, drawFails = false
  let gpuReleased: (() => void) | undefined
  let compositeOperation = 'source-over'
  const listeners = new Map<string, (_event: unknown, value: unknown) => void>()
  let cpuReceiver!: (_event: unknown, value: unknown) => void
  let cpuPixels: Uint8ClampedArray = new Uint8ClampedArray()
  let receiver!: (data: unknown, metadata: unknown) => Promise<void>
  const messages: Array<{ channel: string; data: { surfaceToken: string; bindingToken: string; sequence?: number } }> = []
  const cpuReleases = new Map<string, () => void>()
  const cpuKey = (value: { bindingToken: string; sequence?: number }): string => `${value.bindingToken}:${value.sequence}`
  const canvas = { width: 0, height: 0, isConnected: true, dataset: { playbackSurface: token },
    getContext: () => {
      if (options.contextFails) throw new Error('Canvas context unavailable')
      return { set globalCompositeOperation(value: string) { compositeOperation = value }, getImageData: () => { if (options.probePixels === 'throw') throw Error('readback'); const data = new Uint8ClampedArray(640 * 360 * 4); if (options.probePixels === 'valid') for (let i = 0; i < data.length; i += 4) data.set([64, 191, 128, 255], i); return { data } }, createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: (image: { data: Uint8ClampedArray }) => { cpuPixels = image.data; draws++ }, drawImage: () => { if (drawFails) throw new Error('draw failed'); draws++ }, clearRect: () => { clears++ } }
    } }
  const exports = {} as typeof import('./sharedTextureReceiver')
  runInNewContext(code, { exports, Uint8Array, performance, setTimeout, clearTimeout, process: { platform: options.platform ?? 'linux', isMainFrame: true },
    crypto: { randomUUID: () => `33333333-3333-4333-8333-${String(++nextToken).padStart(12, '0')}` },
    document: { querySelectorAll: () => [canvas] },
    require(id: string) {
      assert.equal(id, 'electron')
      return { ipcRenderer: { on: (channel: string, callback: typeof cpuReceiver) => { listeners.set(channel, callback); if (channel === 'playback:cpu-frame') cpuReceiver = callback }, send: (channel: string, data: typeof messages[number]['data']) => {
          if (channel === 'playback:frame-clock') { listeners.get(channel)!(null, { ...data, mainTime: performance.now() - (options.clockShift ?? 0) }); return }
          messages.push({ channel, data })
          if (channel === 'playback:cpu-frame-released') { cpuReleases.get(cpuKey(data))?.(); cpuReleases.delete(cpuKey(data)) }
        } },
        sharedTexture: { subtle: { finishTransferSharedTexture: () => ({
          getVideoFrame: packet.importedSharedTexture.getVideoFrame,
          release: (callback: () => void) => { releases++; gpuReleased = callback }
        }) }, setSharedTextureReceiver: (callback: typeof receiver) => { if (options.registerFails) throw new Error('Receiver unavailable'); receiver = callback } } }
    } }
  )
  const bind = exports.installSharedTextureReceiver()
  const packet = { importedSharedTexture: { getVideoFrame: () => ({ displayWidth: options.probePixels ? 640 : 320, displayHeight: options.probePixels ? 360 : 180, close: () => { closes++ },
    allocationSize: () => 640 * 360 * 4, copyTo: async () => { await options.copyWait; return [{ offset: 0, stride: 640 * 4 }] } }),
    release: () => { releases++ } } }
  return { bind, messages, listeners, canvas, composite: () => compositeOperation, gpuRelease: () => gpuReleased?.(), cpu: (value: unknown) => {
    const key = cpuKey(value as { bindingToken: string; sequence: number })
    const done = new Promise<void>(resolve => {
      if (messages.some(m => m.channel === 'playback:cpu-frame-released' && cpuKey(m.data) === key)) resolve()
      else cpuReleases.set(key, resolve)
    })
    cpuReceiver(null, value)
    return done
  }, cpuPixels: () => cpuPixels, counts: () => ({ draws, closes, releases, clears }),
    failDraw: () => { drawFails = true },
    receive: (sequence: number, binding = [...messages].reverse().find(item => item.channel.endsWith('ready'))!.data, extra = {}) => receiver(packet, { ...binding, sequence, ...extra }) }
}
test('draws on the mounted canvas and releases VideoFrame and imported texture in finally', async () => {
  const f = fixture(); const unbind = f.bind(token)
  await f.receive(1)
  assert.equal(f.canvas.width, 320); assert.equal(f.canvas.height, 180)
  assert.equal(f.composite(), 'copy', 'each complete video frame replaces the prior Canvas content')
  assert.deepEqual(f.counts(), { draws: 1, closes: 1, releases: 1, clears: 0 })
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-submitted')
  unbind(); unbind()
  assert.equal(f.counts().clears, 1)
  assert.equal(f.canvas.width, 0, 'unbind discards the Canvas backing store, not just its visible pixels')
  assert.equal(f.canvas.height, 0)
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-removed')
})
test('macOS subtle transfer ACK waits for the consumer GPU release callback, not drawImage', async () => {
  const f = fixture({ platform: 'darwin' }), unbind = f.bind(token)
  const binding = f.messages.find(m => m.channel.endsWith('ready'))!.data
  f.listeners.get('playback:mac-texture-transfer')!(null, { ...binding, sequence: 1, transfer: { transfer: 'opaque' } })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(f.counts().draws, 1)
  assert.equal(f.messages.filter(m => m.channel === 'playback:mac-texture-released').length, 0)
  f.gpuRelease()
  assert.equal(f.messages.filter(m => m.channel === 'playback:mac-texture-released').length, 1)
  unbind()
})
test('macOS uses the same Canvas submission and reference-release interface', async () => {
  const f = fixture({ platform: 'darwin' }); const stop = f.bind(token)
  await f.receive(1)
  assert.deepEqual(f.counts(), { draws: 1, closes: 1, releases: 1, clears: 0 })
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-submitted')
  stop()
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

test('CPU frames strip row padding, distinguish submission from release and reject stale/oversized input', () => {
  const f = fixture(); f.bind(token)
  const binding = f.messages.at(-1)!.data
  const pixels = new Uint8Array(128); pixels.set([255, 0, 0, 255]); pixels.set([0, 255, 0, 255], 64)
  const frame = { ...binding, sequence: 1, width: 1, height: 2, stride: 64, size: 128, pixels }
  f.cpu(frame)
  assert.deepEqual([...f.cpuPixels()], [255, 0, 0, 255, 0, 255, 0, 255])
  assert.equal(f.messages.at(-2)?.channel, 'playback:shared-texture-submitted')
  assert.equal(f.messages.at(-1)?.channel, 'playback:cpu-frame-released')
  f.cpu(frame); assert.equal(f.counts().draws, 1)
  f.cpu({ ...frame, sequence: 2, width: 8193 })
  assert.equal(f.messages.at(-2)?.channel, 'playback:shared-texture-failed')
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
test('CPU frame waits for its calibrated target instead of displaying on IPC delivery', async () => {
  const f = fixture(), cpuToken = 'cpu:' + token
  f.canvas.dataset.playbackSurface = cpuToken; f.bind(cpuToken)
  const binding = f.messages.find(m => m.channel.endsWith('ready'))!.data
  const due = performance.now() + 35
  const drawing = f.cpu({ ...binding, sequence: 1, timeline: 0, targetTime: due,
    width: 1, height: 1, stride: 64, size: 64, pixels: new Uint8Array(64) })
  assert.equal(f.counts().draws, 0)
  await drawing
  assert.ok(performance.now() >= due - 1)
  assert.equal(f.counts().draws, 1)
})
test('CPU and GPU reject unbounded future targets and release without drawing', async () => {
  for (const cpu of [false, true]) {
    const f = fixture(), surfaceToken = (cpu ? 'cpu:' : '') + token
    f.canvas.dataset.playbackSurface = surfaceToken; f.bind(surfaceToken)
    const binding = f.messages.find(m => m.channel.endsWith('ready'))!.data
    const timing = { targetTime: performance.now() + 200, timeline: 0 }
    if (cpu) await f.cpu({ ...binding, ...timing, sequence: 1,
      width: 1, height: 1, stride: 64, size: 64, pixels: new Uint8Array(64) })
    else await f.receive(1, binding, timing)
    assert.equal(f.counts().draws, 0)
    assert.ok(f.messages.some(m => m.channel === 'playback:shared-texture-failed'))
    assert.equal(cpu ? f.messages.filter(m => m.channel === 'playback:cpu-frame-released').length : f.counts().releases, 1)
  }
})
test('CPU timeline flush discards scheduled work but releases copied frames without submission', async () => {
  const f = fixture(), cpuToken = 'cpu:' + token
  f.canvas.dataset.playbackSurface = cpuToken; f.bind(cpuToken)
  const binding = f.messages.find(m => m.channel.endsWith('ready'))!.data
  const frame = { ...binding, sequence: 1, timeline: 0, targetTime: performance.now() + 60,
    width: 1, height: 1, stride: 64, size: 64, pixels: new Uint8Array(64) }
  const pending = f.cpu(frame)
  f.listeners.get('playback:frame-flush')!(null, { ...binding, timeline: 1 })
  await pending
  assert.equal(f.counts().draws, 0)
  assert.equal(f.messages.at(-1)?.channel, 'playback:cpu-frame-released')
  assert.equal(f.messages.filter(m => m.channel === 'playback:shared-texture-submitted').length, 0)
  await f.cpu({ ...frame, sequence: 2, targetTime: 0, timeline: 1 })
  assert.equal(f.counts().draws, 1)
})
for (const fps of [24, 30, 60]) test(`CPU ${fps}fps targets map a different monotonic epoch and never add delay to overdue frames`, async () => {
  const f = fixture({ clockShift: -5000 }), cpuToken = 'cpu:' + token
  f.canvas.dataset.playbackSurface = cpuToken; f.bind(cpuToken)
  const binding = f.messages.find(m => m.channel.endsWith('ready'))!.data
  const frame = { ...binding, sequence: 1, timeline: 0, width: 1, height: 1, stride: 64, size: 64, pixels: new Uint8Array(64) }
  const due = performance.now() + 1000 / fps
  await f.cpu({ ...frame, targetTime: due + 5000 })
  assert.ok(performance.now() >= due - 1)
  assert.equal(f.counts().draws, 1)
  await f.cpu({ ...frame, sequence: 2, targetTime: performance.now() + 5000 - 50 })
  assert.equal(f.counts().draws, 2)
})
test('continuous CPU seeks and unbind cancel all old waits and release each copied frame once', async () => {
  for (const unbind of [false, true]) {
    const f = fixture(), cpuToken = 'cpu:' + token
    f.canvas.dataset.playbackSurface = cpuToken; const stop = f.bind(cpuToken)
    const binding = f.messages.find(m => m.channel.endsWith('ready'))!.data
    const frame = { ...binding, sequence: 1, timeline: 0, width: 1, height: 1, stride: 64, size: 64, pixels: new Uint8Array(64) }
    const a = f.cpu({ ...frame, targetTime: performance.now() + 60 })
    f.listeners.get('playback:frame-flush')!(null, { ...binding, timeline: 1 })
    const b = f.cpu({ ...frame, sequence: 2, timeline: 1, targetTime: performance.now() + 60 })
    if (unbind) stop()
    else f.listeners.get('playback:frame-flush')!(null, { ...binding, timeline: 2 })
    await a; await b
    assert.equal(f.counts().draws, 0)
    assert.equal(f.messages.filter(m => m.channel === 'playback:cpu-frame-released').length, 2)
    if (!unbind) {
      await f.cpu({ ...frame, sequence: 3, timeline: 2, targetTime: 0 })
      assert.equal(f.counts().draws, 1, 'paused seek can redraw immediately in the newest epoch')
    }
  }
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

test('slow opt-in GPU diagnostics cannot regress sequence or submission across a timeline flush', async () => {
  let finishCopy!: () => void
  const f = fixture({ probePixels: 'valid', copyWait: new Promise<void>(resolve => { finishCopy = resolve }) })
  f.bind(token)
  const binding = f.messages.find(m => m.channel.endsWith('ready'))!.data
  const first = f.receive(1, binding, { diagnosePixels: true, timeline: 0 })
  await Promise.resolve()
  f.listeners.get('playback:frame-flush')!(null, { ...binding, timeline: 1 })
  await f.receive(2, binding, { timeline: 1 })
  finishCopy(); await first
  await f.receive(2, binding, { timeline: 1 })
  assert.equal(f.counts().draws, 2, 'a completed diagnostic cannot make an already submitted frame eligible again')
  assert.equal(f.counts().releases, 3)
})

for (const probePixels of ['valid', 'black', 'throw'] as const) test('fixed probe reads then clears without media submission: ' + probePixels, async () => {
  const f = fixture({ probePixels }); f.bind(token)
  await f.receive(1, undefined, { selfTest: 'solid-v1', timeline: 0 })
  const result = f.messages.at(-1) as unknown as { channel: string; data: { samples: number[] } }
  assert.equal(result.channel, 'playback:shared-texture-self-test')
  assert.deepEqual(Array.from(result.data.samples), probePixels === 'valid' ? Array(5).fill([64, 191, 128, 255]).flat() : probePixels === 'black' ? Array(20).fill(0) : [])
  assert.deepEqual(f.counts(), { draws: 1, closes: 1, releases: 1, clears: 1 })
})
