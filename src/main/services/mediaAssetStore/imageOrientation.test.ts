import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readImageOrientationFromBuffer } from './imageOrientation'

it('reads PNG/WebP metadata and never follows TIFF offsets outside its chunk', () => {
  const tiff = Buffer.from('49492a0008000000010012010300010000000600000000000000', 'hex')
  const pngChunk = Buffer.alloc(tiff.length + 12)
  pngChunk.writeUInt32BE(tiff.length)
  pngChunk.write('eXIf', 4)
  tiff.copy(pngChunk, 8)
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk])
  assert.equal(readImageOrientationFromBuffer(png), 6)
  const webp = Buffer.alloc(20 + tiff.length)
  webp.write('RIFF')
  webp.writeUInt32LE(webp.length - 8, 4)
  webp.write('WEBPEXIF', 8)
  webp.writeUInt32LE(tiff.length, 16)
  tiff.copy(webp, 20)
  assert.equal(readImageOrientationFromBuffer(webp), 6)
  for (let length = 0; length < png.length; length++) {
    assert.equal(readImageOrientationFromBuffer(png.subarray(0, length)), 1)
  }
  for (const [offset, value] of [[0, 0], [2, 0], [4, 0xffff], [12, 4], [14, 2], [18, 9]]) {
    const malformed = Buffer.from(png)
    malformed.writeUInt16LE(value, 16 + offset)
    assert.equal(readImageOrientationFromBuffer(malformed), 1)
  }
  const outside = Buffer.concat([png, Buffer.alloc(1024)])
  outside.writeUInt32LE(100, 20)
  assert.equal(readImageOrientationFromBuffer(outside), 1)
})
