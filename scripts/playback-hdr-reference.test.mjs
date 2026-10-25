import assert from 'node:assert/strict'
import test from 'node:test'
import { pqCode, hlgCode } from './linux-color-reference.mjs'
import { pqLuminance, hlgLuminance, bt2390Srgb } from './playback-hdr-reference.mjs'

test('HDR capture reference recovers absolute PQ and neutral HLG luminance', () => {
  for (const nits of [0, 0.1, 1, 10, 100, 203, 1000]) {
    assert.ok(Math.abs(pqLuminance(pqCode(nits)) - nits) < 1e-6)
    assert.ok(Math.abs(hlgLuminance(hlgCode(nits)) - nits) < 1e-6)
  }
})

test('static BT.2390 retains gray ordering and highlight rolloff at the SDR target', () => {
  for (const peak of [1000, 4000, 10000]) {
    const values = [0, 0.1, 1, 10, 50, 100, 203, 400, peak].map(nits => bt2390Srgb(nits, peak))
    assert.ok(values[0] < 1e-6)
    assert.ok(Math.abs(values.at(-1) - 255) < 1e-6)
    assert.ok(values.every((value, index) => index === 0 || value > values[index - 1]))
    assert.ok(bt2390Srgb(203, peak) < 255, 'tone mapping must retain highlight headroom')
  }
  assert.equal(Math.round(bt2390Srgb(100, 1000)), 186)
  assert.equal(Math.round(bt2390Srgb(203, 1000)), 229)
})
