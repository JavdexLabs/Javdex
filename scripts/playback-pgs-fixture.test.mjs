import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPgsFixture } from './playback-pgs-fixture.mjs'

// Deliberately read bytes independently of the writer, with literal expected
// geometry. These tests validate this fixed fixture, not arbitrary PGS input.
function segments() {
  const file = createPgsFixture()
  const result = []
  for (let offset = 0; offset < file.length;) {
    assert.ok(offset + 13 <= file.length)
    assert.equal(file.toString('ascii', offset, offset + 2), 'PG')
    const length = file.readUInt16BE(offset + 11)
    assert.ok(offset + 13 + length <= file.length)
    result.push({ pts: file.readUInt32BE(offset + 2), dts: file.readUInt32BE(offset + 6), type: file[offset + 10],
      payload: file.subarray(offset + 13, offset + 13 + length) })
    offset += 13 + length
  }
  return result
}

test('original SUP has complete, timestamped display and clear sets', () => {
  const actual = segments()
  assert.deepEqual(actual.map(item => item.type), [0x16, 0x17, 0x14, 0x15, 0x80, 0x16, 0x80, 0x16, 0x17, 0x14, 0x15, 0x80, 0x16, 0x80])
  assert.deepEqual(actual.map(item => item.pts), [90000, 90000, 90000, 90000, 90000, 270000, 270000,
    720000, 720000, 720000, 720000, 720000, 1800000, 1800000])
  assert.ok(actual.every(item => item.dts === 0))
  assert.ok(actual.filter(item => item.type === 0x80).every(item => item.payload.length === 0))
  assert.deepEqual(createPgsFixture(), createPgsFixture(), 'fixture generation must be deterministic')
})

test('PGS uses two positioned epochs and explicit empty compositions', () => {
  const actual = segments().filter(item => item.type === 0x16)
  assert.deepEqual(actual.map(({ payload: p }) => [p.readUInt16BE(0), p.readUInt16BE(2), p[4], p.readUInt16BE(5), p[7], p[8], p[9], p[10]]),
    [[640, 360, 0x20, 0, 0x80, 0, 0, 1], [640, 360, 0x20, 1, 0, 0, 0, 0],
      [640, 360, 0x20, 2, 0x80, 0, 0, 1], [640, 360, 0x20, 3, 0, 0, 0, 0]])
  assert.deepEqual(actual.filter(item => item.payload[10] === 1).map(({ payload: p }) =>
    [p.readUInt16BE(11), p[13], p[14], p.readUInt16BE(15), p.readUInt16BE(17), p.length]),
    [[0, 0, 0, 96, 64, 19], [0, 0, 0, 256, 294, 19]])
  assert.ok(actual.filter(item => item.payload[10] === 0).every(item => item.payload.length === 11))
  const windows = segments().filter(item => item.type === 0x17)
  assert.deepEqual(windows.map(({ payload: p }) => [p[0], p[1], p.readUInt16BE(2), p.readUInt16BE(4), p.readUInt16BE(6), p.readUInt16BE(8), p.length]),
    [[1, 0, 96, 64, 128, 40, 10], [1, 0, 256, 294, 128, 40, 10]])
})

test('PGS palette/RLE decode to white interior with transparent border and hole', () => {
  const actual = segments()
  for (const { payload } of actual.filter(item => item.type === 0x14)) {
    assert.deepEqual([...payload], [0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255])
  }
  for (const { payload: p } of actual.filter(item => item.type === 0x15)) {
    assert.deepEqual([p.readUInt16BE(0), p[2], p[3], p.readUIntBE(4, 3), p.readUInt16BE(7), p.readUInt16BE(9)],
      [0, 0, 0xc0, p.length - 7, 128, 40])
    const pixels = new Uint8Array(128 * 40)
    let x = 0, y = 0, offset = 11, white = 0
    while (offset < p.length) {
      let color = p[offset++], length = 1
      if (color === 0) {
        assert.ok(offset < p.length)
        const flags = p[offset++]
        if (flags === 0) { assert.equal(x, 128); x = 0; y++; continue }
        length = flags & 0x3f
        if (flags & 0x40) { assert.ok(offset < p.length); length = (length << 8) | p[offset++] }
        if (flags & 0x80) { assert.ok(offset < p.length); color = p[offset++] }
      }
      assert.ok(length > 0 && x + length <= 128 && y < 40)
      assert.ok(color === 0 || color === 1)
      pixels.fill(color, y * 128 + x, y * 128 + x + length)
      x += length
    }
    assert.equal(y, 40)
    assert.equal(x, 0)
    for (let oy = 0; oy < 40; oy++) for (let ox = 0; ox < 128; ox++) {
      const expected = ox >= 4 && ox < 124 && oy >= 4 && oy < 36 && !(ox >= 56 && ox < 72 && oy >= 14 && oy < 26) ? 1 : 0
      assert.equal(pixels[oy * 128 + ox], expected, `pixel ${ox},${oy}`)
      white += expected
    }
    assert.equal(white, 3648)
  }
})
