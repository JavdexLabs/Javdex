import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

const code = transpileModule(readFileSync(new URL('./sharedTextureVideo.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText
function fixture() {
  const callbacks = new Map<number, () => void>(), writes: unknown[] = []
  let id = 0, stopped = 0, aborted = 0, sampled = 0, failed = 0, autoPresent = true
  let pendingWrite: Promise<void> | undefined
  const cpuFrames: Array<{ displayWidth: number; displayHeight: number; pixels: Uint8Array; init: {format: string; layout: Array<{offset: number; stride: number}>; timestamp: number; colorSpace: unknown}; closed: number }> = []
  const video = {
    muted: false, playsInline: false, srcObject: null as unknown, videoWidth: 0, videoHeight: 0, error: null,
    style: { opacity: '' }, play: async () => {}, pause: () => {}, load: () => { video.videoWidth = video.videoHeight = 0 },
    addEventListener: () => {}, removeEventListener: () => {},
    requestVideoFrameCallback: (callback: () => void) => { callbacks.set(++id, callback); return id },
    cancelVideoFrameCallback: (key: number) => { callbacks.delete(key) }
  }
  const present = (width = 640, height = 360): void => {
    video.videoWidth = width; video.videoHeight = height
    for (const [key, callback] of callbacks) { callbacks.delete(key); callback() }
  }
  const exports = {} as typeof import('./sharedTextureVideo')
  runInNewContext(code, {
    exports, setTimeout, clearTimeout, Uint8ClampedArray,
    VideoFrame: class {
      displayWidth: number; displayHeight: number; pixels: Uint8Array; closed = 0
      constructor(pixels: Uint8Array, public init: {format: string; codedWidth: number; codedHeight: number; layout: Array<{offset: number; stride: number}>; timestamp: number; colorSpace: unknown; transfer?: ArrayBuffer[]}) {
        this.displayWidth = init.codedWidth; this.displayHeight = init.codedHeight
        this.pixels = structuredClone(pixels, {transfer: init.transfer}); cpuFrames.push(this)
      }
      clone() { return { displayWidth: this.displayWidth, displayHeight: this.displayHeight, clone: () => this.clone(), close() {} } }
      close() { this.closed++ }
    },
    MediaStream: class { constructor(public tracks: unknown[]) {} },
    MediaStreamTrackGenerator: class {
      stop = () => { stopped++ }
      writable = { getWriter: () => ({ closed: Promise.resolve(), abort: async () => { aborted++ }, releaseLock: () => {},
        write: async (frame: { displayWidth: number; displayHeight: number }) => {
          writes.push(frame)
          if (autoPresent) queueMicrotask(() => present(frame.displayWidth, frame.displayHeight))
          await pendingWrite
        } }) }
    },
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({
      drawImage: (source: unknown) => { assert.equal(source, video); sampled++ },
      getImageData: () => { const data = new Uint8ClampedArray(640 * 360 * 4); for (let n = 0; n < data.length; n += 4) data.set([64, 191, 128, 255], n); return { data } }
    }) }) }
  })
  const sink = exports.createSharedTextureVideo(video, () => { failed++ })
  return { video, sink, writes, cpuFrames, present, hold: (value?: Promise<void>) => { pendingWrite = value },
    automatic: (value: boolean) => { autoPresent = value }, counts: () => ({ stopped, aborted, sampled, failed }) }
}
const frame = () => ({ displayWidth: 640, displayHeight: 360,
  clone: () => ({ displayWidth: 640, displayHeight: 360, clone: frame, close() {} }),
  close: () => { throw Error('caller owns VideoFrame close') } })

