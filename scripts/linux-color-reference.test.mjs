import assert from 'node:assert/strict'
import test from 'node:test'
import { pqCode, hlgCode } from './linux-color-reference.mjs'
test('PQ absolute luminance anchors are independent of the target SDR mapping', () => {
  assert.ok(pqCode(0) < 0.000001)
  assert.ok(Math.abs(pqCode(100) - 0.5080784215) < 1e-9)
  assert.ok(Math.abs(pqCode(1000) - 0.7518270962) < 1e-9)
  assert.ok(Math.abs(pqCode(10000) - 1) < 1e-12)
})
test('HLG includes the neutral 1000-nit OOTF, not merely the camera OETF', () => {
  assert.equal(hlgCode(0), 0)
  assert.ok(Math.abs(hlgCode(1000) - 1) < 1e-7)
  const scene = 1 / 12
  assert.ok(Math.abs(hlgCode(1000 * scene ** 1.2) - 0.5) < 1e-12)
  const values = [0, 0.1, 1, 10, 50, 100, 400, 1000].map(hlgCode)
  assert.ok(values.every((v, i) => !i || v > values[i - 1]))
})
