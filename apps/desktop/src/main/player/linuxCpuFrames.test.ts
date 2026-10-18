import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { BrowserWindow } from 'electron'

const code = transpileModule(readFileSync(new URL('./linuxCpuFrames.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText
const READY = 'playback:cpu-frame-ready', REMOVED = 'playback:cpu-frame-removed', RELEASE = 'playback:cpu-frame-release', FAILED = 'playback:cpu-frame-failed'
const bindingToken = '33333333-3333-4333-8333-333333333333'
const frame = (sequence = 1, slot = 0, extra: Record<string, unknown> = {}) => ({ protocol: 'javdex-cpu-frame-v1',
  sequence, slot, generation: 1, width: 320, height: 180, pixelFormat: 'rgba', stride: 1280, size: 230400, producerComplete: true, ...extra })
function fixture() {
  let nextFd = 100, now = 0, ackWritable = true, copyFails = false, sendFails = false
  let tick: () => void = () => {}
  const ipc = new EventEmitter(), closed: number[] = [], acknowledgements: number[] = [], copies: number[] = [], errors: Error[] = []
  const sent: Array<{ channel: string; metadata: Record<string, unknown>; pixels?: Buffer }> = []
  const incoming: Array<{ fd: number; metadata: Buffer }> = []
  const mainFrame = { send: (channel: string, metadata: Record<string, unknown>, pixels?: Buffer) => {
    if (sendFails && channel === 'playback:cpu-frame') throw new Error('send failed')
    sent.push({ channel, metadata, pixels })
  } }
  const contents = Object.assign(new EventEmitter(), { mainFrame, isDestroyed: () => false })
  const close = (fd: number): void => { assert.ok(!closed.includes(fd), `FD ${fd} must close exactly once`); closed.push(fd) }
  const transport = {
    createChannel: () => ({ parentFd: 10, childFd: 11 }), close,
    receive: () => incoming.shift() ?? null,
    copyFrame: (fd: number, size: number) => { copies.push(fd); close(fd); if (copyFails) throw new Error('invalid memfd'); return Buffer.alloc(size) },
    sendAck: (_fd: number, sequence: number) => { if (ackWritable) acknowledgements.push(sequence); return ackWritable }
  }
  const exports = {} as typeof import('./linuxCpuFrames')
  runInNewContext(code, { exports, Buffer, Date: { now: () => now },
    setInterval: (callback: () => void) => { tick = callback; return { unref() {} } }, clearInterval: () => { tick = () => {} },
    require(id: string): unknown {
      if (id === 'node:crypto') return { randomUUID: () => '11111111-1111-4111-8111-111111111111' }
      if (id === 'node:module') return { createRequire: () => () => transport }
      if (id === 'electron') return { ipcMain: ipc } // No sharedTexture or app/GPU APIs exist.
      throw new Error(`Unexpected dependency ${id}`)
    }
  })
  const manager = exports.createLinuxCpuFrames({ webContents: contents } as unknown as BrowserWindow, '/fixture/playback-fd.node', error => errors.push(error))
  const binding = { surfaceToken: manager.surfaceToken, bindingToken }, event = { sender: contents, senderFrame: mainFrame }
  return { manager, exports, ipc, contents, closed, copies, errors, acknowledgements, binding, event, sent,
    frames: () => sent.filter(item => item.channel === 'playback:cpu-frame'),
    ready: () => ipc.emit(READY, event, binding),
    release: (sequence = 1, extra: Record<string, unknown> = {}) => ipc.emit(RELEASE, event, { ...binding, sequence, generation: 1, outcome: 'drawn', ...extra }),
    packet: (sequence = 1, slot = 0, extra = {}) => incoming.push({ fd: ++nextFd, metadata: Buffer.from(JSON.stringify(frame(sequence, slot, extra))) }),
    tick: (advance = 0) => { now += advance; tick() },
    blockAck: () => { ackWritable = false }, allowAck: () => { ackWritable = true }, failCopy: () => { copyFails = true }, failSend: () => { sendFails = true }
  }
}

test('accepts only bounded tightly packed 720p RGBA CPU metadata and strips extra fields', t => {
  const f = fixture(); t.after(f.manager.destroy)
  assert.equal(f.exports.decodeCpuFrame(Buffer.from(JSON.stringify(frame()))).size, 230400)
  for (const invalid of [{ width: 0 }, { width: 1281 }, { height: 721 }, { height: 1.5 }, { stride: 1281 }, { size: 230401 },
    { generation: 0 }, { generation: 0x100000000 }, { sequence: 0 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { slot: 3 },
    { pixelFormat: 'bgra' }, { producerComplete: false }, { protocol: 'other' }]) {
    assert.throws(() => f.exports.decodeCpuFrame(Buffer.from(JSON.stringify(frame(1, 0, invalid)))))
  }
  assert.throws(() => f.exports.decodeCpuFrame(Buffer.alloc(4097)))
  assert.throws(() => f.exports.decodeCpuFrame(Buffer.from('null')))
  const clean = f.exports.decodeCpuFrame(Buffer.from(JSON.stringify(frame(1, 0, { fd: 4, url: 'private' }))))
  assert.equal('fd' in clean, false); assert.equal('url' in clean, false)
})
test('copies binary pixels without GPU APIs and ACKs only an authenticated draw/drop release', t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.manager.spawned(); f.manager.spawned(); assert.deepEqual(f.closed, [11])
  f.ipc.emit(READY, { ...f.event, senderFrame: {} }, f.binding)
  f.ipc.emit(READY, { ...f.event, sender: {} }, f.binding)
  assert.equal(f.manager.isReady(), false)
  f.ready(); f.manager.setVisible(true); f.packet(); f.tick()
  assert.equal(f.frames().length, 1); assert.ok(Buffer.isBuffer(f.frames()[0].pixels))
  assert.equal(f.frames()[0].pixels!.byteLength, 230400)
  assert.deepEqual(f.closed, [11, 101]); assert.deepEqual(f.acknowledgements, [])
  const reply = { ...f.binding, sequence: 1, generation: 1, outcome: 'drawn' }
  f.ipc.emit(RELEASE, { ...f.event, senderFrame: {} }, reply)
  f.release(1, { bindingToken: '44444444-4444-4444-8444-444444444444' })
  f.release(1, { generation: 2 }); f.release(1, { outcome: { toString: 1 } }); f.release(2); f.tick()
  assert.deepEqual(f.acknowledgements, []); assert.equal(f.manager.presentedFrames(), 0)
  f.release(); f.release(); f.tick()
  assert.deepEqual(f.acknowledgements, [1]); assert.equal(f.manager.presentedFrames(), 1)
})
test('at most three binary messages remain outstanding including releases blocked on producer ACK', t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  for (let i = 1; i <= 4; i++) f.packet(i, (i - 1) % 3)
  f.tick(); f.tick(); assert.equal(f.frames().length, 3)
  f.blockAck(); f.release(); f.tick(); assert.equal(f.frames().length, 3)
  assert.equal(f.manager.diagnostics().cpuFramesInFlight, 3)
  assert.equal(f.manager.diagnostics().poolMemoryBudgetBytes, 11059200)
  f.allowAck(); f.tick(); assert.equal(f.frames().length, 4)
  assert.deepEqual(f.acknowledgements, [1])
})
test('paused canvas holds no producer lease after synchronous draw and may remain paused indefinitely', t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true); f.packet(); f.tick(); f.release(); f.tick(); f.tick(60000)
  assert.equal(f.errors.length, 0); assert.equal(f.manager.diagnostics().cpuFramesInFlight, 0)
  assert.equal(f.manager.presentedFrames(), 1)
})
test('seek invalidates old generations immediately and drops queued old pixels without allocating', t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true); f.packet(); f.tick()
  assert.equal(f.manager.invalidateFrames(), 2)
  assert.equal(f.sent.at(-1)!.metadata.generation, 2)
  f.release(); f.tick(); assert.equal(f.manager.presentedFrames(), 0)
  f.packet(2, 1); f.packet(3, 2, { generation: 2 }); f.tick()
  assert.equal(f.frames().length, 2); assert.deepEqual(f.copies, [101, 103])
  f.release(3, { generation: 2 }); f.tick()
  assert.deepEqual(f.acknowledgements, [1, 2, 3]); assert.equal(f.manager.presentedFrames(), 1)
})
test('hide drops without pixel copies, while stale mounts release only their own frames', t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true); f.packet(); f.tick()
  const replacement = { ...f.binding, bindingToken: '44444444-4444-4444-8444-444444444444' }
  f.ipc.emit(READY, f.event, replacement); f.ipc.emit(REMOVED, f.event, f.binding)
  assert.equal(f.manager.isReady(), true)
  f.release(); f.tick(); assert.equal(f.manager.presentedFrames(), 0)
  f.packet(2, 1); f.tick(); assert.equal(f.frames()[1].metadata.bindingToken, replacement.bindingToken)
  f.release(2); f.tick(); assert.deepEqual(f.acknowledgements, [1])
  f.manager.setVisible(false)
  f.release(2, { bindingToken: replacement.bindingToken, outcome: 'dropped' }); f.packet(3, 2); f.tick(); f.tick()
  assert.deepEqual(f.acknowledgements, [1, 2, 3]); assert.deepEqual(f.copies, [101, 102])
  assert.equal(f.manager.presentedFrames(), 0)
  f.ipc.emit(REMOVED, f.event, replacement); assert.equal(f.manager.isReady(), false)
})
test('unreleased or blocked-ACK CPU frames fail closed instead of recycling a live lease', t => {
  for (const blocked of [false, true]) {
    const f = fixture(); t.after(f.manager.destroy)
    f.ready(); f.manager.setVisible(true); f.packet(); f.tick()
    if (blocked) { f.blockAck(); f.release() }
    f.tick(5001)
    assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /超时/)
    assert.deepEqual(f.acknowledgements, [])
    f.release(); f.tick(); assert.deepEqual(f.acknowledgements, [])
  }
})
test('reused slots, regressing sequences, copy failures and transfer failures close owned FDs once', t => {
  for (const failure of ['slot', 'sequence', 'metadata', 'copy', 'send']) {
    const f = fixture(); t.after(f.manager.destroy)
    f.ready(); f.manager.setVisible(true)
    if (failure === 'slot' || failure === 'sequence') { f.packet(); f.tick() }
    if (failure === 'sequence') { f.release(); f.tick() }
    if (failure === 'copy') f.failCopy()
    if (failure === 'send') f.failSend()
    f.packet(failure === 'slot' ? 2 : 1, failure === 'sequence' ? 1 : 0, failure === 'metadata' ? { size: 1 } : {})
    f.tick(); assert.equal(f.errors.length, 1, failure)
    assert.ok(f.closed.includes(failure === 'slot' || failure === 'sequence' ? 102 : 101))
    assert.ok(f.closed.includes(10)); assert.ok(f.closed.includes(11))
    assert.equal(f.ipc.listenerCount(RELEASE), 0)
  }
})
test('renderer crash, reload and authenticated receiver failure stop transport, unlike a GPU process exit', t => {
  for (const kind of ['reload', 'crash', 'failed']) {
    const f = fixture(); t.after(f.manager.destroy)
    f.ready(); f.manager.setVisible(true)
    f.contents.emit('did-start-navigation', {}, 'route', true, true)
    f.contents.emit('did-start-navigation', {}, 'frame', false, false)
    f.ipc.emit(FAILED, { ...f.event, senderFrame: {} }, f.binding)
    assert.equal(f.errors.length, 0)
    if (kind === 'reload') f.contents.emit('did-start-navigation', {}, 'app', false, true)
    if (kind === 'crash') f.contents.emit('render-process-gone')
    if (kind === 'failed') f.ipc.emit(FAILED, f.event, f.binding)
    assert.equal(f.errors.length, 1)
    assert.equal(f.ipc.listenerCount(READY), 0)
  }
})
test('receiver readiness times out only while a visible surface is requested', t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.tick(60000); assert.equal(f.errors.length, 0)
  f.manager.setVisible(true); f.tick(10001); assert.equal(f.errors.length, 1)
})

test('hidden full CPU pools keep leases without timeout and resume with a fresh release deadline', t => {
  const f = fixture(); t.after(f.manager.destroy)
  f.ready(); f.manager.setVisible(true)
  for (let sequence = 1; sequence <= 3; sequence++) f.packet(sequence, sequence - 1)
  f.tick(); f.tick(4000)
  f.manager.setVisible(false); f.tick(60000)
  assert.equal(f.errors.length, 0); assert.deepEqual(f.acknowledgements, [])
  assert.equal(f.manager.diagnostics().cpuFramesInFlight, 3)
  f.manager.setVisible(true); f.tick(4000); assert.equal(f.errors.length, 0)
  for (let sequence = 1; sequence <= 3; sequence++) f.release(sequence, { outcome: 'dropped' })
  f.tick(); assert.deepEqual(f.acknowledgements, [1, 2, 3])
})
