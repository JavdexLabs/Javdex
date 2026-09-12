import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import sharp from 'sharp'
import { assertSharpDecode, createSharpImageCodec } from './imageCodec'

describe('sharp image codec', () => {
  it('loads native sharp and reads PNG dimensions', async () => {
    await assertSharpDecode()
    const png = await sharp({
      create: { width: 12, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } }
    })
      .png()
      .toBuffer()
    const size = createSharpImageCodec().sizeFromBuffer(png)
    assert.deepEqual(size, { width: 12, height: 8 })
  })
})
