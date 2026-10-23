import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import path from 'node:path'

const addon = path.resolve(process.env.JAVDEX_TEST_MAC_PLAYBACK_NATIVE ?? 'out/native-playback/playback.node')
if (process.platform === 'darwin' && process.env.JAVDEX_TEST_MAC_PLAYBACK_NATIVE) assert.ok(existsSync(addon), 'explicit native test input must exist')
const enabled = process.platform === 'darwin' && existsSync(addon)

test('the main-process IOSurface dispatcher cannot be initialized by a worker environment', {
  timeout: 5000,
  skip: !enabled
    ? 'requires a compiled macOS IOSurface addon' : false
}, async t => {
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
    try { require(workerData); parentPort.postMessage('loaded'); }
    catch (error) { parentPort.postMessage(error.message); }`, {
    eval: true, execArgv: [], workerData: addon
  })
  t.after(() => worker.terminate())
  const exited = new Promise(resolve => worker.once('exit', resolve))
  const result = await new Promise<string>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
  await exited
  assert.match(result, /main thread/, 'another Node environment cannot replace the main dispatcher')
})

// Native run uses the normal compiled addon, never a substituted CPU/GL mock.
test('macOS IOSurface producer bounds leases across resize, reset, destroy and reopen', {
  skip: !enabled
    ? 'requires a compiled macOS IOSurface addon and real OpenGL device' : false
}, () => {
  const native = createRequire(import.meta.url)(addon) as {
    create(bounds: { width: number; height: number; scale: number }): void
    setBounds(bounds: { width: number; height: number; scale: number }): void
    setVisible(value: boolean): void
    resetTiming(timeline: number): void
    setRenderBudget(ms: number): void
    nextFrame(pattern: boolean): { sequence: number; timeline: number; width: number; height: number; ioSurface: Buffer; producerComplete: boolean; colorContract: string } | undefined
    releaseFrame(sequence: number): void
    inspect(): { outstandingSurfaces: number; alive: boolean }
    destroy(): void
  }
  const held: number[] = []
  try {
    native.create({ width: 320, height: 180, scale: 2 }); native.setVisible(true)
    for (const value of [7, 41, NaN]) assert.throws(() => native.setRenderBudget(value), /budget/)
    native.setRenderBudget(20)
    for (let i = 0; i < 3; i++) {
      const frame = native.nextFrame(true)!
      assert.ok(frame); assert.equal(frame.ioSurface.length, 8)
      assert.equal(frame.width, 640); assert.equal(frame.height, 360)
      assert.equal(frame.producerComplete, true); held.push(frame.sequence)
      assert.equal(frame.colorContract, 'bt709-srgb-rgb-full')
    }
    assert.equal(native.nextFrame(true), undefined, 'held IOSurfaces cannot be overwritten')
    native.resetTiming(1); native.setBounds({ width: 800, height: 450, scale: 1 })
    native.releaseFrame(held.shift()!)
    const resized = native.nextFrame(true)!
    assert.equal(resized.timeline, 1); assert.equal(resized.width, 800); held.push(resized.sequence)
    native.setVisible(false); assert.equal(native.nextFrame(true), undefined)
    native.destroy(); assert.equal(native.inspect().alive, false)
    assert.equal(native.inspect().outstandingSurfaces, 3, 'destroy retains outstanding consumer leases')
    native.create({ width: 320, height: 180, scale: 1 }); native.setVisible(true)
    assert.equal(native.nextFrame(true), undefined, 'reopening cannot exceed the process-wide lease bound')
    for (const sequence of held.splice(0)) { native.releaseFrame(sequence); native.releaseFrame(sequence) }
    const reopened = native.nextFrame(true)!
    assert.ok(reopened.sequence > resized.sequence); held.push(reopened.sequence)
  } finally {
    native.destroy()
    for (const sequence of held) native.releaseFrame(sequence)
  }
  assert.equal(native.inspect().outstandingSurfaces, 0)
})

test('macOS callbacks pump non-video events, coalesce redraws and cannot call a closed session', {
  skip: !enabled
    ? 'requires a compiled macOS IOSurface addon and real OpenGL device' : false
}, async () => {
  const native = createRequire(import.meta.url)(addon) as {
    create(bounds: { width: number; height: number; scale: number }): void
    setBounds(bounds: { width: number; height: number; scale: number }): void
    setWakeup(callback: (() => void) | null): void
    command(args: string[]): void
    nextFrame(): unknown
    inspect(): { volume: number; outstandingSurfaces: number }
    destroy(): void
  }
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2000
    while (!predicate() && Date.now() < deadline) await delay(5)
    assert.ok(predicate(), 'native wakeup must arrive without polling nextFrame')
  }
  const counts = [0, 0, 0, 0, 0]
  try {
    for (let session = 0; session < counts.length; session++) {
      native.create({ width: 320, height: 180, scale: 1 })
      native.setWakeup(() => { counts[session]++; native.nextFrame() })
      await until(() => counts[session] > 0)
      await delay(30)
      const before = counts[session]
      native.command(['set', 'volume', String(31 + session)])
      await until(() => counts[session] > before && native.inspect().volume === 31 + session)
      await delay(30)
      const redraws = counts[session]
      for (let i = 0; i < 100; i++) native.setBounds({ width: 321 + i, height: 180, scale: 1 })
      await until(() => counts[session] > redraws)
      assert.ok(counts[session] - redraws < 5, 'a synchronous burst is coalesced, not one JS call per notification')
      native.setWakeup(null)
      const closed = [...counts]
      native.command(['set', 'volume', '12'])
      native.destroy(); await delay(30)
      assert.deepEqual(counts, closed, 'queued work cannot invoke a detached callback')
      assert.equal(native.inspect().outstandingSurfaces, 0)
    }
  } finally { native.setWakeup?.(null); native.destroy() }
})
