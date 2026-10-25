import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

const enabled = process.platform === 'win32' && process.env.JAVDEX_NATIVE_GPU_TESTS === '1'
test('Windows pending GPU output preserves its original timing when the active timeline changes', {
  skip: enabled ? false : 'requires an explicit real Windows GPU acceptance run'
}, async () => {
  const native = createRequire(import.meta.url)(path.resolve('out/native-playback/playback.node')).sharedTexture
  let frame: { sequence: number; timeline: number; renderStartUs: number; targetTimeUs: number } | undefined
  try {
    native.create({ width: 640, height: 360, scale: 1 }); native.setVisible(true)
    native.resetTiming(1); native.requestSelfTest()
    // The first call submits producer work. Reset the
    // timeline before collecting it, irrespective of how quickly the GPU runs.
    assert.equal(native.nextFrame(), undefined)
    native.resetTiming(2)
    const deadline = Date.now() + 3000
    while (!frame && Date.now() < deadline) { frame = native.nextFrame(); if (!frame) await delay(1) }
    assert.ok(frame, 'the actual producer completion boundary must finish')
    assert.equal(frame.timeline, 1)
    assert.ok(frame.renderStartUs > 0, 'reset cannot erase an outstanding frame timestamp')
    assert.equal(frame.targetTimeUs, 0, 'the synthetic redraw has no presentation delay')
  } finally { if (frame) native.releaseFrame(frame.sequence); native.destroy() }
})

test('Windows shared output preserves leases across backpressure, resize and session replacement', {
  skip: enabled ? false : 'requires an explicit real Windows GPU acceptance run'
}, async () => {
  const native = createRequire(import.meta.url)(path.resolve('out/native-playback/playback.node')).sharedTexture
  type Frame = { sequence: number; resourceId: number; slot: number; width: number; height: number; timeline: number }
  const held: Frame[] = []
  async function probeFrame() {
    native.requestSelfTest()
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const frame: Frame | undefined = native.nextFrame()
      if (frame) { held.push(frame); return frame }
      await delay(1)
    }
    assert.fail('producer completion must finish')
  }
  function release(frame: Frame) {
    native.releaseFrame(frame.sequence)
    held.splice(held.indexOf(frame), 1)
  }
  try {
    native.create({ width: 800, height: 450, scale: 1 }); native.setVisible(true); native.resetTiming(1)
    const first = await probeFrame(), second = await probeFrame(), third = await probeFrame()
    assert.equal(new Set(held.map(frame => frame.slot)).size, 3)
    assert.equal(native.inspect().outstandingSurfaces, 3)
    native.setBounds({ width: 960, height: 540, scale: 1 }); native.resetTiming(2)
    native.requestSelfTest()
    for (let i = 0; i < 10; ++i) { assert.equal(native.nextFrame(), undefined); await delay(1) }
    release(second)
    // Ordinary output after the probe must allocate the requested viewport,
    // while the two outstanding probe resources retain their original lease.
    const resizedProbe = await probeFrame()
    assert.equal(resizedProbe.slot, second.slot)
    assert.equal(resizedProbe.resourceId, second.resourceId, 'same-size probe reuses its free surface')
    release(resizedProbe)
    let resized: Frame | undefined
    const deadline = Date.now() + 3000
    while (!resized && Date.now() < deadline) { resized = native.nextFrame(); if (!resized) await delay(1) }
    assert.ok(resized); held.push(resized)
    assert.equal(resized.slot, second.slot)
    assert.notEqual(resized.resourceId, second.resourceId, 'resize allocates a new resource identity')
    assert.equal(resized.width, 960); assert.equal(resized.height, 540); assert.equal(resized.timeline, 2)
    release(resized)
    native.destroy()
    native.create({ width: 640, height: 360, scale: 1 }); native.setVisible(true); native.resetTiming(1)
    const replacement = await probeFrame()
    assert.equal(replacement.slot, second.slot, 'old session leases cannot be reused by its replacement')
    assert.notEqual(replacement.resourceId, second.resourceId)
    release(first); release(third)
    const more = await probeFrame()
    assert.ok(more.resourceId > replacement.resourceId, 'late releases retire old generation resources')
    const state = native.inspect()
    assert.equal(state.producerBackend, 'angle-d3d11')
    assert.equal(state.producerOutput, 'direct-shared')
    assert.equal(state.producerSynchronization, 'gl-finish')
    assert.ok(state.directOutputFrames > 0)
    assert.equal(state.producerTimings.glFinishWait.samples, state.directOutputFrames)
  } finally {
    for (const frame of held) native.releaseFrame(frame.sequence)
    native.destroy()
  }
})

test('Windows native adapter selection requires one exact hardware match', {
  skip: enabled ? false : 'requires an explicit real Windows GPU acceptance run'
}, () => {
  const native = createRequire(import.meta.url)(path.resolve('out/native-playback/playback.node')).sharedTexture
  try {
    assert.throws(() => native.create({ width: 640, height: 360, scale: 1 }, { vendorId: 0xffff, deviceId: 0xfffe }), /missing or ambiguous/)
    native.create({ width: 640, height: 360, scale: 1 })
    const identity = native.inspect(); native.destroy()
    native.create({ width: 640, height: 360, scale: 1 }, { vendorId: identity.producerVendorId, deviceId: identity.producerDeviceId,
      adapterLuidLow: identity.producerAdapterLuidLow, adapterLuidHigh: identity.producerAdapterLuidHigh })
    const selected = native.inspect()
    assert.equal(selected.producerAdapterSelection, 'chromium-active-pci')
    assert.equal(selected.producerAdapterLuidLow, identity.producerAdapterLuidLow)
    assert.equal(selected.producerAdapterLuidHigh, identity.producerAdapterLuidHigh)
  } finally { native.destroy() }
})
