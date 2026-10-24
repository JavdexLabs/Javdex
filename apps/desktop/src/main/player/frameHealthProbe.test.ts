import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FrameHealthProbe } from './frameHealthProbe'
const samples = Array.from({ length: 20 }, (_, i) => [64, 191, 128, 255][i % 4])
test('display probe requires fixed-pattern evidence for its own binding and sequence', () => {
  const probe = new FrameHealthProbe()
  assert.equal(probe.receive({ bindingToken: 'one', sequence: 1, samples }), false)
  probe.exported(1, 'one', 640, 360)
  assert.equal(probe.receive({ bindingToken: 'other', sequence: 1, samples }), false)
  assert.equal(probe.receive({ bindingToken: 'one', sequence: 2, samples }), false)
  assert.equal(probe.receive({ bindingToken: 'one', sequence: 1, samples }), true)
  assert.equal(probe.state, 'passed')
  probe.reset(); assert.equal(probe.state, 'pending')
})
test('probe pauses its deadline while hidden and rejects corrupt or missing readback', () => {
  const probe = new FrameHealthProbe()
  probe.tick(true, 0); probe.tick(false, 7000); probe.tick(true, 100000)
  assert.throws(() => probe.tick(true, 108001), /超时/)
  probe.exported(1, 'one', 640, 360)
  for (const invalid of [[], Array(20).fill(0), [...samples.slice(0, 19), NaN]])
    assert.throws(() => probe.receive({ bindingToken: 'one', sequence: 1, samples: invalid }), /失败/)
})
