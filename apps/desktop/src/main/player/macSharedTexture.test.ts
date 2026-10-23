import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import type { BrowserWindow } from 'electron'
import { FrameBudget } from './frameBudget'
import { channel } from 'node:diagnostics_channel'

function fixture() {
  const code = transpileModule(readFileSync(new URL('./macSharedTexture.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
  }).outputText
  let tick = () => {}, wake = () => {}, sequence = 0, timeline = 0, created = false, mainReleases = 0, sendFailure = false, flushFailure = false
  const ipc = new EventEmitter(), app = new EventEmitter(), mainFrame = {}
  const messages: Array<{ channel: string; value: Record<string, unknown> }> = []
  const contents = Object.assign(new EventEmitter(), { mainFrame, isDestroyed: () => false,
    send: (channel: string, value: Record<string, unknown>) => {
      if (sendFailure && channel === 'playback:mac-texture-transfer') throw Error('delivery unknown')
      if (flushFailure && channel === 'playback:frame-flush') throw Error('frame already disposed')
      messages.push({ channel, value })
    } })
  const event = { sender: contents, senderFrame: mainFrame }
  const releases: number[] = [], imported: Array<{ allReferencesReleased: () => void }> = [], held = new Set<number>()
  const native = { create() { created = true }, destroy() { created = false }, setBounds() {}, setVisible() {},
    setWakeup(callback: (() => void) | null) { wake = callback ?? (() => {}) },
    resetTiming(value: number) { timeline = value }, setRenderBudget() {}, command() {}, generatedSubtitles() {},
    inspect: () => ({ alive: created }), state: () => ({ alive: created }),
    nextFrame() { if (held.size >= 3) return; held.add(++sequence); return { sequence, timeline, width: 640, height: 360, ioSurface: Buffer.alloc(8),
      producerComplete: true, pixelFormat: 'bgra', colorContract: 'bt709-srgb-rgb-full', renderStartUs: 1, targetTimeUs: 0 } },
    releaseFrame(value: number) { releases.push(value); held.delete(value) } }
  const exports = {} as typeof import('./macSharedTexture')
  runInNewContext(code, { exports, Buffer, process: { hrtime: { bigint: () => 1000000000n }, env: {} }, Date,
    setInterval: (callback: () => void) => { tick = callback; return { unref() {} } }, clearInterval() {},
    require(name: string) {
      if (name === 'node:diagnostics_channel') return { channel }
      if (name === './frameBudget') return { FrameBudget }
      if (name === 'node:crypto') return { randomUUID: () => '11111111-1111-4111-8111-111111111111' }
      if (name === 'electron') return { app, ipcMain: ipc, sharedTexture: {
        importSharedTexture(value: typeof imported[number]) { imported.push(value); return { release() { mainReleases++ }, subtle: { startTransferSharedTexture: () => ({ transfer: 'opaque' }) } } },
        async sendSharedTexture() {}
      } }
      throw Error(name)
    } })
  const bridge = exports.createMacSharedTextureBridge(native, { webContents: contents } as unknown as BrowserWindow)
  bridge.create(Buffer.alloc(0), { width: 640, height: 360, scale: 1 })
  const binding = { surfaceToken: bridge.inspect().sharedTextureSurface!, bindingToken: '33333333-3333-4333-8333-333333333333' }
  ipc.emit('playback:shared-texture-ready', event, binding); bridge.setVisible(true)
  return { bridge, native, ipc, app, event, binding, messages, imported, releases, failFlush: () => { flushFailure = true }, failTransfer: () => { sendFailure = true }, mainReleases: () => mainReleases,
    wake: async () => { wake(); await Promise.resolve(); await Promise.resolve() }, tick: async () => { tick(); await Promise.resolve(); await Promise.resolve() } }
}
test('native wakeups drain new frames without waiting for a watchdog and are detached at teardown', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 3; i++) await f.wake()
    assert.equal(f.imported.length, 3, 'frame cadence is driven by callbacks, not a periodic render cap')
    f.bridge.destroy(); await f.wake()
    assert.equal(f.imported.length, 3)
  } finally {
    f.bridge.destroy()
    for (const item of f.imported) item.allReferencesReleased()
  }
})
test('main-only statistics reuse submission counters and detach on destroy', async () => {
  const f = fixture(), stats = channel('javdex.playback.mac-shared-texture.statistics')
  try {
    await f.tick()
    const request: Record<string, unknown> = {}
    stats.publish(request)
    assert.equal(request.pendingFrames, 1)
    assert.equal(request.submittedFrames, 0)
    assert.deepEqual(Object.keys(request).sort(), ['frameTimeline', 'pendingFrames', 'renderBudgetMs', 'submissionLatenessMs', 'submittedFrames'])
    stats.publish(Object.freeze({}))
  } finally { f.bridge.destroy() }
  const stopped = {}; stats.publish(stopped); assert.deepEqual(stopped, {})
  for (const item of f.imported) item.allReferencesReleased()
})
test('macOS IOSurface slots wait for all references, not Canvas submission or send completion', async t => {
  const f = fixture(); t.after(f.bridge.destroy)
  await f.tick(); await f.tick(); await f.tick(); await f.tick()
  assert.equal(f.imported.length, 3); assert.deepEqual(f.releases, [])
  const submission = { ...f.binding, sequence: 3, timeline: f.bridge.inspect().frameTimeline }
  f.ipc.emit('playback:shared-texture-submitted', { ...f.event, senderFrame: {} }, submission)
  assert.equal(f.bridge.inspect().submittedFrames, 0)
  f.ipc.emit('playback:shared-texture-submitted', f.event, submission)
  assert.equal(f.bridge.inspect().submittedFrames, 1); assert.deepEqual(f.releases, [])
  assert.equal(f.mainReleases(), 0, 'send and Canvas submit cannot release the source reference')
  f.ipc.emit('playback:mac-texture-released', { ...f.event, senderFrame: {} }, { ...f.binding, sequence: 1 })
  assert.equal(f.mainReleases(), 0)
  f.ipc.emit('playback:mac-texture-released', f.event, { ...f.binding, sequence: 1 })
  f.ipc.emit('playback:mac-texture-released', f.event, { ...f.binding, sequence: 1 })
  assert.equal(f.mainReleases(), 1, 'GPU-complete ACK drops the source reference once')
  assert.deepEqual(f.releases, [], 'native lease still waits for source GPU release callback')
  f.imported[0].allReferencesReleased(); await f.tick()
  assert.deepEqual(f.releases, [1]); assert.equal(f.imported.length, 4)
  f.bridge.destroy()
  for (const item of f.imported) { item.allReferencesReleased(); item.allReferencesReleased() }
  assert.deepEqual(f.releases, [1, 2, 3, 4], 'late callbacks release only their original tickets once')
})
test('macOS hide/restore and seeks invalidate old work, and GPU failure is terminal without CPU substitution', async t => {
  const f = fixture(); t.after(f.bridge.destroy)
  const before = f.bridge.inspect().frameTimeline!
  f.bridge.setVisible(false); f.bridge.setVisible(true); f.bridge.command(['seek', '12', 'absolute'])
  assert.ok(f.bridge.inspect().frameTimeline! > before)
  assert.ok(f.messages.some(m => m.channel === 'playback:frame-flush'))
  f.app.emit('child-process-gone', {}, { type: 'GPU' })
  assert.throws(() => f.bridge.render(), /GPU/)
  assert.throws(() => f.bridge.render(), { code: 'PLAYBACK_RESTART_REQUIRED' })
})
test('uncertain delivery quarantines the lease until a real consumer GPU release arrives', async t => {
  const f = fixture(); t.after(f.bridge.destroy); f.failTransfer(); await f.tick()
  assert.throws(() => f.bridge.render(), /导入或传输失败/)
  assert.equal(f.mainReleases(), 0); assert.deepEqual(f.releases, [])
  f.ipc.emit('playback:mac-texture-released', f.event, { ...f.binding, sequence: 1 })
  assert.equal(f.mainReleases(), 1)
  f.imported[0].allReferencesReleased(); assert.deepEqual(f.releases, [1])
})
test('destroy still tears down the native producer if the page cannot receive a flush', () => {
  const f = fixture(); f.failFlush()
  assert.doesNotThrow(() => f.bridge.destroy())
  assert.equal(f.native.inspect().alive, false)
})
test('invalid fresh metadata releases its unimported lease, but duplicate held tickets stay consumer-owned', async t => {
  for (const duplicate of [false, true]) {
    const f = fixture(); t.after(f.bridge.destroy)
    const next = f.native.nextFrame.bind(f.native)
    if (duplicate) await f.tick()
    f.native.nextFrame = () => ({ ...next(), ...(duplicate ? { sequence: 1 } : {}), pixelFormat: 'invalid' }) as never
    await f.tick()
    assert.throws(() => f.bridge.render(), /生产失败/)
    assert.deepEqual(f.releases, duplicate ? [] : [1])
    for (const imported of f.imported) imported.allReferencesReleased()
    if (duplicate) assert.deepEqual(f.releases, [1])
  }
})
