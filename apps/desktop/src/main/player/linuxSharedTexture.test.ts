import { createFrameEndpoint, isFrameBinding } from './frameEndpoint'
import { FrameHealthProbe } from './frameHealthProbe'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { BrowserWindow, ImportSharedTextureOptions } from 'electron'
import { FrameBudget } from './frameBudget'

const code = transpileModule(readFileSync(new URL('./linuxSharedTexture.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText
const bindingToken = '33333333-3333-4333-8333-333333333333'
const READY = 'playback:shared-texture-ready'
const REMOVED = 'playback:shared-texture-removed'
const FAILED = 'playback:shared-texture-failed'
const DRAWN = 'playback:shared-texture-submitted'
const TRANSFER = 'playback:linux-texture-transfer'
const RELEASED = 'playback:linux-texture-released'
const frame = (sequence = 1, slot = 0, extra: Record<string, unknown> = {}) => ({ protocol: 'javdex-dmabuf-v1',
  sequence, slot, width: 320, height: 180, pixelFormat: 'bgra', stride: 1280, offset: 0, size: 230400,
  modifier: '0', producerComplete: true, ...extra })
function fixture(diagnostics = false, software = false) {
  let nextFd = 100
  let now = 0, receiveCalls = 0, ackWritable = true, importFailure = false, sendFailure = false, flushFailure = false
  const timers = new Set<() => void>()
  let frameDestroyed = false, interest = 0
  let readiness: ((status: number, events: number) => void) | undefined
  let lifecycleReport: ((request: { owners: unknown[] }) => void) | undefined
  const app = new EventEmitter(), ipc = new EventEmitter()
  const mainFrame = { isDestroyed: () => frameDestroyed }
  const contents = Object.assign(new EventEmitter(), { mainFrame, send: (channel: string, metadata: unknown) => {
    if (sendFailure && channel === TRANSFER) throw new Error('transfer delivery unknown')
    if (flushFailure && channel === 'playback:frame-flush') throw new Error('disposed renderer frame')
    sent.push({ frame: mainFrame, metadata: metadata as typeof sent[number]['metadata'] })
  }, isDestroyed: () => false })
  const window = { webContents: contents } as unknown as BrowserWindow
  const closed: number[] = [], acknowledgements: number[] = [], errors: Error[] = []
  const incoming: Array<{ fd: number; metadata: Buffer }> = []
  const imports: Array<{ options: ImportSharedTextureOptions; releases: number }> = []
  const diagnosticLogs: string[] = []
  const sent: Array<{ frame: unknown; metadata: { surfaceToken: string; bindingToken: string; sequence: number } }> = []
  const transport = {
    readPixels: (_fd: number, size: number) => Buffer.alloc(size, 255),
    watch: (_fd: number, events: number, callback: typeof readiness) => { interest = events; readiness = callback; return true },
    updateWatch: (_fd: number, events: number) => { interest = events; return true },
    unwatch: () => { readiness = undefined; interest = 0; return true },
    createChannel: () => ({ parentFd: 10, childFd: 11 }),
    close: (fd: number) => { assert.ok(!closed.includes(fd), `FD ${fd} must close exactly once`); closed.push(fd) },
    receive: () => { receiveCalls++; return incoming.shift() ?? null },
    sendAck: (_fd: number, sequence: number) => { if (ackWritable) acknowledgements.push(sequence); return ackWritable }
  }
  const exports = {} as typeof import('./linuxSharedTexture')
  runInNewContext(code, { exports, Buffer, process: { hrtime: { bigint: () => BigInt(now * 1000000) }, env: { JAVDEX_TEXTURE_PIXEL_DIAGNOSTICS: diagnostics ? '1' : '' } },
    console: { info: (tag: string, data: string) => { if (tag === '[playback-texture-pixels]') diagnosticLogs.push(data) } }, Date: { now: () => now },
    setInterval: (callback: () => void) => { timers.add(callback); return { unref() {}, callback } },
    clearInterval: (timer?: { callback: () => void }) => { if (timer) timers.delete(timer.callback) },
    require(id: string): unknown {
      if (id === './frameEndpoint') return { createFrameEndpoint, isFrameBinding }

      if (id === './frameHealthProbe') return { FrameHealthProbe }
      if (id === './frameBudget') return { FrameBudget }
      if (id === 'node:diagnostics_channel') return { channel: () => ({
        subscribe: (callback: typeof lifecycleReport) => { lifecycleReport = callback },
        unsubscribe: () => { lifecycleReport = undefined }
      }) }
      if (id === 'node:crypto') return { randomUUID: () => '11111111-1111-4111-8111-111111111111' }
      if (id === 'node:module') return { createRequire: () => () => transport }
      if (id === 'electron') return { app, ipcMain: ipc, sharedTexture: {
        importSharedTexture(options: ImportSharedTextureOptions) {
          if (importFailure) throw new Error('import failed')
          const value = { options, releases: 0 }; imports.push(value)
          return { release: () => { value.releases++ }, subtle: { startTransferSharedTexture: () => ({ id: imports.length }) } }
        },
        async sendSharedTexture(options: { frame: unknown }, metadata: typeof sent[number]['metadata']) {
          sent.push({ frame: options.frame, metadata })
          if (sendFailure) throw new Error('transfer failed')
        }
      } }
      throw new Error(`Unexpected dependency ${id}`)
    }
  })
  const manager = exports.createLinuxSharedTexture(window, '/fixture/playback-fd.node', error => errors.push(error), software)
  const binding = { surfaceToken: manager.surfaceToken, bindingToken }
  const event = { sender: contents, senderFrame: mainFrame }
  return { manager, imports, closed, sent, errors, acknowledgements, contents, ipc, app, exports, event, binding, diagnosticLogs,
    ready: () => ipc.emit(READY, event, binding),
    packet: (sequence = 1, slot = 0, extra = {}) => incoming.push({ fd: ++nextFd, metadata: Buffer.from(JSON.stringify(frame(sequence, slot, extra))) }),
    tick: async (advance = 0) => { now += advance;
      if (readiness && ((interest & 1) && incoming.length || (interest & 2) && ackWritable)) readiness(0, interest)
      for (const tick of [...timers]) tick(); await Promise.resolve(); await Promise.resolve() },
    readiness: () => readiness, interest: () => interest,
    destroyFrame: () => { frameDestroyed = true },
    receiveCalls: () => receiveCalls,
    owners: () => { const request = { owners: [] }; lifecycleReport?.(request); return request.owners },
    blockedAck: () => { ackWritable = false },
    failImport: () => { importFailure = true }, failSend: () => { sendFailure = true }, failFlush: () => { flushFailure = true },
    release: (index = 0) => imports[index].options.allReferencesReleased!()
  }
}

for (const software of [false, true]) test(`Linux IPC callback failure notifies its owner without escaping (CPU: ${software})`, t => {
  const f = fixture(false, software); t.after(f.manager.destroy)
  f.manager.onReady(() => { throw new Error('helper pipe closed') })
  assert.doesNotThrow(f.ready)
  assert.equal(f.errors.length, 1)
  assert.equal(f.ipc.listenerCount(READY), 0)
  assert.deepEqual(f.closed.slice().sort((a, b) => a - b), [10, 11])
})

for (const software of [false, true]) test(`Linux failed clock reply notifies its owner (CPU: ${software})`, t => {
  const f = fixture(false, software); t.after(f.manager.destroy)
  f.contents.send = () => { throw new Error('frame reply unavailable') }
  assert.doesNotThrow(() => f.ipc.emit('playback:frame-clock', f.event, { ...f.binding, sentAt: 1 }))
  assert.equal(f.errors.length, 1)
  assert.equal(f.ipc.listenerCount('playback:frame-clock'), 0)
})

for (const mode of ['destroy', 'renderer-gone', 'gpu-gone'] as const)
  test(`disposed flush cannot abort Linux ${mode} cleanup or its failure notification`, async () => {
    const f = fixture(); f.ready(); f.manager.setVisible(true)
    f.packet(); await f.tick()
    assert.equal(f.imports.length, 1)
    f.failFlush()
    assert.doesNotThrow(() => {
      if (mode === 'destroy') f.manager.destroy()
      else if (mode === 'renderer-gone') f.contents.emit('render-process-gone')
      else f.app.emit('child-process-gone', {}, { type: 'GPU' })
    })
    assert.deepEqual(f.closed.slice().sort((a, b) => a - b), [10, 11, 101])
    assert.equal(f.errors.length, mode === 'destroy' ? 0 : 1, 'owner must receive the failure and terminate the helper')
    assert.equal(f.ipc.listenerCount(READY), 0)
    assert.equal(f.contents.listenerCount('render-process-gone'), 0)
    assert.equal(f.app.listenerCount('child-process-gone'), 0)
    const receives = f.receiveCalls(); await f.tick(10000)
    assert.equal(f.receiveCalls(), receives)
    f.release(); f.manager.destroy()
    assert.deepEqual(f.acknowledgements, [], 'teardown never grants unknown consumer reuse')
  })

test('pixel diagnostics accept only requested sequences from the bound main frame and strip arbitrary data', async t => {
  const f = fixture(true); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  f.packet(15, 0, { width: 640, height: 360, stride: 2560, size: 921600 })
  await f.tick()
  const data = { ...f.binding, sequence: 15, canvas: { samples: 20, nonblack: 19, path: '/private', maximum: Infinity },
    geometry: { width: 640, visible: true, url: 'secret' } }
  f.ipc.emit('playback:shared-texture-pixel-diagnostic', { ...f.event, senderFrame: {} }, data)
  assert.equal(f.diagnosticLogs.length, 0)
  f.ipc.emit('playback:shared-texture-pixel-diagnostic', f.event, data)
  f.ipc.emit('playback:shared-texture-pixel-diagnostic', f.event, data)
  assert.equal(f.diagnosticLogs.length, 1)
  assert.deepEqual(JSON.parse(f.diagnosticLogs[0]), { sequence: 15, readbackPerturbsRendering: true,
    canvas: { samples: 20, nonblack: 19 }, geometry: { width: 640, visible: true } })
})

test('validates the complete one-plane DMA-BUF descriptor before native import', t => {
  const f = fixture(); t.after(f.manager.destroy)
  assert.equal(f.exports.decodeDmaBufFrame(Buffer.from(JSON.stringify(frame()))).width, 320)
  for (const invalid of [
    { width: 0 }, { width: 8193 }, { stride: 1279 }, { stride: 131073 }, { offset: -1 }, { size: 1 },
    { sequence: 0 }, { sequence: 1.5 }, { slot: 3 }, { producerComplete: false }, { pixelFormat: 'nv12' },
    { selfTest: 'other' }, { selfTest: 'solid-v1' }, { selfTest: 'solid-v1', width: 64, height: 64 },
    { modifier: '-1' }, { modifier: '18446744073709551616' }, { modifier: 0 }, { protocol: 'other' }
  ]) assert.throws(() => f.exports.decodeDmaBufFrame(Buffer.from(JSON.stringify(frame(1, 0, invalid)))))
  assert.throws(() => f.exports.decodeDmaBufFrame(Buffer.alloc(4097)))
  assert.throws(() => f.exports.decodeDmaBufFrame(Buffer.from('null')))
})
test('pixel diagnostics sample eligible frames after resize, with at most three requests', async t => {
  const f = fixture(true); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  // The old absolute 15/30/45 trigger could be consumed by the initial 1px viewport.
  for (let sequence = 1; sequence <= 65; sequence++) {
    f.packet(sequence, 0, sequence > 30 ? { width: 640, height: 360, stride: 2560, size: 921600 } : {})
    await f.tick(); f.release(sequence - 1); await f.tick()
  }
  const requested = f.sent.filter(item => (item.metadata as { diagnosePixels?: boolean }).diagnosePixels)
  assert.deepEqual(requested.map(item => item.metadata.sequence), [31, 46, 61])
})
test('requires a current, main-frame receiver and never ACKs merely completed sends', async t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.manager.spawned(); f.manager.spawned()
  assert.deepEqual(f.closed, [11])
  f.manager.setVisible(true); f.packet()
  f.ipc.emit(READY, { ...f.event, sender: {} }, f.binding)
  f.ipc.emit(READY, { ...f.event, senderFrame: {} }, f.binding)
  f.ipc.emit(READY, f.event, { ...f.binding, surfaceToken: 'old' })
  await f.tick(); assert.equal(f.receiveCalls(), 0)
  f.ready(); await f.tick()
  assert.equal(f.imports.length, 1)
  assert.equal(f.imports[0].releases, 0, 'transfer delivery must retain the main reference')
  f.ipc.emit(RELEASED, { ...f.event, senderFrame: {} }, { ...f.binding, sequence: 1 })
  assert.equal(f.imports[0].releases, 0)
  f.ipc.emit(RELEASED, f.event, { ...f.binding, sequence: 1 })
  f.ipc.emit(RELEASED, f.event, { ...f.binding, sequence: 1 })
  assert.equal(f.imports[0].releases, 1, 'only authenticated consumer GPU completion releases the main reference')
  assert.equal(f.sent[0].frame, f.contents.mainFrame)
  assert.equal(f.sent[0].metadata.surfaceToken, f.manager.surfaceToken)
  assert.deepEqual(f.acknowledgements, [])
  assert.equal(f.closed.includes(101), false)
  f.release(); f.release(); await f.tick()
  assert.deepEqual(f.acknowledgements, [1])
  assert.equal(f.closed.filter(fd => fd === 101).length, 1)
})
test('bounds the total outstanding pool and keeps slot ownership through a blocked ACK', async t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  for (let i = 1; i <= 4; i++) f.packet(i, (i - 1) % 3)
  for (let i = 0; i < 4; i++) await f.tick()
  assert.equal(f.imports.length, 3)
  f.blockedAck(); f.release(); await f.tick()
  assert.equal(f.imports.length, 3, 'a released but unacknowledged slot remains owned')
  assert.deepEqual(f.acknowledgements, [])
  await f.tick(5001)
  assert.equal(f.errors.length, 1)
  assert.match(f.errors[0].message, /超时/)
  assert.equal(f.closed.includes(10), true)
  assert.equal(f.closed.includes(104), false, 'the fourth frame was never received')
})
test('a paused canvas may retain a frame without failing the session', async t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  f.packet(1, 0, { selfTest: 'solid-v1', width: 640, height: 360, stride: 2560, size: 921600 }); await f.tick()
  f.ipc.emit('playback:shared-texture-self-test', f.event, { ...f.binding, sequence: 1, samples: Array(5).fill([64, 191, 128, 255]).flat() })
  f.release(); await f.tick(); f.packet(2, 1); await f.tick(); await f.tick(60000)
  assert.equal(f.errors.length, 0)
  assert.equal(f.imports.length, 2)
})
test('a saturated unreleased GPU pool fails closed rather than recycling textures', async t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  for (let i = 1; i <= 3; i++) { f.packet(i, i - 1); await f.tick() }
  await f.tick(); await f.tick(5001)
  assert.equal(f.errors.length, 1)
  assert.deepEqual(f.acknowledgements, [])
  assert.deepEqual([...f.closed].sort(), [10, 11, 101, 102, 103].sort())
  for (let i = 0; i < 3; i++) f.release(i)
  assert.deepEqual(f.acknowledgements, [], 'late GPU releases after stop cannot ACK a new producer')
})
test('rejects reused slots and regressing sequence numbers', async t => {
  for (const [sequence, slot] of [[2, 0], [1, 1]]) {
    const f = fixture(); t.after(f.manager.destroy)
    f.ready(); f.manager.setVisible(true); f.packet(); await f.tick()
    if (sequence === 1) { f.release(); await f.tick() }
    f.packet(sequence, slot); await f.tick()
    assert.equal(f.errors.length, 1)
    assert.deepEqual(f.acknowledgements, sequence === 1 ? [1] : [])
  }
})
for (const failure of ['metadata', 'import', 'transfer'] as const) test(`${failure} failure closes owned FDs and never ACKs`, async t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  if (failure === 'import') f.failImport()
  if (failure === 'transfer') f.failSend()
  f.packet(1, 0, failure === 'metadata' ? { producerComplete: false } : {})
  await f.tick()
  assert.equal(f.errors.length, 1)
  assert.equal(f.closed.includes(101), true)
  assert.deepEqual(f.acknowledgements, [])
  if (failure === 'transfer') {
    assert.equal(f.imports[0].releases, 0, 'unknown delivery is quarantined')
    f.ipc.emit(RELEASED, f.event, { ...f.binding, sequence: 1 })
    assert.equal(f.imports[0].releases, 1, 'late completion still drops its original main reference')
    f.release()
  }
})
test('mount replacement removes only its exact binding, and hidden surfaces keep draining releases', async t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true); f.packet(); await f.tick()
  const replacement = { ...f.binding, bindingToken: '44444444-4444-4444-8444-444444444444' }
  f.ipc.emit(READY, f.event, replacement)
  f.ipc.emit(REMOVED, f.event, f.binding)
  f.packet(2, 1); await f.tick()
  assert.equal(f.sent[1].metadata.bindingToken, replacement.bindingToken)
  f.manager.setVisible(false); f.release(); await f.tick()
  assert.deepEqual(f.acknowledgements, [1])
  const receives = f.receiveCalls(); f.packet(3, 2); await f.tick()
  assert.equal(f.receiveCalls(), receives)
})
test('missing receivers time out only while visible', async t => {
  const f = fixture(); t.after(f.manager.destroy)
  await f.tick(30000); assert.equal(f.errors.length, 0)
  f.manager.setVisible(true); await f.tick(10001)
  assert.equal(f.errors.length, 1)
})
test('GPU loss, renderer replacement, and authenticated draw failures stop without ACK', async t => {
  for (const failure of ['gpu', 'reload', 'crash', 'draw']) {
    const f = fixture(); t.after(f.manager.destroy)
    f.ready(); f.manager.setVisible(true); f.packet(); await f.tick()
    f.contents.emit('did-start-navigation', {}, 'app://route', true, true)
    f.contents.emit('did-start-navigation', {}, 'app://frame', false, false)
    f.ipc.emit(FAILED, { ...f.event, senderFrame: {} }, f.binding)
    assert.equal(f.errors.length, 0)
    if (failure === 'gpu') f.app.emit('child-process-gone', {}, { type: 'GPU' })
    if (failure === 'reload') f.contents.emit('did-start-navigation', {}, 'app://index', false, true)
    if (failure === 'crash') f.contents.emit('render-process-gone')
    if (failure === 'draw') f.ipc.emit(FAILED, f.event, f.binding)
    assert.equal(f.errors.length, 1)
    f.release(); await f.tick()
    assert.deepEqual(f.acknowledgements, [])
    assert.equal(f.ipc.listenerCount(READY), 0)
    assert.equal(f.app.listenerCount('child-process-gone'), 0)
  }
})


