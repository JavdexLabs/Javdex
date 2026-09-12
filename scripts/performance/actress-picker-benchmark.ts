/** Synthetic candidate read probe; does not access a user database or media. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { closeDatabase, initDatabaseAtPath } from '../../apps/desktop/src/main/db/database'
import { listActresses, listActressPickerPage } from '../../apps/desktop/src/main/db/actressRepo'
import { resetSettingsCacheForTests } from '../../apps/desktop/src/main/settings/settingsStore'

it('measures narrow actor candidate pages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-picker-benchmark-'))
  const previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
  resetSettingsCacheForTests()
  try {
    const db = initDatabaseAtPath(path.join(root, 'catalog.db'))
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO actresses(id,main_name,gender,profile_summary)
        SELECT x,printf('Actor-%05d',x),'female',hex(zeroblob(2048)) FROM n;
      INSERT INTO actress_names(actress_id,name,type,source) SELECT id,main_name,'main','manual' FROM actresses;
      INSERT INTO actress_name_ownership(normalized_name,actress_id) SELECT normalize_actress_name(main_name),id FROM actresses;
      ANALYZE;`)
    const results: Array<{ name: string; samples: number[]; medianMs: number; jsonBytes: number }> = []
    function measure<T>(name: string, read: () => T, check: (value: T) => void) {
      check(read())
      const samples: number[] = []
      let jsonBytes = 0
      for (let i=0; i<3; i++) {
        const start = performance.now(); const value = read(); samples.push(performance.now()-start)
        check(value); jsonBytes = Buffer.byteLength(JSON.stringify(value))
      }
      results.push({ name, samples, medianMs: [...samples].sort((a,b)=>a-b)[1], jsonBytes })
    }
    const oracle = listActresses('', 'all')
    const labels = oracle.map(({ id, main_name, avatar_path }) => ({ id, main_name, avatar_path }))
    measure('legacy.full', () => listActresses('', 'all'), value => assert.deepEqual(value, oracle))
    measure('picker.first40', () => listActressPickerPage(), value => assert.deepEqual(value, { items: labels.slice(0,40), hasMore: true, offset: 0 }))
    measure('picker.deep40', () => listActressPickerPage({ offset: 9960 }), value => assert.deepEqual(value, { items: labels.slice(9960), hasMore: false, offset: 9960 }))
    const matching = listActresses('099', 'all').map(({ id, main_name, avatar_path }) => ({ id, main_name, avatar_path }))
    measure('picker.search', () => listActressPickerPage({ search: '099' }), value => assert.deepEqual(value, { items: matching.slice(0,40), hasMore: matching.length>40, offset: 0 }))
    const report = { actresses: 10000, profileCharacters: 4096, results, platform: process.platform,
      sqlite: db.prepare('SELECT sqlite_version() AS version').get(), caveats: [
        'Synthetic actors with4KiB profile text, no video edges/gallery, ANALYZE and warm-up;3warm samples, notp95/cold/Windows/HDD.',
        'All actors have zero video count in this fixture, so full-list and picker order coincide. Picker intentionally sorts by full name/ID, not video count.',
        'Old oracle remains live; no peak RSS claim. Timings exclude assertions and JSON serialization; bytes are JSON result sizes.',
        'Search uses existing owned-name semantics and may scan candidates; deep OFFSET still walks preceding rows. No O(page) or full IPC/frontend improvement claim.' ] }
    if (process.env.JAVDEX_PICKER_OUTPUT) fs.writeFileSync(process.env.JAVDEX_PICKER_OUTPUT, JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify(report))
  } finally {
    closeDatabase(); resetSettingsCacheForTests()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
