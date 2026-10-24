import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkLoadProduction } from './playback-load-quality.mjs'

const stage = (frames, drops = 0) => ({ positionAdvance: 8, droppedFrames: drops, samples: [
  { elapsed: 1000, hosts: { cpu: { nativeFrames: 30 } } },
  { elapsed: 8000, hosts: { cpu: { nativeFrames: 30 + frames } } }
] })
test('an advancing audio clock and zero drops cannot disguise insufficient video production', () => {
  assert.throws(() => checkLoadProduction(stage(140), 'cpu', 30), /below source cadence/)
})
test('source cadence cannot disguise the previous 49 dropped frames', () => {
  assert.throws(() => checkLoadProduction(stage(210, 49), 'cpu', 30), /dropped 49/)
})
test('full video cadence and bounded startup variation satisfy the load check', () => {
  assert.deepEqual(checkLoadProduction(stage(210, 1), 'cpu', 30), { sourceFps: 30, producedFps: 30, droppedFrames: 1 })
})