test('counts only current, visible, monotonically ordered canvas draw submissions', async t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true); f.packet(); await f.tick()
  assert.equal(f.manager.submittedFrames(), 0, 'export/import/transfer do not establish a drawn frame')
  const value = { ...f.binding, sequence: 1 }
  f.ipc.emit(DRAWN, { ...f.event, senderFrame: {} }, value)
  f.ipc.emit(DRAWN, f.event, { ...value, surfaceToken: 'obsolete' })
  f.ipc.emit(DRAWN, f.event, { ...value, bindingToken: '55555555-5555-4555-8555-555555555555' })
  f.ipc.emit(DRAWN, f.event, { ...value, sequence: 2 })
  f.ipc.emit(DRAWN, f.event, { ...value, sequence: 0 })
  f.manager.setVisible(false); f.ipc.emit(DRAWN, f.event, value)
  assert.equal(f.manager.submittedFrames(), 0)
  f.manager.setVisible(true); f.ipc.emit(DRAWN, f.event, value); f.ipc.emit(DRAWN, f.event, value)
  assert.equal(f.manager.submittedFrames(), 1)
  f.packet(2, 1); await f.tick(); f.ipc.emit(DRAWN, f.event, { ...value, sequence: 2 })
  assert.equal(f.manager.submittedFrames(), 2)
  f.manager.destroy(); assert.equal(f.ipc.listenerCount(DRAWN), 0)
})