test('video consumes the original frame without Canvas readback or claiming lease completion', async () => {
  const f = fixture(), source = frame()
  assert.equal(await f.sink.submit(source, () => true), true)
  assert.equal(f.writes[0], source)
  assert.equal(f.video.muted, true)
  assert.equal(f.counts().sampled, 0)
  f.sink.dispose(); f.sink.dispose()
  assert.equal(f.counts().stopped, 1)
})
test('timeline reset invalidates an in-flight submission while preserving the visible stream', async () => {
  const f = fixture()
  let resume!: () => void
  f.hold(new Promise<void>(resolve => { resume = resolve }))
  const pending = f.sink.submit(frame(), () => true)
  await Promise.resolve()
  const stream = f.video.srcObject
  f.present()
  for (let n = 0; n < 20; n++) f.sink.flush()
  resume()
  assert.equal(await pending, false)
  assert.equal(f.video.srcObject, stream)
  assert.equal(f.video.videoWidth, 640)
  assert.equal(f.counts().stopped, 0)
  assert.equal(f.counts().aborted, 0)
  f.hold()
  assert.equal(await f.sink.submit(frame(), () => true), true)
  f.sink.dispose()
})
test('unmounted or superseded video work cannot submit to a later binding', async () => {
  const f = fixture()
  assert.equal(await f.sink.submit(frame(), () => false), false)
  assert.equal(f.writes.length, 0)
  f.sink.dispose()
  assert.equal(await f.sink.submit(frame(), () => true), false)
  assert.equal(f.video.srcObject, null)
})
test('self-test samples the mounted video after its callback and gates film writes until a fresh stream exists', async () => {
  const f = fixture(); f.automatic(false)
  const probe = f.sink.selfTest(frame(), () => true)
  const film = f.sink.submit(frame(), () => true)
  await Promise.resolve()
  assert.equal(f.video.style.opacity, '0')
  assert.equal(f.writes.length, 1)
  assert.equal(f.counts().sampled, 0)
  f.present()
  assert.deepEqual(Array.from(await probe), Array.from({ length: 20 }, (_, n) => [64, 191, 128, 255][n % 4]))
  await new Promise<void>(resolve => setImmediate(resolve))
  f.present()
  assert.equal(await film, true)
  assert.equal(f.writes.length, 2)
  assert.equal(f.counts().sampled, 1)
  assert.equal(f.video.style.opacity, '')
  f.sink.dispose()
})
test('seek cancels an outstanding synthetic-video probe and restores normal visibility', async () => {
  const f = fixture(); f.automatic(false)
  const result = assert.rejects(f.sink.selfTest(frame(), () => true), /cancelled/)
  f.sink.flush()
  await result
  assert.equal(f.counts().sampled, 0)
  assert.equal(f.video.style.opacity, '')
  assert.equal(f.counts().failed, 0)
  f.sink.dispose()
})
test('normal-size film pixels cannot enter the bounded video probe readback', () => {
  const f = fixture()
  assert.throws(() => f.sink.pixels(1920, 1080), /diagnostic dimensions/)
  assert.equal(f.counts().sampled, 0)
  f.sink.dispose()
})


test('CPU video copies padded rows to avoid the transferred RGB compositor channel swap', async () => {
  const f = fixture(), pixels = new Uint8Array(new ArrayBuffer(160), 32, 128)
  pixels.set([255, 0, 0, 255]); pixels.set([0, 255, 0, 255], 64)
  assert.equal(await f.sink.submitCpu({pixels, width: 1, height: 2, stride: 64, timestamp: 123456}, () => true), true)
  assert.equal(pixels.buffer.byteLength, 160)
  const owned = f.cpuFrames[0]
  assert.notEqual(f.writes[0], owned)
  assert.equal(owned.init.format, 'RGBX')
  assert.deepEqual(Array.from(owned.init.layout, row => ({...row})), [{offset: 0, stride: 64}])
  assert.equal(owned.init.timestamp, 123456)
  assert.deepEqual(JSON.parse(JSON.stringify(owned.init.colorSpace)), {primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true})
  assert.deepEqual(Array.from(owned.pixels.slice(64, 68)), [0, 255, 0, 255])
  assert.equal(owned.closed, 1)
  assert.equal(f.counts().sampled, 0)
  f.sink.dispose()
})
test('stale CPU video work preserves its input ownership without allocating a frame', async () => {
  const f = fixture(), pixels = new Uint8Array(4)
  assert.equal(await f.sink.submitCpu({pixels, width: 1, height: 1, stride: 4, timestamp: 1}, () => false), false)
  assert.equal(pixels.byteLength, 4); assert.equal(f.cpuFrames.length, 0)
  f.sink.dispose()
})
test('reset while a CPU video write is pending invalidates submission and closes the transferred frame', async () => {
  const f = fixture(); let resume!: () => void
  f.hold(new Promise<void>(resolve => { resume = resolve }))
  const pixels = new Uint8Array(4)
  const work = f.sink.submitCpu({pixels, width: 1, height: 1, stride: 4, timestamp: 1}, () => true)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.cpuFrames.length, 1)
  f.sink.flush(); resume()
  assert.equal(await work, false)
  assert.equal(f.cpuFrames[0].closed, 1)
  f.sink.dispose()
})
test('CPU video write rejection still closes its transferred frame', async () => {
  const f = fixture(); let reject!: (reason: Error) => void
  f.hold(new Promise<void>((_resolve, fail) => { reject = fail }))
  const work = f.sink.submitCpu({pixels: new Uint8Array(4), width: 1, height: 1, stride: 4, timestamp: 1}, () => true)
  const rejected = assert.rejects(work, /write failed/)
  await new Promise<void>(resolve => setImmediate(resolve)); reject(new Error('write failed'))
  await rejected
  assert.equal(f.cpuFrames[0].closed, 1)
  f.sink.dispose()
})

