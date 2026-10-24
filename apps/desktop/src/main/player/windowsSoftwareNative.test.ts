import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { test } from 'node:test'

const file = path.resolve('out/native-playback/playback.node')
test('real Windows CPU producer bounds frames, clears padding and survives a rejected worker import', {
  skip: process.platform !== 'win32' || !existsSync(file) ? 'requires the compiled Windows playback addon' : false,
  timeout: 10000
}, async t => {
  const native = createRequire(import.meta.url)(file).software as {
    create(bounds: { width: number; height: number; scale: number }): void
    setBounds(bounds: { width: number; height: number; scale: number }): void
    setVisible(value: boolean): void
    nextFrame(writable: boolean): { width: number; height: number; stride: number; pixels: Buffer }
    inspect(): { alive: boolean; pixelWidth: number; pixelHeight: number }
    destroy(): void
  }
  t.after(() => native.destroy())
  assert.equal(native.inspect().alive, false)
  assert.throws(() => native.create({ width: -1, height: 1, scale: 1 }), /bounds/)
  native.create({ width: 3840, height: 2160, scale: 2 })
  assert.equal(native.inspect().pixelWidth, 7680); assert.equal(native.inspect().pixelHeight, 4320)
  native.setBounds({ width: 8192, height: 8192, scale: 1 })
  assert.equal(native.inspect().pixelWidth, 8192); assert.equal(native.inspect().pixelHeight, 8192)
  assert.throws(() => native.setBounds({ width: 8193, height: 1, scale: 1 }), /dimensions/)
  assert.throws(() => native.setBounds({ width: 1, height: 8193, scale: 1 }), /dimensions/)
  assert.throws(() => native.setBounds({ width: 1, height: 1, scale: 9 }), /bounds/)
  native.setBounds({ width: 1200.4, height: 700.4, scale: 1.75 })
  assert.equal(native.inspect().pixelWidth, 2101); assert.equal(native.inspect().pixelHeight, 1226)
  native.setBounds({ width: 3840, height: 2160, scale: 1 }); native.setVisible(true)
  const fullFrame = native.nextFrame(true)
  assert.equal(fullFrame.width, 3840); assert.equal(fullFrame.height, 2160)
  assert.equal(fullFrame.pixels.length, fullFrame.stride * 2160)
  native.destroy(); native.create({ width: 17, height: 2, scale: 1 }); native.setVisible(true)
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
  await exited; assert.match(message, /worker thread/)
  assert.equal(native.inspect().alive, true, 'rejected worker cleanup cannot stop the owner session')
  native.destroy(); assert.equal(native.inspect().alive, false); assert.equal(native.inspect().pixelWidth, 0)
})