test('readiness follows authenticated mount registration and is revoked on detach or destruction', t => {
  const f = fixture(); t.after(f.manager.destroy)
  assert.equal(f.manager.isReady(), false)
  f.ipc.emit(READY, { ...f.event, senderFrame: {} }, f.binding)
  assert.equal(f.manager.isReady(), false)
  f.ready(); assert.equal(f.manager.isReady(), true)
  f.ipc.emit(REMOVED, f.event, { ...f.binding, bindingToken: '44444444-4444-4444-8444-444444444444' })
  assert.equal(f.manager.isReady(), true)
  f.ipc.emit(REMOVED, f.event, f.binding); assert.equal(f.manager.isReady(), false)
  f.ready(); f.manager.destroy(); assert.equal(f.manager.isReady(), false)
})
test('hidden full GPU pools do not time out and resume with a fresh bounded interval', async t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  for (let i = 1; i <= 3; i++) { f.packet(i, i - 1); await f.tick() }
  await f.tick(4000)
  f.manager.setVisible(false); await f.tick(60000)
  assert.equal(f.errors.length, 0)
  assert.deepEqual(f.acknowledgements, [])
  f.manager.setVisible(true); await f.tick(1); await f.tick(4000)
  assert.equal(f.errors.length, 0, 'restoring a hidden window starts a fresh timeout')
  for (let i = 0; i < 3; i++) f.release(i)
  await f.tick()
  assert.deepEqual(f.acknowledgements, [1, 2, 3])
  assert.equal(f.errors.length, 0)
})

