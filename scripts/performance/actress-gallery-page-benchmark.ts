/** Synthetic gallery ordering/page probe. Run independently of builds and other tests. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { initDatabaseAtPath, closeDatabase } from '../../packages/library/src/db/database'
import { getActressMetadata, getActressProfile } from '../../packages/library/src/db/actressRepo'
import { listActressGalleryPage } from '../../packages/library/src/db/actressGalleryPageRepo'
import { prepareActressGalleryForDisplay } from '../../packages/contracts/src/mediaGalleryDisplay'
import { resetSettingsCacheForTests } from '../../apps/desktop/src/main/settings/settingsStore'

it('measures complete gallery display preparation versus first and last pages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-gallery-probe-'))
  const previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
  resetSettingsCacheForTests()
  const scales: unknown[] = []
  try {
    for (const count of [10000, 50000]) {
      const db = initDatabaseAtPath(path.join(root, `${count}.db`))
      db.exec(`INSERT INTO actresses(id,main_name) VALUES(1,'Actor');
        WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${count})
        INSERT INTO actress_gallery_assets(id,actress_id,position,local_path,width,height)
        SELECT x,1,x%100,CASE WHEN x%5=0 THEN ' ' ELSE 'gallery/'||hex(zeroblob(128))||x||'.jpg' END,
          CASE WHEN x%2=0 THEN 640 ELSE 480 END,480 FROM n;
        ANALYZE;`)
      const legacy = () => prepareActressGalleryForDisplay(getActressMetadata(1)!.gallery)
      const expected = legacy()
      assert.equal(expected.length, count * 0.8)
      const metrics: unknown[] = []
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
        metrics.push({ name, samples, medianMs: [...samples].sort((a,b) => a-b)[1], jsonBytes })
      }
      measure('legacy.metadata+prepareGallery', legacy, value => assert.deepEqual(value, expected))
      const oldMetadata = getActressMetadata(1)!
      const { gallery: _gallery, ...fields } = oldMetadata
      measure('legacy.metadata', () => getActressMetadata(1)!, value => assert.deepEqual(value, oldMetadata))
      measure('profile.header', () => getActressProfile(1)!, value => {
        assert.deepEqual(value, { ...fields, gallery_count: count, display_gallery_count: expected.length, first_gallery: expected[0] ?? null })
      })
      for (const offset of [0, expected.length - 60]) {
        measure(`gallery.offset-${offset}`, () => listActressGalleryPage(1, { offset })!, value => {
          assert.equal(value.total, expected.length)
          assert.deepEqual(value.items, expected.slice(offset, offset + 60))
        })
      }
      const prepare = db.prepare.bind(db)
      let plan: unknown
      db.prepare = ((sql: string) => {
        if (sql.includes('ORDER BY CASE')) plan = prepare('EXPLAIN QUERY PLAN ' + sql).all(1,60,0)
        return prepare(sql)
      }) as typeof db.prepare
      try { listActressGalleryPage(1) } finally { db.prepare = prepare }
      assert.ok(Array.isArray(plan) && plan.length > 0)
      scales.push({ rows: count, visible: expected.length, metrics, pagePlan: plan })
      closeDatabase()
    }
    console.log(JSON.stringify({ scales, notes: [
      'ANALYZE, one warmup, three warm samples, median middle sample. Fixed legacy-first order.',
      'Old read includes metadata fetch and JS display preparation; returned JSON is prepared gallery only. New page includes total/limit/offset.',
      'Checks and JSON serialization excluded from timing. Oracle retained; no heap/RSS, p95, cold, Windows/HDD or IPC measurement.',
      'metadata and profile.header JSON measure complete returned objects; header adds two count scopes and the first visible picture instead of the full gallery.',
      'Sorting/count still scale with gallery size. Raw path strings are retained, so row cap is not a byte cap.'
    ] }, null, 2))
  } finally {
    closeDatabase(); resetSettingsCacheForTests()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
