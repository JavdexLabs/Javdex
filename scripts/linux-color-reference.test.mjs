import assert from 'node:assert/strict'
import test from 'node:test'
import { pqCode, hlgCode } from './linux-color-reference.mjs'
import { validateColorFixtureFrame } from './linux-color-fixture-validation.mjs'
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
test('color fixtures require encoded transfer/primaries tags and unchanged full-range decoded samples', () => {
  const width=16,height=4,raw=Buffer.alloc(width*height*3),codes=[0,20,82,225,512,767,962,1023]
  for(let i=0;i<8;i++)raw.writeUInt16LE(codes[i],2*(width+2*i+1))
  const fixture={range:'full',primaries:'bt709',trc:'bt709',codes}
  const tags='color_range:pc color_space:bt709 color_primaries:bt709 color_trc:bt709'
  assert.equal(validateColorFixtureFrame(raw,tags,fixture,width,height).passed,true)
  assert.throws(()=>validateColorFixtureFrame(raw,tags.replace('color_trc:bt709','color_trc:unknown'),fixture,width,height),/color tags/)
  assert.throws(()=>validateColorFixtureFrame(raw,tags.replace('color_primaries:bt709','color_primaries:unknown'),fixture,width,height),/color tags/)
  raw.writeUInt16LE(64,2*(width+1))
  assert.throws(()=>validateColorFixtureFrame(raw,tags,fixture,width,height),/gray\/range/)
})
