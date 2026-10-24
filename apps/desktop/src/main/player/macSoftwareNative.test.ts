import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'

const file = path.resolve(process.env.JAVDEX_TEST_MAC_PLAYBACK_NATIVE ?? 'out/native-playback/playback.node')
if (process.platform === 'darwin' && process.env.JAVDEX_TEST_MAC_PLAYBACK_NATIVE)
  assert.ok(existsSync(file), 'explicit native test input must exist')
test('real macOS CPU producer renders copied RGBA without a GL session and rejects foreign workers', {
  skip: process.platform !== 'darwin' || !existsSync(file) ? 'requires the compiled macOS playback addon' : false,
  timeout: 10000
}, async t => {
  const addon = createRequire(import.meta.url)(file)
  assert.equal(typeof addon.software?.create, 'function', 'macOS needs an independent CPU renderer')
  const native = addon.software as {
    create(bounds: { width: number; height: number; scale: number }): void
    setBounds(bounds: { width: number; height: number; scale: number }): void
    setVisible(value: boolean): void
    nextFrame(writable: boolean): { sequence: number; width: number; height: number; stride: number; pixels: Buffer }
    inspect(): { alive: boolean; backend: string; pixelWidth: number; pixelHeight: number }
    destroy(): void
  }
  t.after(() => native.destroy())
  assert.equal(native.inspect().alive, false)
  assert.throws(() => native.create({ width: -1, height: 1, scale: 1 }), /bounds/)
  native.create({ width: 3840, height: 2160, scale: 2 })
  assert.equal(native.inspect().backend, 'macos-software')
  assert.equal(native.inspect().pixelWidth, 7680)
  assert.equal(native.inspect().pixelHeight, 4320)
  assert.equal(addon.inspect().alive, false, 'software playback cannot initialize CGL/IOSurface')
  assert.throws(() => native.setBounds({ width: 8193, height: 1, scale: 1 }), /dimensions/)
  native.setBounds({ width: 17, height: 2, scale: 1 }); native.setVisible(true)
  assert.equal(native.nextFrame(false), undefined, 'backpressure cannot publish a frame')
  const frame = native.nextFrame(true)
  assert.equal(frame.width, 17); assert.equal(frame.height, 2); assert.equal(frame.stride, 128)
  for (let y: number = 0; y < frame.height; y++) {
    for (let x: number = 0; x < frame.width; x++) assert.equal(frame.pixels[y * frame.stride + x * 4 + 3], 255)
    for (let x: number = frame.width * 4; x < frame.stride; x++) assert.equal(frame.pixels[y * frame.stride + x], 0)
  }
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
    try {require(workerData);parentPort.postMessage('loaded')} catch(e){parentPort.postMessage(e.message)}`, {
    eval: true, execArgv: [], workerData: file
  })
  const exited = new Promise(resolve => worker.once('exit', resolve))
  const message = await new Promise<string>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
  await exited; assert.match(message, /main thread|worker thread/)
  assert.equal(native.inspect().alive, true, 'foreign worker teardown cannot stop CPU playback')
  native.destroy(); assert.equal(native.inspect().alive, false)
  native.create({ width: 17, height: 2, scale: 1 }); native.setVisible(true)
  assert(native.nextFrame(true).sequence > frame.sequence, 'reopen does not recycle frame identities')
})