test('CPU channel validates layout, copies only owned memory and keeps IPC bounded until authenticated release', async t => {
  const f = fixture(false, true); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  const cpu = { protocol: 'javdex-cpu-v1', pixelFormat: 'rgbx' }
  f.packet(1, 0, cpu); await f.tick()
  assert.equal(f.imports.length, 0); assert.equal(f.sent.length, 1)
  assert(f.closed.includes(101)); assert.deepEqual(f.acknowledgements, [])
  f.ipc.emit(DRAWN, { ...f.event, senderFrame: {} }, { ...f.binding, sequence: 1 }); await f.tick()
  assert.deepEqual(f.acknowledgements, [])
  f.ipc.emit(DRAWN, f.event, { ...f.binding, sequence: 1 }); await f.tick()
  assert.deepEqual(f.acknowledgements, [], 'a submission is not a copied-frame release')
  f.ipc.emit('playback:cpu-frame-released', { ...f.event, senderFrame: {} }, { ...f.binding, sequence: 1 }); await f.tick()
  assert.deepEqual(f.acknowledgements, [])
  f.ipc.emit('playback:cpu-frame-released', f.event, { ...f.binding, sequence: 1 }); await f.tick()
  assert.deepEqual(f.acknowledgements, [1])
  f.packet(2, 0, cpu); f.packet(3, 1, cpu); f.packet(4, 2, cpu); f.packet(5, 0, cpu)
  await f.tick(); await f.tick(); await f.tick(); await f.tick()
  assert.equal(f.sent.length, 4)
  f.ipc.emit(REMOVED, f.event, f.binding); await f.tick()
  assert.deepEqual(f.acknowledgements, [1, 2, 3, 4], 'unmounted copied frames cannot strand helper slots')
  assert.equal(f.errors.length, 0)
  for (const invalid of [{ stride: 1279 }, { stride: 1281 }, { size: 1 }, { width: 8193 }])
    assert.throws(() => f.exports.decodeCpuFrame(Buffer.from(JSON.stringify({ ...frame(), ...cpu, ...invalid }))))
})
test('CPU timing reset rejects old epochs, releases stale packets and forwards current target in milliseconds', async t => {
  const f = fixture(false, true); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  assert.equal(f.manager.resetTiming(), 1)
  f.packet(1, 0, { protocol: 'javdex-cpu-v1', pixelFormat: 'rgbx', timeline: 0, renderStartUs: 1, targetTimeUs: 20000 })
  await f.tick(); await f.tick()
  assert.deepEqual(f.acknowledgements, [1]); assert.equal(f.manager.submittedFrames(), 0)
  f.packet(2, 0, { protocol: 'javdex-cpu-v1', pixelFormat: 'rgbx', timeline: 1, renderStartUs: 1, targetTimeUs: 20000 })
  await f.tick()
  assert.equal((f.sent.at(-1)!.metadata as unknown as { targetTime: number }).targetTime, 20)
  f.ipc.emit('playback:cpu-frame-released', f.event, { ...f.binding, sequence: 2 }); await f.tick()
  assert.deepEqual(f.acknowledgements, [1, 2])
})
test('a hidden CPU submission is not counted but still releases its copied frame', async t => {
  const f = fixture(false, true); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  f.packet(1, 0, { protocol: 'javdex-cpu-v1', pixelFormat: 'rgbx' }); await f.tick()
  f.manager.setVisible(false)
  f.ipc.emit(DRAWN, f.event, { ...f.binding, sequence: 1 })
  assert.equal(f.manager.submittedFrames(), 0)
  f.ipc.emit('playback:cpu-frame-released', f.event, { ...f.binding, sequence: 1 }); await f.tick()
  assert.deepEqual(f.acknowledgements, [1])
})
test('CPU slow consumers retain the three-slot bound through blocked release ACKs and destruction', async t => {
  const f = fixture(false, true); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  for (let i=1;i<=4;i++) f.packet(i,(i-1)%3,{protocol:'javdex-cpu-v1',pixelFormat:'rgbx'})
  for (let i=0;i<4;i++) await f.tick()
  assert.equal(f.sent.length,3)
  f.blockedAck(); f.ipc.emit('playback:cpu-frame-released',f.event,{...f.binding,sequence:1}); await f.tick()
  assert.deepEqual(f.acknowledgements,[]); assert.equal(f.sent.length,3)
  f.manager.resetTiming()
  f.ipc.emit(DRAWN,f.event,{...f.binding,sequence:2,timeline:0}); assert.equal(f.manager.submittedFrames(),0)
  f.manager.setVisible(false); await f.tick(60000); assert.equal(f.errors.length,1, 'an undeliverable ACK remains a bounded channel failure')
  f.ipc.emit('playback:cpu-frame-released',f.event,{...f.binding,sequence:3}); await f.tick()
  assert.deepEqual(f.acknowledgements,[])
  assert.equal(f.closed.includes(10),true)
})
test('frame timing and producer color contracts reject partial, invalid and misleading metadata', t => {
  const f=fixture(); t.after(f.manager.destroy)
  for(const invalid of [{timeline:-1},{targetTimeUs:1},{renderStartUs:0},{timeline:1,targetTimeUs:1.5,renderStartUs:1},
    {colorContract:'srgb-calibrated'}]) {
    assert.throws(()=>f.exports.decodeCpuFrame(Buffer.from(JSON.stringify({...frame(),protocol:'javdex-cpu-v1',pixelFormat:'rgbx',...invalid}))))
    assert.throws(()=>f.exports.decodeDmaBufFrame(Buffer.from(JSON.stringify(frame(1,0,invalid)))))
  }
  assert.throws(()=>f.exports.decodeCpuFrame(Buffer.from(JSON.stringify({...frame(),protocol:'javdex-cpu-v1',pixelFormat:'rgba'}))))
})

