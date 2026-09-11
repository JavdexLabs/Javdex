/** Synthetic cleanup probe. Never opens user data; run without concurrent tests/builds. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { performance } from 'node:perf_hooks'
import { migrateDatabase } from '../../src/main/db/migrations'
import { removeResourceLessMembershipsWithAudit } from '../../src/main/db/libraryMembershipRepo'

it('measures complete membership cleanup and first callback at increasing scales', () => {
  const results: unknown[] = []
  for (const count of [10000, 100000]) {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys = ON')
      migrateDatabase(db)
      db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${count})
        INSERT INTO videos(id,code,title) SELECT x,printf('MEM-%06d',x),hex(zeroblob(512)) FROM n;
        INSERT INTO library_video_memberships(library_id,video_id,discovery_key)
        SELECT 1,id,id FROM videos; ANALYZE;`)
      const samples: unknown[] = []
      const rollback = new Error('probe rollback')
      for (let sample = -1; sample < 3; sample++) {
        let rows = 0, checksum = 0, firstMs = 0, elapsedMs = 0
        // Rollback after timing restores the same fixture; measurements exclude commit/durable I/O.
        assert.throws(() => db.transaction(() => {
          const start = performance.now()
          const removed = removeResourceLessMembershipsWithAudit(1, entry => {
            if (rows === 0) firstMs = performance.now() - start
            rows++; checksum += entry.videoId
          }, db)
          elapsedMs = performance.now() - start
          assert.equal(removed, count)
          assert.equal(rows, count)
          assert.equal(checksum, count * (count + 1) / 2)
          assert.equal((db.prepare('SELECT COUNT(*) AS n FROM library_video_memberships').get() as { n: number }).n, 0)
          throw rollback
        })(), error => error === rollback)
        assert.equal((db.prepare('SELECT COUNT(*) AS n FROM library_video_memberships').get() as { n: number }).n, count)
        if (sample >= 0) samples.push({ elapsedMs, firstMs, rows, checksum })
      }
      results.push({ count, titleBytes: 1024, samples })
    } finally { db.close() }
  }
  console.log(JSON.stringify({ results, notes: [
    'Synthetic in-memory SQLite, ANALYZE, 1 warmup + 3 measured samples at each scale.',
    'Production cleanup with checksum callback; excludes durable commit, actual audit encoding/writes, scanner and filesystem work.',
    'Reports synchronous elapsed and first callback latency; no event-loop yielding, RSS bound, p95, Windows/HDD or end-to-end claim.',
    'TEMP snapshot may still grow with candidates; bounded JavaScript pages do not bound SQLite memory or writer lock duration.'
  ] }, null, 2))
})
