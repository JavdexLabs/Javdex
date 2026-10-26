import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observeTextureLeasePeak } from './playback-acceptance-support.mjs'

test('a reaped playback host retains its observed three-slot peak without inventing a post-stop native counter', () => {
  let peak = observeTextureLeasePeak(0, { alive: true, peakOutstanding: 2 })
  peak = observeTextureLeasePeak(peak, { alive: true, peakOutstanding: 3 })
  peak = observeTextureLeasePeak(peak, { alive: false })
  assert.equal(peak, 3)
})
test('missing counters while alive and a native peak over budget still fail acceptance', () => {
  assert.throws(() => observeTextureLeasePeak(0, { alive: true }), /high-water/)
  assert.throws(() => observeTextureLeasePeak(3, { alive: true, peakOutstanding: 4 }), /high-water/)
  assert.throws(() => observeTextureLeasePeak(3, { alive: false, peakOutstanding: 4 }), /high-water/)
  assert.equal(observeTextureLeasePeak(0, { alive: false }), 0)
})