test('adaptive budget bounds cost spikes and adjustment rate, resets to 20ms', () => {
  const f = fixture(), b = new FrameBudget()
  assert.equal(b.value, 20)
  for (let i = 0; i < 5000; i++) b.observe(90, i * 34)
  assert.equal(b.value, 40)
  b.observe(Infinity, 999999); b.observe(-1, 999999); b.observe(1000, 999999)
  assert.equal(b.value, 40)
  for (let i = 0; i < 10000; i++) b.observe(1, 200000 + i * 34)
  assert.ok(b.value >= 8 && b.value <= 9, '1ms deadband must remain inside lower bound')
  b.reset(); assert.equal(b.value, 20)
  for (let i = 0; i < 30; i++) b.observe(40, 2000)
  assert.equal(b.value, 22)
  for (let i = 0; i < 100; i++) b.observe(40, 2001)
  assert.equal(b.value, 22)
  f.manager.destroy()
})
for (const software of [false, true]) test(`upstream drop feedback reaches only the visible GPU budget (CPU: ${software})`, async t => {
  const f = fixture(false, software); t.after(f.manager.destroy)
  const changes: number[] = []
  f.ready(); f.manager.setVisible(true); f.manager.onBudget(value => changes.push(value))
  f.manager.observeState({ alive: true, pause: false, 'frame-drop-count': 0 })
  await f.tick(2000)
  f.manager.observeState({ alive: true, pause: false, 'frame-drop-count': 12 })
  assert.deepEqual(changes, software ? [] : [24])
  f.manager.observeState({ alive: true, pause: true, 'frame-drop-count': 20 })
  await f.tick(2000)
  f.manager.observeState({ alive: true, pause: false, 'frame-drop-count': 40 })
  assert.deepEqual(changes, software ? [] : [24], 'pause cannot look like sustained playback pressure')
  f.manager.resetTiming()
  assert.equal(changes.at(-1), software ? 20 : 24, 'GPU seeks retain the floor learned by this helper')
})
test('clock calibration rejects untrusted renderers and reset drops stale frames without reusing held textures', async t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  const before = f.sent.length
  f.ipc.emit('playback:frame-clock', { ...f.event, senderFrame: {} }, { ...f.binding, sentAt: 3 })
  assert.equal(f.sent.length, before)
  f.ipc.emit('playback:frame-clock', f.event, { ...f.binding, sentAt: 3 })
  assert.equal(f.sent.length, before + 1)
  assert.equal(f.manager.resetTiming(), 1)
  f.packet(1, 0); await f.tick(); await f.tick()
  assert.deepEqual(f.acknowledgements, [1])
  assert.equal(f.imports.length, 0)
  f.packet(2, 0, { timeline: 1, targetTimeUs: 20000, renderStartUs: 1 }); await f.tick()
  assert.equal(f.imports.length, 1)
  f.ipc.emit(DRAWN, f.event, { ...f.binding, sequence: 2 })
  await f.tick()
  assert.deepEqual(f.acknowledgements, [1], 'submission never grants GPU slot reuse')
  f.release(); await f.tick()
  assert.deepEqual(f.acknowledgements, [1, 2])
})