test('CPU video keeps one frame pending at the compositor and transfers the next buffer only after its callback', async () => {
  const f = fixture(); f.automatic(false)
  const a = new Uint8Array(4), b = new Uint8Array(4)
  const first = f.sink.submitCpu({pixels: a, width: 1, height: 1, stride: 4, timestamp: 1}, () => true)
  const second = f.sink.submitCpu({pixels: b, width: 1, height: 1, stride: 4, timestamp: 2}, () => true)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.writes.length, 1); assert.equal(a.byteLength, 0); assert.equal(b.byteLength, 4)
  f.present(1, 1); assert.equal(await first, true)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.writes.length, 2); assert.equal(b.byteLength, 0)
  f.present(1, 1); assert.equal(await second, true)
  assert.deepEqual(f.cpuFrames.map(frame => frame.closed), [1, 1])
  f.sink.dispose()
})

test('CPU compositor backpressure tolerates a short stall within the existing copied-frame timeout', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const f = fixture(); f.automatic(false)
  let result = 'pending'
  const work = f.sink.submitCpu({pixels: new Uint8Array(4), width: 1, height: 1, stride: 4, timestamp: 1}, () => true)
  void work.then(() => { result = 'submitted' }, () => { result = 'failed' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.writes.length, 1)
  t.mock.timers.tick(1600)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(result, 'pending', 'a short compositor stall is not a CPU display failure')
  f.present(1, 1)
  assert.equal(await work, true)
  assert.equal(f.cpuFrames[0].closed, 1)
  f.sink.dispose()
})


test('startup retries the same GPU pixels until the asynchronous video sink observes a frame', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const f = fixture(); f.automatic(false)
  let referencesClosed = 0
  const source = { ...frame(), clone: () => ({ ...frame(), close() { referencesClosed++ } }) }
  const work = f.sink.selfTest(source, () => true)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.writes.length, 1)
  t.mock.timers.tick(32)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.writes.length, 2)
  assert.equal(referencesClosed, 2, 'each clone is closed without closing the caller-owned source')
  assert.equal(f.counts().sampled, 0)
  f.present()
  assert.equal((await work).length, 20)
  const count = f.writes.length
  t.mock.timers.tick(1000)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.writes.length, count)
  f.sink.dispose()
})
test('startup without a video sink times out and stops retries without sampling fake pixels', async t => {
  t.mock.timers.enable({apis: ['setTimeout']})
  const f = fixture(); f.automatic(false)
  const rejected = assert.rejects(f.sink.selfTest(frame(), () => true), /timed out/)
  await new Promise<void>(resolve => setImmediate(resolve))
  t.mock.timers.tick(1500)
  await rejected
  const count = f.writes.length
  t.mock.timers.tick(5000)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.writes.length, count)
  assert.equal(f.counts().sampled, 0)
  f.sink.dispose()
})
