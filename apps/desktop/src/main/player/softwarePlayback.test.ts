import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { BrowserWindow } from 'electron'
import type { SoftwareProducer } from './softwarePlayback'

const code = transpileModule(readFileSync(new URL('./softwarePlayback.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText
const bindingToken = '22222222-2222-4222-8222-222222222222'
function softwareFixture(platform: 'darwin' | 'win32') {
  const ipc = new EventEmitter(), contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
    send: (name: string, data: unknown) => messages.push({ name, data: data as Record<string, unknown> }) })
  const messages: Array<{ name: string; data: Record<string, unknown> }> = [], budgets: boolean[] = []
  let poll = () => {}, now = 1000, sequence = 0, destroys = 0
  const native: SoftwareProducer = {
    create() {}, setBounds() {}, setVisible() {},
    nextFrame(writable) {
      budgets.push(writable)
      return writable ? { sequence: ++sequence, width: 1, height: 1, stride: 64, size: 64, delayUs: 0, pixels: Buffer.alloc(64) } : undefined
    },
    command() {}, generatedSubtitles() {}, state: () => ({ alive: true }), inspect: () => ({ alive: true }), destroy: () => { destroys++ }
  }
  const exports = {} as typeof import('./softwarePlayback')
  runInNewContext(code, { exports, Buffer, process, Date: { now: () => now },
    setInterval: (callback: () => void) => { poll = callback; return { unref() {} } }, clearInterval() {},
    require(id: string) {
      if (id === 'electron') return { ipcMain: ipc }
      if (id === 'node:crypto') return { randomUUID: () => '11111111-1111-4111-8111-111111111111' }
      throw new Error(id)
    }
  })
  const bridge = exports.createSoftwarePlaybackBridge(native, { webContents: contents } as unknown as BrowserWindow, platform)
  bridge.create(Buffer.alloc(0), { width: 10, height: 10, scale: 1 })
  const binding = { surfaceToken: bridge.state().sharedTextureSurface!, bindingToken }
  const emit = (name: string, data: unknown = binding, trusted = true): void => {
    ipc.emit(name, { sender: trusted ? contents : {}, senderFrame: contents.mainFrame }, data)
  }
  const ready = (): void => { emit('playback:shared-texture-ready'); bridge.setVisible(true) }
  return { bridge, native, messages, budgets, ipc, contents, emit, ready, binding,
    poll: () => poll(), advance: (ms: number) => { now += ms }, destroys: () => destroys }
}
for (const platform of ['darwin', 'win32'] as const) {
  const fixture = () => softwareFixture(platform)
  test(`${platform}: CPU transport waits for its own trusted renderer binding and limits copied frames to two`, t => {
    const f = fixture(); t.after(f.bridge.destroy)
    f.bridge.setVisible(true); f.poll(); assert.equal(f.budgets.at(-1), false)
    f.emit('playback:shared-texture-ready', f.binding, false); f.poll(); assert.equal(f.budgets.at(-1), false)
    f.ready(); f.poll(); f.poll(); f.poll()
    assert.equal(f.messages.filter(v => v.name === 'playback:cpu-frame').length, 2)
    assert.equal(f.budgets.at(-1), false)
    f.emit('playback:cpu-frame-released', { ...f.binding, sequence: 1 }, false); f.poll(); assert.equal(f.budgets.at(-1), false)
    f.emit('playback:cpu-frame-released', { ...f.binding, sequence: 1 }); f.poll(); assert.equal(f.budgets.at(-1), true)
  })
  test(`${platform}: CPU receipts count only submitted current-timeline frames and reject forged/stale acknowledgements`, t => {
    const f = fixture(); t.after(f.bridge.destroy); f.ready(); f.poll()
    const frame = f.messages.find(v => v.name === 'playback:cpu-frame')!.data
    f.emit('playback:shared-texture-submitted', frame, false); assert.equal(f.bridge.state().submittedFrames, 0)
    f.emit('playback:shared-texture-submitted', frame); assert.equal(f.bridge.state().submittedFrames, 1)
    f.emit('playback:shared-texture-submitted', frame); assert.equal(f.bridge.state().submittedFrames, 1)
    f.bridge.command(['seek', '2', 'absolute+exact'])
    f.emit('playback:shared-texture-submitted', frame); assert.equal(f.bridge.state().submittedFrames, 1)
  })
  test(`${platform}: late removal cannot unbind a replacement CPU canvas; removed copies do not lease native memory`, t => {
    const f = fixture(); t.after(f.bridge.destroy); f.ready(); f.poll(); f.poll()
    const replacement = { ...f.binding, bindingToken: '33333333-3333-4333-8333-333333333333' }
    f.emit('playback:shared-texture-ready', replacement); f.emit('playback:shared-texture-removed', f.binding)
    f.poll(); assert.equal(f.budgets.at(-1), true)
    f.emit('playback:shared-texture-removed', replacement); f.poll(); assert.equal(f.budgets.at(-1), false)
  })
  test(`${platform}: stalled CPU consumers fail with bounded memory and detach all listeners`, () => {
    const f = fixture(); f.ready(); f.poll(); f.poll(); f.advance(5001); f.poll()
    assert.throws(() => f.bridge.state(), /消费超时/); assert.equal(f.destroys(), 1)
    assert.equal(f.ipc.eventNames().length, 0); assert.equal(f.contents.eventNames().length, 0)
    f.bridge.destroy(); assert.equal(f.destroys(), 1)
  })
  test(`${platform}: invalid native CPU metadata fails closed before publishing pixels`, () => {
    const f = fixture(); f.ready()
    f.native.nextFrame = () => ({ sequence: 1, width: 9000, height: 1, stride: 64, size: 64, delayUs: 0, pixels: Buffer.alloc(64) })
    f.poll(); assert.throws(() => f.bridge.state(), /Invalid .* CPU frame/)
    assert.equal(f.messages.filter(v => v.name === 'playback:cpu-frame').length, 0)
    assert.equal(f.destroys(), 1)
  })

  test(`${platform}: CPU transport accepts full 4K frames without the former 1080p limit`, t => {
    const f = fixture(); t.after(f.bridge.destroy); f.ready()
    const pixels = Buffer.alloc(3840 * 2160 * 4)
    f.native.nextFrame = () => ({ sequence: 1, width: 3840, height: 2160, stride: 15360, size: pixels.length, delayUs: 0, pixels })
    f.poll()
    const frame = f.messages.find(v => v.name === 'playback:cpu-frame')!.data
    assert.equal(frame.width, 3840); assert.equal(frame.height, 2160)
    assert.equal(f.bridge.state().alive, true)
  })

  test(`${platform}: CPU transport rejects unaligned rows under the Linux-compatible wire bounds`, () => {
    const f = fixture(); f.ready()
    f.native.nextFrame = () => ({ sequence: 1, width: 17, height: 1, stride: 68, size: 68, delayUs: 0, pixels: Buffer.alloc(68) })
    f.poll(); assert.throws(() => f.bridge.state(), /Invalid .* CPU frame/)
    assert.equal(f.destroys(), 1)
  })
}
