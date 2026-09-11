/** Disposable real-repository experiment. No production schema changes. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { initDatabaseAtPath, closeDatabase } from '../../src/main/db/database'
import { listTags, listManualTags, listManualTagOptions } from '../../src/main/db/tagRepo'

const videos = Number(process.env.JAVDEX_TAG_BENCH_VIDEOS ?? 10000)
const samples = Number(process.env.JAVDEX_TAG_BENCH_SAMPLES ?? 3)
const distribution = process.env.JAVDEX_TAG_BENCH_DISTRIBUTION ?? 'all'
const candidate = process.env.JAVDEX_TAG_BENCH_INDEX ?? 'origin-first'
assert.ok(Number.isSafeInteger(videos) && videos >= 1000 && videos <= 300382)
assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 10)
assert.ok(['all', 'sparse', 'skew'].includes(distribution))
assert.ok(videos <= 10000 || distribution !== 'skew' || process.env.JAVDEX_TAG_BENCH_ALLOW_LARGE_SKEW === '1',
  'Skew baseline is pathological at 10k; validate the fixed plan before enabling ALLOW_LARGE_SKEW=1')
assert.ok(['origin-first', 'video-first', 'tag-origin'].includes(candidate))
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-tag-index-bench-'))
const databasePath = path.join(directory, 'synthetic.db')
const priorUserData = process.env.JAVDEX_TEST_USER_DATA
process.env.JAVDEX_TEST_USER_DATA = directory
const db = initDatabaseAtPath(databasePath)
// Preserve the released V15 tag-index comparison baseline in disposable index experiments.
db.exec('DROP INDEX idx_video_tag_tag_id; CREATE INDEX idx_video_tag_tag_id ON video_tag(tag_id)')
const rawPrepare = db.prepare.bind(db)
let plans: unknown[] = []
// EXPLAIN is captured outside timed calls.
let capture = false
;(db as any).prepare = (sql: string) => {
  const statement = rawPrepare(sql)
  return new Proxy(statement, { get(target, property) {
    const value = Reflect.get(target, property)
    if (typeof value !== 'function') return value
    if (!['all', 'get', 'run'].includes(String(property))) return value.bind(target)
    return (...params: unknown[]) => {
      if (capture) plans.push({ sql, params, plan: rawPrepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) })
      return value.apply(target, params)
    }
  } })
}
const results: unknown[] = []
const optionQueries = [
  { name: 'options.first', query: {} },
  { name: 'options.search', query: { search: 'Tag 99' } },
  { name: 'options.search_hit', query: { search: 'Tag 1' } },
  { name: 'options.page_hit', query: { offset: 2, limit: 1 } },
  { name: 'options.deep', query: { offset: 900 } },
  { name: 'options.missing', query: { search: 'absent' } }
]
function measureOptions(prefix: string) {
  return optionQueries.map(({ name, query }) => measureQuery(`${prefix}.${name}`, () => listManualTagOptions(query)))
}
function measureQuery(name: string, action: () => unknown) {
  capture = true
  const value = action()
  capture = false
  const times: number[] = []
  for (let i = 0; i <= samples; i++) {
    const start = performance.now()
    const result = action()
    times.push(performance.now() - start)
    assert.deepEqual(result, value)
  }
  const warm = times.slice(1).sort((a, b) => a - b)
  results.push({ name, firstTimedMs: times[0], warmMedianMs: warm[Math.floor(warm.length / 2)], times, plans })
  plans = []
  return value
}
function measureWrites(name: string) {
  db.pragma('wal_checkpoint(TRUNCATE)')
  const insert = rawPrepare("INSERT INTO video_tag(video_id,tag_id,origin) VALUES (?,1001,'manual')")
  const count = Math.min(1000, videos)
  const start = performance.now()
  db.transaction(() => { for (let id = 1; id <= count; id++) insert.run(id) })()
  db.transaction(() => db.exec("UPDATE video_tag SET origin='scraped' WHERE tag_id=1001"))()
  db.transaction(() => db.exec('DELETE FROM video_tag WHERE tag_id=1001'))()
  results.push({ name, rowsPerOperation: count, elapsedMs: performance.now() - start,
    walBytes: fs.statSync(databasePath + '-wal').size })
}
try {
  const origin = distribution === 'all' ? "'manual'" : distribution === 'sparse'
    ? "CASE WHEN id % 100 = 0 THEN 'manual' ELSE 'scraped' END"
    : "CASE WHEN id % 7 = 0 THEN 'manual' ELSE 'scraped' END"
  db.transaction(() => {
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${videos})
      INSERT INTO videos(id,code) SELECT x,'TAG-'||x FROM n;
      INSERT INTO library_video_memberships(library_id,video_id,added_at,is_hidden,discovery_key)
        SELECT 1,id,'2026',id%17=0,id FROM videos;
      INSERT INTO media_libraries(id,name,status) VALUES (2,'Shared','active'),(3,'Archived','archived');
      INSERT INTO library_video_memberships(library_id,video_id,added_at,discovery_key)
        SELECT 2,id,'2026',id FROM videos WHERE id%3=0;
      INSERT INTO library_video_memberships(library_id,video_id,added_at,discovery_key)
        SELECT 3,id,'2026',id FROM videos WHERE id%5=0;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001)
        INSERT INTO tags(id,name) SELECT x,'Tag '||x FROM n;`)
    for (let offset = 0; offset < 4; offset++) {
      const tag = distribution === 'skew' ? `${offset + 1}` : `1+(id+${offset})%1000`
      db.exec(`INSERT INTO video_tag(video_id,tag_id,origin) SELECT id,${tag},${origin} FROM videos`)
    }
  })()
  db.pragma('wal_checkpoint(TRUNCATE)')
  const baselineBytes = fs.statSync(databasePath).size
  const expectedAll = measureQuery('baseline.no_stats.all', listTags)
  const expectedManual = measureQuery('baseline.no_stats.manual', listManualTags)
  const expectedOptions = measureOptions('baseline.no_stats')
  for (const name of ['options.search_hit', 'options.page_hit']) {
    const page = expectedOptions[optionQueries.findIndex(entry => entry.name === name)] as ReturnType<typeof listManualTagOptions>
    assert.ok(page.items.length > 0, `${distribution} fixture must exercise a nonempty ${name}`)
  }
  db.exec('ANALYZE')
  assert.deepEqual(measureQuery('baseline.analyzed.all', listTags), expectedAll)
  assert.deepEqual(measureQuery('baseline.analyzed.manual', listManualTags), expectedManual)
  assert.deepEqual(measureOptions('baseline.analyzed'), expectedOptions)
  measureWrites('baseline.writes')
  const liveBytes = () => ((db.pragma('page_count', { simple: true }) as number)
    - (db.pragma('freelist_count', { simple: true }) as number)) * (db.pragma('page_size', { simple: true }) as number)
  const baselineLiveBytes = liveBytes()
  const fields = candidate === 'origin-first' ? 'origin,video_id,tag_id' : 'video_id,origin,tag_id'
  const buildStart = performance.now()
  if (candidate === 'tag-origin') {
    // Preserve the production query's explicit index name, but cover its origin
    // predicate. This is a disposable experiment, not a production migration.
    db.transaction(() => {
      db.exec('DROP INDEX idx_video_tag_tag_id')
      db.exec('CREATE INDEX idx_video_tag_tag_id ON video_tag(tag_id,origin)')
    })()
  } else db.exec(`CREATE INDEX benchmark_tag_cover ON video_tag(${fields})`)
  // Replace the narrow origin index only when its leading-key contract is retained.
  if (candidate === 'origin-first') db.exec('DROP INDEX idx_video_tag_origin')
  const indexBuildMs = performance.now() - buildStart
  db.pragma('wal_checkpoint(TRUNCATE)')
  const indexedBytes = fs.statSync(databasePath).size
  const indexedLiveBytes = liveBytes()
  assert.deepEqual(measureQuery('candidate.before_analyze.all', listTags), expectedAll)
  assert.deepEqual(measureQuery('candidate.before_analyze.manual', listManualTags), expectedManual)
  assert.deepEqual(measureOptions('candidate.before_analyze'), expectedOptions)
  db.exec('ANALYZE')
  assert.deepEqual(measureQuery('candidate.analyzed.all', listTags), expectedAll)
  assert.deepEqual(measureQuery('candidate.analyzed.manual', listManualTags), expectedManual)
  assert.deepEqual(measureOptions('candidate.analyzed'), expectedOptions)
  measureWrites('candidate.writes')
  assert.deepEqual(listTags(), expectedAll)
  assert.deepEqual(listManualTags(), expectedManual)
  assert.deepEqual(optionQueries.map(({ query }) => listManualTagOptions(query)), expectedOptions)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }])
  const output = { generatedAt: new Date().toISOString(), videos, samples, distribution, candidate,
    environment: { platform: process.platform, arch: process.arch, sqlite: rawPrepare('SELECT sqlite_version() AS version').get() },
    baselineBytes, indexedBytes, baselineLiveBytes, indexedLiveBytes, indexBuildMs, results,
    caveats: ['Synthetic local file, warm OS cache; three warm samples by default, not p95 or Windows/HDD.',
      'Full-result equality checks are outside timing; firstTimedMs follows an untimed EQP/result capture, not cold access.',
      'Candidate-before-analyze retains baseline statistics; this is not a wholly un-analyzed fixture.',
      'File sizes include freelist pages and prior write allocations; not isolated index live bytes. WAL bytes are file length, not device write volume.',
      'Write probe commits 1000 inserts, origin updates, deletes in three transactions; does not model full scan/import.'] }
  if (process.env.JAVDEX_TAG_BENCH_OUTPUT) fs.writeFileSync(path.resolve(process.env.JAVDEX_TAG_BENCH_OUTPUT), JSON.stringify(output, null, 2) + '\n')
  console.log(JSON.stringify({ videos, distribution, candidate, indexBuildMs, baselineBytes, indexedBytes, results }))
} finally {
  closeDatabase()
  if (priorUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = priorUserData
  fs.rmSync(directory, { recursive: true, force: true })
}
