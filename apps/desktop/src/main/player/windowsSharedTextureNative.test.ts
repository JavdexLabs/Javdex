import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

const enabled = process.platform === 'win32' && process.env.JAVDEX_NATIVE_GPU_TESTS === '1'
test('Windows pending GPU copy preserves its original timing when the active timeline changes', {
  skip: enabled ? false : 'requires an explicit real Windows GPU acceptance run'
}, async () => {
  const native = createRequire(import.meta.url)(path.resolve('out/native-playback/playback.node')).sharedTexture
  let frame: { sequence: number; timeline: number; renderStartUs: number; targetTimeUs: number } | undefined
  try {
    native.create({ width: 640, height: 360, scale: 1 }); native.setVisible(true)
    native.resetTiming(1); native.requestSelfTest()
    // The first call submits CopyResource and its completion query. Reset the
    // timeline before collecting it, irrespective of how quickly the GPU runs.
    assert.equal(native.nextFrame(), undefined)
    native.resetTiming(2)
    const deadline = Date.now() + 3000
    while (!frame && Date.now() < deadline) { frame = native.nextFrame(); if (!frame) await delay(1) }
    assert.ok(frame, 'the actual D3D11 completion query must finish')
    assert.equal(frame.timeline, 1)
    assert.ok(frame.renderStartUs > 0, 'reset cannot erase an outstanding frame timestamp')
    assert.equal(frame.targetTimeUs, 0, 'the synthetic redraw has no presentation delay')
  } finally { if (frame) native.releaseFrame(frame.sequence); native.destroy() }
})