test('synthetic import test accepts only the issued sequence and current trusted binding', async t => {
  const f = fixture(); t.after(f.manager.destroy); f.ready(); f.manager.setVisible(true)
  const samples = Array(5).fill([64, 191, 128, 255]).flat()
  const report = { ...f.binding, sequence: 1, samples, media: 'never log this' }
  f.ipc.emit('playback:shared-texture-self-test', f.event, report)
  assert.equal(f.manager.displayProbe(), 'pending')
  f.packet(1, 0, { selfTest: 'solid-v1', width: 640, height: 360, stride: 2560, size: 921600 }); await f.tick()
  f.ipc.emit('playback:shared-texture-self-test', { ...f.event, senderFrame: {} }, report)
  f.ipc.emit('playback:shared-texture-self-test', f.event, { ...report, sequence: 2 })
  f.ipc.emit('playback:shared-texture-self-test', f.event, { ...report, bindingToken: 'old' })
  assert.equal(f.manager.displayProbe(), 'pending')
  f.ipc.emit('playback:shared-texture-self-test', f.event, report)
  assert.equal(f.manager.displayProbe(), 'passed')
  assert.equal(f.manager.submittedFrames(), 0, 'self-test does not count as a media submission')
  f.ipc.emit('playback:shared-texture-self-test', f.event, { ...report, samples: [] })
  assert.equal(f.errors.length, 0, 'duplicate results cannot undo a completed test')
})
for (const samples of [[], Array(20).fill(0), Array(20).fill(255), Array(5).fill([128, 191, 64, 255]).flat(),
  [64, 191, 128, 255, 0, 0, 0, 255, 0, 0, 0, 255, 64, 191, 128, 255, 0, 0, 0, 255]])
  test('synthetic import fails closed on corrupt/black/swapped pixels ' + samples.slice(0, 4), async t => {
    const f = fixture(); t.after(f.manager.destroy); f.ready(); f.manager.setVisible(true)
    f.packet(1, 0, { selfTest: 'solid-v1', width: 640, height: 360, stride: 2560, size: 921600 }); await f.tick()
    f.ipc.emit('playback:shared-texture-self-test', f.event, { ...f.binding, sequence: 1, samples })
    assert.match(f.errors[0]?.message, /自检失败/)
    assert(f.closed.includes(10))
  })
