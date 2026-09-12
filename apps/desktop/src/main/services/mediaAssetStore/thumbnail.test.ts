import { it } from 'node:test'
import assert from 'node:assert/strict'
import sharp, { type Sharp } from 'sharp'
import { createAssetThumbnail } from './thumbnail'

it('preserves aspect ratio, respects orientation and does not enlarge small images', async () => {
  const input = await sharp({ create: { width: 1200, height: 600, channels: 4, background: '#80404080' } })
    .withMetadata({ orientation: 6 }).png().toBuffer()
  const result = await sharp(await createAssetThumbnail(input, 320)).metadata()
  assert.equal(result.format, 'webp')
  assert.equal(result.width, 160)
  assert.equal(result.height, 320)
  assert.equal(result.hasAlpha, true)
  const tiny = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#804040' } }).jpeg().toBuffer()
  const small = await sharp(await createAssetThumbnail(tiny, 640)).metadata()
  assert.equal(small.width, 8)
  assert.equal(small.height, 4)
})

it('makes a single static thumbnail from an animated image', async () => {
  const raw = Buffer.alloc(3 * 6 * 3, 80)
  raw.fill(160, 18)
  const input = await sharp(raw, { raw: { width: 3, height: 6, channels: 3, pageHeight: 2 } }).gif().toBuffer()
  assert.ok((await sharp(input).metadata()).pages! > 1)
  const result = await sharp(await createAssetThumbnail(input, 320)).metadata()
  assert.equal(result.width, 3)
  assert.equal(result.height, 2)
  assert.ok(!result.pages || result.pages === 1)
})

it('retains two decode slots until native work settles after cancellation', async (t) => {
  const input = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#804040' } }).png().toBuffer()
  const original = sharp.prototype.toBuffer
  let calls = 0
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  t.mock.method(sharp.prototype, 'toBuffer', async function (this: Sharp) {
    if (++calls === 2) entered()
    await gate
    return original.call(this)
  })
  const abort = new AbortController()
  const first = createAssetThumbnail(input, 320, abort.signal)
  const second = createAssetThumbnail(input, 320)
  let settled = false
  const rejected = assert.rejects(first, { name: 'AbortError' }).then(() => { settled = true })
  await started
  abort.abort()
  const third = createAssetThumbnail(input, 640)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
  assert.equal(settled, false)
  release()
  await rejected
  await Promise.all([second, third])
  assert.equal(calls, 3)
})
