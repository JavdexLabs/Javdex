import { it } from 'node:test'
import assert from 'node:assert/strict'
import sharp, { type Sharp } from 'sharp'
import { inspectServedImage, AssetPixelLimitError } from './pixelBudget'

async function jpegWithHeaderSize(width: number, height: number): Promise<Buffer> {
  const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#808080' } }).jpeg().toBuffer()
  const frame = image.indexOf(Buffer.from([0xff, 0xc0]))
  assert.ok(frame > 0)
  image.writeUInt16BE(height, frame + 5)
  image.writeUInt16BE(width, frame + 7)
  return image
}

it('inspects all served formats without decoding pixels', async (t) => {
  const images = await Promise.all((['jpeg', 'png', 'webp', 'gif', 'avif'] as const).map(async (format) => ({
    format,
    body: await sharp({ create: { width: 3, height: 2, channels: 3, background: '#804040' } }).toFormat(format).toBuffer()
  })))
  t.mock.method(sharp.prototype, 'toBuffer', () => { throw Error('pixel decode forbidden') })
  for (const { format, body } of images) assert.equal(await inspectServedImage(body), `image/${format}`)
})

it('rejects a tiny encoded image with an oversized canvas and accepts the exact boundary', async () => {
  const exact = await jpegWithHeaderSize(8192, 8192)
  const oversized = await jpegWithHeaderSize(8193, 8192)
  assert.ok(oversized.length < 1024)
  // Deliberately inconsistent pixel data: only header inspection is under test, never actual decoding.
  assert.equal(await inspectServedImage(exact), 'image/jpeg')
  await assert.rejects(inspectServedImage(oversized), AssetPixelLimitError)
})

it('rejects corrupt and unsupported image headers', async () => {
  await assert.rejects(inspectServedImage(Buffer.from('not an image')))
  await assert.rejects(inspectServedImage(Buffer.from('<svg width="1" height="1"></svg>')), /Unsupported/)
})

it('inspects the single-frame canvas of real animated GIF and WebP inputs', async (t) => {
  const raw = Buffer.alloc(3 * 6 * 3)
  raw.fill(64, 0, 18)
  raw.fill(128, 18, 36)
  raw.fill(192, 36)
  const images = await Promise.all((['gif', 'webp'] as const).map(async (format) => ({
    format, body: await sharp(raw, { raw: { width: 3, height: 6, channels: 3, pageHeight: 2 } })
      .toFormat(format).toBuffer()
  })))
  const metadata = sharp.prototype.metadata
  const observed: Array<{ height: number; pages?: number }> = []
  t.mock.method(sharp.prototype, 'metadata', async function (this: Sharp) {
    const result = await metadata.call(this)
    observed.push(result)
    return result
  })
  for (const image of images) assert.equal(await inspectServedImage(image.body), `image/${image.format}`)
  assert.deepEqual(observed.map(({ height, pages }) => ({ height, pages })), [
    { height: 2, pages: 3 }, { height: 2, pages: 3 }
  ])
})

it('waits for metadata completion when cancelled and destroys the reader', async (t) => {
  const body = await jpegWithHeaderSize(1, 1)
  const original = sharp.prototype.metadata
  const destroy = t.mock.method(sharp.prototype, 'destroy')
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  t.mock.method(sharp.prototype, 'metadata', async function (this: Sharp) {
    entered()
    await gate
    return original.call(this)
  })
  const abort = new AbortController()
  let settled = false
  const pending = inspectServedImage(body, abort.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' }).then(() => { settled = true })
  await started
  abort.abort()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  release()
  await rejected
  assert.equal(destroy.mock.callCount(), 1)
})