test('self-test timeout is bounded while visible, and hidden time is excluded', async t => {
  const f = fixture(); t.after(f.manager.destroy); f.ready(); f.manager.setVisible(true); await f.tick()
  f.manager.setVisible(false); await f.tick(60000); assert.equal(f.errors.length, 0)
  f.manager.setVisible(true); await f.tick(); await f.tick(8001)
  assert.match(f.errors[0]?.message, /自检超时/)
})

test('CPU transport never waits for the GPU display probe', async t => {
  const f = fixture(false, true); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true); await f.tick(); await f.tick(60000)
  assert.equal(f.manager.displayProbe(), 'not-applicable')
  assert.equal(f.errors.length, 0)
})

// A transport receipt, JS close, submission, or one-second delay is not a GPU fence.
test('Linux low-level transfer preserves producer timestamp and a delayed consumer lease across stop', async () => {
  const f = fixture(); f.ready(); f.manager.setVisible(true)
  f.packet(1, 0, { timeline: 0, renderStartUs: 2000000, targetTimeUs: 2020000 }); await f.tick(2000)
  assert.equal(f.imports[0].options.textureInfo.timestamp, 2020000)
  await f.tick(1500)
  assert.equal(f.errors.length, 0); assert.equal(f.imports[0].releases, 0)
  assert.deepEqual(f.acknowledgements, [])
  f.manager.destroy()
  assert.equal(f.owners().length, 1, 'quarantined ownership stays observable after producer teardown')
  f.ipc.emit(RELEASED, f.event, { ...f.binding, bindingToken: '44444444-4444-4444-8444-444444444444', sequence: 1 })
  assert.equal(f.imports[0].releases, 0)
  f.ipc.emit(RELEASED, f.event, { ...f.binding, sequence: 1 })
  assert.equal(f.imports[0].releases, 1)
  f.release(); assert.deepEqual(f.acknowledgements, [])
  assert.equal(f.ipc.listenerCount(RELEASED), 0)
  assert.equal(f.owners().length, 0, 'final GPU release removes lifecycle diagnostics')
})

