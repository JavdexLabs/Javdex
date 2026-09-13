import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { decryptBlob, decryptBlobAsync, encryptPlain, resetAssetKeyCacheForTests } from '@library/assetCrypto'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

it('measures synthetic synchronous and asynchronous encrypted-asset bursts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-crypto-bench-'))
  const previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
  const results: object[] = []
  try {
    for (const bytes of [1024 * 1024, 16 * 1024 * 1024]) {
      const plain = Buffer.alloc(bytes, 31)
      const blob = encryptPlain(plain, '.jpg')
      for (const mode of ['sync', 'async'] as const) {
        resetAssetKeyCacheForTests()
        for (const state of ['cold-key', 'warm-key'] as const) {
          const iterations = state === 'cold-key' ? 1 : 5
          let last = performance.now()
          let maxTimerDelayMs = 0
          const timer = setInterval(() => {
            const now = performance.now()
            maxTimerDelayMs = Math.max(maxTimerDelayMs, now - last - 1)
            last = now
          }, 1)
          let result: { data: Buffer; ext: string } | undefined
          let elapsedMs: number
          try {
            await wait(10)
            const start = performance.now()
            for (let i = 0; i < iterations; i++) result = mode === 'sync' ? decryptBlob(blob) : await decryptBlobAsync(blob)
            elapsedMs = performance.now() - start
            await wait(10)
          } finally {
            clearInterval(timer)
          }
          assert.deepEqual(result, { data: plain, ext: '.jpg' })
          results.push({ bytes, mode, state, iterations, elapsedMs, maxTimerDelayMs })
        }
      }
    }
    const output = process.env.JAVDEX_CRYPTO_BENCH_OUTPUT
    const report = {
      measuredAt: new Date().toISOString(), runtime: process.versions,
      notes: [
        'Synthetic 1MiB/16MiB buffers, existing AVPK format. No user assets or database accessed.',
        'Cold-key includes key derivation, warm-key is five sequential decryptions; not concurrent readers or UI latency.',
        '1ms interval observed delay is a single burst sample, not p95. OS scheduling, native buffer copies and GC are included.',
        'Async uses native jobs; cancellation is checked before/after rather than interrupting the native crypto job.'
      ], results
    }
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    else process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } finally {
    resetAssetKeyCacheForTests()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
