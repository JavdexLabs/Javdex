import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import { mediaAssetStore } from '../../src/main/services/mediaAssetStore'
import { invalidateAssetCache } from '../../src/main/services/assetCache'

it('measures original and thumbnail response bytes and pixels for a synthetic large photograph', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-thumbnail-bench-'))
  const previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
  try {
    const input = await sharp(randomBytes(2400 * 1600 * 3), { raw: { width: 2400, height: 1600, channels: 3 } })
      .jpeg({ quality: 95 }).toBuffer()
    fs.mkdirSync(path.join(root, 'media_assets', 'covers'), { recursive: true })
    const rel = 'covers/synthetic.jpg'
    fs.writeFileSync(mediaAssetStore.resolve(rel), input)
    const opens = t.mock.method(fs.promises, 'open')
    const decodes = t.mock.method(sharp.prototype, 'toBuffer')
    const results = []
    for (const scenario of ['original', 'cold-thumbnail', 'hot-thumbnail'] as const) {
      if (scenario !== 'hot-thumbnail') invalidateAssetCache(rel)
      const opened = opens.mock.callCount(), decoded = decodes.mock.callCount()
      const started = performance.now()
      const image = await mediaAssetStore.readForServeAsync(rel, undefined, scenario === 'original' ? undefined : 640)
      const elapsedMs = performance.now() - started
      const metadata = await sharp(image.body).metadata()
      if (scenario !== 'original') {
        assert.ok(metadata.width <= 640 && metadata.height <= 640)
        assert.ok(image.body.length < input.length)
      } else assert.deepEqual(image.body, input)
      results.push({ scenario, elapsedMs, bytes: image.body.length, width: metadata.width, height: metadata.height,
        openCalls: opens.mock.callCount() - opened, decodeCalls: decodes.mock.callCount() - decoded })
    }
    assert.equal(results[2].decodeCalls, 0)
    assert.equal(results[2].openCalls, 0)
    const report = { measuredAt: new Date().toISOString(), runtime: process.versions, results,
      notes: ['Random-noise JPEG fixture; timing is one warm-OS-cache sample, not p95 or target hardware acceptance.',
        'Cold thumbnail includes native resize/encoding; byte/pixel reductions do not imply lower cold server latency.',
        'No browser decoding, total memory or multi-device end-to-end time measured.'] }
    const json = JSON.stringify(report, null, 2) + '\n'
    if (process.env.JAVDEX_THUMBNAIL_BENCH_OUTPUT) fs.writeFileSync(process.env.JAVDEX_THUMBNAIL_BENCH_OUTPUT, json)
    else process.stdout.write(json)
  } finally {
    invalidateAssetCache()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