test('a destroyed page drops retired main references without granting the terminated producer reuse', async () => {
  const f = fixture(); f.ready(); f.manager.setVisible(true); f.packet(); await f.tick()
  f.manager.destroy(); assert.equal(f.imports[0].releases, 0)
  f.destroyFrame(); await f.tick(1000)
  assert.equal(f.imports[0].releases, 1)
  f.release(); await f.tick(1000)
  assert.deepEqual(f.acknowledgements, [])
  assert.equal(f.owners().length, 0)
})

test('reload reusing a live frame retires old transfers only after a new document is ready', async () => {
  const f = fixture(); f.ready(); f.manager.setVisible(true); f.packet(); await f.tick()
  f.manager.destroy()
  f.contents.emit('dom-ready'); assert.equal(f.imports[0].releases, 0)
  f.contents.emit('did-start-navigation', {}, 'app://same#hash', true, true)
  f.contents.emit('dom-ready'); assert.equal(f.imports[0].releases, 0)
  f.contents.emit('did-start-navigation', {}, 'app://reload', false, true)
  assert.equal(f.imports[0].releases, 0, 'navigation start alone cannot release a transfer')
  f.contents.emit('dom-ready'); assert.equal(f.imports[0].releases, 1)
  f.release(); assert.deepEqual(f.acknowledgements, [])
  assert.equal(f.contents.listenerCount('dom-ready'), 0)
})

test('readiness drains a bounded GPU burst and leaves idle watchdogs free of socket polling', async () => {
  const f = fixture(); f.ready(); f.manager.setVisible(true)
  for (let n = 0; n < 20; n++) await f.tick(100)
  assert.equal(f.receiveCalls(), 0, 'health deadlines must not poll an idle socket')
  for (let n = 1; n <= 4; n++) f.packet(n, (n - 1) % 3)
  await f.tick()
  assert.equal(f.imports.length, 3); assert.equal(f.interest(), 0, 'full pool disables readable interest')
  f.release(); assert.equal(f.interest(), 2, 'only an outstanding ACK enables writable interest')
  await f.tick(); assert.deepEqual(f.acknowledgements, [1]); assert.equal(f.imports.length, 4)
  const stale = f.readiness()!; f.manager.destroy()
  const received = f.receiveCalls(); stale(0, 1); assert.equal(f.receiveCalls(), received)
  for (let n = 1; n < 4; n++) f.release(n)
})
test('readiness errors stop before descriptor cleanup and notify only once', () => {
  const f = fixture(), ready = f.readiness()!
  ready(-9, 0); ready(-9, 0)
  assert.equal(f.errors.length, 1); assert.equal(f.readiness(), undefined)
  assert.deepEqual(f.closed.slice().sort((a, b) => a - b), [10, 11])
})
