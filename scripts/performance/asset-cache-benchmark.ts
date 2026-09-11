import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { mediaAssetStore } from '../../src/main/services/mediaAssetStore'
import { invalidateAssetCache } from '../../src/main/services/assetCache'
import { encryptPlain, resetAssetKeyCacheForTests } from '../../src/main/services/assetCrypto'

it('measures cold and hot transport-byte cache reads with synthetic assets', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-cache-bench-'))
  const previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
  const results: object[] = []
  try {
    fs.mkdirSync(path.join(root, 'media_assets', 'covers'), { recursive: true })
    const reads = t.mock.method(fs.promises, 'open')
    const stats = t.mock.method(fs.promises, 'stat')
    const decrypts = t.mock.method(crypto.webcrypto.subtle, 'decrypt')
    for (const bytes of [1024 * 1024, 16 * 1024 * 1024]) {
      const plain = Buffer.alloc(bytes, 19)
      fs.readFileSync('build/icon-32.png').copy(plain)
      for (const encrypted of [false, true]) {
        const rel = `covers/sample-${bytes}.${encrypted ? 'enc' : 'png'}`
        fs.writeFileSync(path.join(root, 'media_assets', rel), encrypted ? encryptPlain(plain, '.png') : plain)
        await mediaAssetStore.readForServeAsync(rel)
        for (const state of ['cold-byte-cache', 'hot-byte-cache', 'concurrent-cold-byte-cache']) {
          const readBefore = reads.mock.callCount()
          const statBefore = stats.mock.callCount()
          const decryptBefore = decrypts.mock.callCount()
          let result: { body: Buffer; mime: string } | undefined
          const concurrent = state === 'concurrent-cold-byte-cache'
          const iterations = concurrent ? 12 : 5
          if (concurrent) invalidateAssetCache(rel)
          let responses: Array<{ body: Buffer; mime: string }> | undefined
          const start = performance.now()
          if (concurrent) {
            responses = await Promise.all(Array.from({ length: iterations }, () => mediaAssetStore.readForServeAsync(rel)))
            result = responses[0]
          } else for (let i = 0; i < iterations; i++) {
            if (state === 'cold-byte-cache') invalidateAssetCache(rel)
            result = await mediaAssetStore.readForServeAsync(rel)
          }
          const elapsedMs = performance.now() - start
          assert.deepEqual(result?.body, plain)
          if (responses) assert.ok(responses.every((image) => image.body.equals(plain)))
          const openCalls = reads.mock.callCount() - readBefore
          const decryptCalls = decrypts.mock.callCount() - decryptBefore
          const expectedReads = state === 'hot-byte-cache' ? 0 : concurrent ? 1 : 5
          assert.equal(openCalls, expectedReads)
          assert.equal(decryptCalls, encrypted ? expectedReads : 0)
          results.push({ bytes, encrypted, state, iterations, elapsedMs,
            openCalls, decryptCalls, statCalls: stats.mock.callCount() - statBefore })
        }
      }
    }
    const report = { measuredAt: new Date().toISOString(), runtime: process.versions,
      notes: ['Small PNG plus synthetic trailing bytes; headers inspected but no pixel decoding, browser or network measured.',
        'OS file cache and crypto key are warm in both cases. Cold refers only to the application byte cache.',
        'Five sequential or twelve concurrent reads, instrumented open/decrypt/path-stat calls (fstat and bounded read chunks excluded), no p95 or Windows/HDD conclusion.',
        'The hot path still stats the file and copies response bytes; cache limits do not bound active or response-buffer bytes.'], results }
    const output = process.env.JAVDEX_ASSET_CACHE_BENCH_OUTPUT
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    else process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } finally {
    invalidateAssetCache()
    resetAssetKeyCacheForTests()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
