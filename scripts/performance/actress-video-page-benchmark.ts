/** Synthetic associated-work paging probe; run alone using run-electron-tests.mjs. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { initDatabaseAtPath, closeDatabase } from '../../src/main/db/database'
import { getActressDetail } from '../../src/main/db/actressRepo'
import { listActressVideoPage } from '../../src/main/db/actressVideoPageRepo'
import { resetSettingsCacheForTests } from '../../src/main/settings/settingsStore'

it('compares complete actor works with bounded first and last card pages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-actor-works-probe-'))
  const previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
  resetSettingsCacheForTests()
  const scales: unknown[] = []
  try {
    for (const count of [10000, 50000]) {
      const db = initDatabaseAtPath(path.join(root, `${count}.db`))
      db.exec(`INSERT INTO actresses(id,main_name) VALUES(1,'Actor');
        WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${count})
        INSERT INTO videos(id,code,summary,release_date,add_time)
          SELECT x,printf('VIDEO-%06d',x),hex(zeroblob(2048)),'2026-01-01','2026-01-01 00:00:00' FROM n;
        INSERT OR IGNORE INTO media_libraries(id,name) VALUES(1,'One'),(2,'Two');
        INSERT INTO library_video_memberships(library_id,video_id,discovery_key) SELECT 1,id,id FROM videos;
        INSERT INTO library_video_memberships(library_id,video_id,discovery_key) SELECT 2,id,id FROM videos WHERE id%2=0;
        INSERT INTO video_actress(video_id,actress_id) SELECT id,1 FROM videos;
        ANALYZE;`)
      const metrics: unknown[] = []
      const full = getActressDetail(1)!
      assert.equal(full.videos.length, count)
      const expected = full.videos.map(video => video.id).sort((a, b) => a - b)
      function measure<T>(name: string, read: () => T, check: (value: T) => void) {
        check(read())
        const samples: number[] = []
        let jsonBytes = 0
        for (let n = 0; n < 3; n++) {
          const start = performance.now(), value = read()
          samples.push(performance.now() - start)
          check(value)
          jsonBytes = Buffer.byteLength(JSON.stringify(value))
        }
        metrics.push({ name, samples, medianMs: [...samples].sort((a, b) => a - b)[1], jsonBytes })
      }
      measure('legacy.detail', () => getActressDetail(1)!, value => assert.equal(value.videos.length, count))
      const prepare = db.prepare.bind(db)
      let plan: unknown
      db.prepare = ((sql: string) => {
        if (sql.includes('WITH page AS MATERIALIZED')) plan = prepare('EXPLAIN QUERY PLAN ' + sql).all(1, 60, count - 60)
        return prepare(sql)
      }) as typeof db.prepare
      try { listActressVideoPage(1, { offset: count - 60 }) } finally { db.prepare = prepare }
      assert.ok(Array.isArray(plan) && plan.length > 0, 'page EQP must be captured')
      for (const offset of [0, count - 60]) {
        measure(`cards.offset-${offset}`, () => listActressVideoPage(1, { offset })!, value => {
          assert.equal(value.total, count)
          assert.deepEqual(value.videos.map(video => video.id), expected.slice(offset, offset + 60))
        })
      }
      scales.push({ count, metrics, plan })
      closeDatabase()
    }
    console.log(JSON.stringify({ scales, notes: [
      'ANALYZE, one warmup, three warm samples per query; median is the middle sample. Fixed legacy-first order.',
      'Timing excludes assertion and JSON serialization; old detail/oracle retained. No p95, peak memory, IPC, cold or target-platform claim.',
      'All works share dates, no resources; 4KiB summaries and 50% overlapping memberships. Count and sort still scan associated works.',
      'Card strings are not byte-bounded; this probe does not close the long-field requirement.'
    ] }, null, 2))
  } finally {
    closeDatabase(); resetSettingsCacheForTests()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
