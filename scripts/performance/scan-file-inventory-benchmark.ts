/** Synthetic inventory only: no user database, media, filesystem discovery or audit writes. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { performance } from 'node:perf_hooks'
import type { MediaLibraryRoot } from '../../src/shared/mediaLibraryTypes'
import { createMemoryScanFileInventory, createScanFileSpool } from '../../src/main/scanner/scanFileInventory'

it('compares inventory discovery and three sequential passes at 10k, 100k and 600k paths', () => {
  const root: MediaLibraryRoot = { id: 1, libraryId: 1, path: '/synthetic', normalizedPath: '/synthetic',
    realPath: null, normalizedRealPath: null, deviceId: null, inode: null, position: 0,
    state: 'active', createdAt: '', updatedAt: '' }
  const results: unknown[] = []
  for (const count of [10000, 100000, 600000]) {
    for (const mode of ['memory', 'spool'] as const) {
      const samples: unknown[] = []
      for (let sample = -1; sample < 3; sample++) {
        const db = new Database(':memory:')
        const inventory = mode === 'spool' ? createScanFileSpool(db, [root]) : createMemoryScanFileInventory([root])
        let checksum = 0, flushes = 0, maxAppendMs = 0
        const started = performance.now()
        try {
          for (let index = 0; index < count; index++) {
            // Fixed 192-byte ASCII path, repeated identities deliberately retained.
            const file = `/synthetic/${String(index % 1000).padStart(6, '0')}/`.padEnd(188, 'x') + '.mp4'
            const before = performance.now()
            if (inventory.append(file, 1)) flushes++
            maxAppendMs = Math.max(maxAppendMs, performance.now() - before)
          }
          inventory.seal()
          const discovered = performance.now()
          for (let pass = 0; pass < 3; pass++) {
            let seen = 0
            for (const entry of inventory) { checksum += entry.filePath.length; seen++ }
            assert.equal(seen, count)
          }
          const finished = performance.now()
          assert.equal(checksum, count * 192 * 3)
          if (sample >= 0) samples.push({ discoveryMs: discovered - started, threePassesMs: finished - discovered,
            totalMs: finished - started, maxAppendMs, flushes, checksum, tempStore: db.pragma('temp_store', { simple: true }) })
        } finally { inventory.dispose(); db.close() }
      }
      results.push({ count, mode, samples })
    }
  }
  console.log(JSON.stringify({ runtime: process.versions, results, notes: [
    'One warmup and three samples; fixed memory-then-spool order, in-memory synthetic connection with actual TEMP spool.',
    'Discovery includes path construction and per-append timer overhead. Three passes include checksums; excludes fixture database creation and disposal.',
    'maxAppendMs is an observed append duration, not a whole-scanner event-loop bound. No explicit event-loop yields in this synchronous probe.',
    'Spool bounds JS path buffering/projection; total TEMP storage remains O(files). No GC/heap/RSS/whole scan/Windows/HDD/p95 claim.'
  ] }, null, 2))
})
