/** Synthetic counter lifecycle only; no user data, resource queries, NFO or filesystem work. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { performance } from 'node:perf_hooks'
import { createMemoryScanCodeCounts, createScanCodeCounts } from '../../src/main/scanner/scanCodeCounts'

it('compares exact repeated-code counting, correction and frozen reads', () => {
  const results: unknown[] = []
  for (const uniqueCodes of [10000, 100000]) {
    for (const mode of ['memory', 'temp'] as const) {
      const samples: unknown[] = []
      for (let sample = -1; sample < 3; sample++) {
        const db = new Database(':memory:')
        const counts = mode === 'temp' ? createScanCodeCounts(db) : createMemoryScanCodeCounts()
        const code = (index: number) => `ABC-${String(index).padStart(8, '0')}`
        let flushes = 0, checksum = 0
        const started = performance.now()
        try {
          for (let repeat = 0; repeat < 3; repeat++) {
            for (let index = 0; index < uniqueCodes; index++) if (counts.add(code(index))) flushes++
          }
          counts.finishCounting()
          const counted = performance.now()
          for (let index = 0; index < uniqueCodes; index++) counts.decrement(code(index))
          counts.freeze()
          const corrected = performance.now()
          const beforeReads = db.prepare('SELECT total_changes() AS n').get() as { n: number }
          for (let repeat = 0; repeat < 3; repeat++) {
            for (let index = 0; index < uniqueCodes; index++) checksum += counts.get(code(index))
          }
          const finished = performance.now()
          assert.equal(checksum, uniqueCodes * 2 * 3)
          assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), beforeReads)
          if (sample >= 0) samples.push({ countMs: counted - started, correctionMs: corrected - counted,
            frozenReadsMs: finished - corrected, totalMs: finished - started, flushes, checksum })
        } finally { counts.dispose(); db.close() }
      }
      results.push({ uniqueCodes, occurrences: uniqueCodes * 3, mode, samples })
    }
  }
  console.log(JSON.stringify({ runtime: process.versions, results, notes: [
    'One warmup plus3 samples, memory then TEMP at each scale; in-memory synthetic database, no concurrent tests or builds.',
    'Three occurrences per code, one decrement per code, then three reads per code. Frozen reads verified not to change total_changes.',
    'Includes code construction; excludes DB/factory setup and disposal. Not a scanner throughput, cancellation latency, p95, heap/RSS or Windows/HDD measurement.',
    'TEMP trades read/write overhead for bounded JavaScript counter buffering. Total SQLite storage still grows with unique codes.'
  ] }, null, 2))
})
