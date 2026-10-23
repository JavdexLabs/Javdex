import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

// Explicit native run only: no silently substituted CPU/GL mock in ordinary CI.
test('macOS IOSurface producer bounds leases across resize, reset, destroy and reopen', {
  skip: process.platform !== 'darwin' || !process.env.JAVDEX_TEST_MAC_SHARED_NATIVE
    ? 'requires a compiled macOS IOSurface addon and real OpenGL device' : false
}, () => {
  const native = createRequire(import.meta.url)(process.env.JAVDEX_TEST_MAC_SHARED_NATIVE!) as {
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
