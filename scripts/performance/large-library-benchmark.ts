/** Synthetic, disposable SQLite benchmark; never opens the user's library.
 * JAVDEX_BENCH_VIDEOS=300382 JAVDEX_BENCH_ANALYZE=1 JAVDEX_BENCH_OUTPUT=/tmp/results.json \
 * node scripts/run-electron-tests.mjs scripts/performance/large-library-benchmark.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { initDatabaseAtPath, closeDatabase } from '../../packages/library/src/db/database'
import { migrateDatabase } from '../../packages/library/src/db/migrations'
import { listVideos } from '../../packages/library/src/db/videoRepo'
import { createScopedVideoCatalogRepo } from '../../packages/library/src/db/scopedVideoCatalogRepo'
import { createHomeDiscoveryRepo } from '../../packages/library/src/db/homeDiscoveryRepo'
import { getTagLabels, listTagFilterOptions, listManualTagOptions, listTags, listManualTags } from '../../packages/library/src/db/tagRepo'
import { listActressPage } from '../../packages/library/src/db/actressRepo'
import { getLibraryOverviewStats } from '../../packages/library/src/db/overviewRepo'
import { getPlaylistDetail, getPlaylistPage, getPlaylistMetadata, listPlaylistVideoPage } from '../../packages/library/src/db/playlistRepo'
import { WebCatalog } from '../../apps/desktop/src/main/web/catalog'
import { tagQueryService } from '../../apps/desktop/src/main/services/tagQueryService'

const count = Number(process.env.JAVDEX_BENCH_VIDEOS ?? 10000)
assert.ok(Number.isSafeInteger(count) && count >= 1000 && count <= 1000000)
const analyzed = process.env.JAVDEX_BENCH_ANALYZE === '1'
const sparseManual = process.env.JAVDEX_BENCH_MANUAL_SPARSE === '1'
const statisticsProbe = process.env.JAVDEX_BENCH_STATS_PROBE ?? ''
const indexProbe = process.env.JAVDEX_BENCH_INDEX_PROBE ?? ''
const migrationFrom = process.env.JAVDEX_BENCH_MIGRATE_FROM ?? ''
assert.ok(['', '16'].includes(migrationFrom))
assert.ok(!migrationFrom || (!indexProbe && !statisticsProbe && !process.env.JAVDEX_BENCH_PROFILE),
  'Migration probes require the full matrix without other experiments')
const selectedCase = process.env.JAVDEX_BENCH_CASE ?? ''
assert.ok(!selectedCase || (indexProbe && /^[a-z_]+\.[a-z_]+$/.test(selectedCase)),
  'A focused case is only supported for index regression diagnosis')
assert.ok(['', 'tag-origin'].includes(indexProbe))
assert.ok(!indexProbe || (analyzed && !statisticsProbe && !process.env.JAVDEX_BENCH_PROFILE),
  'Index probes require the full analyzed matrix and cannot mix with statistics probes')
assert.ok(['', 'analyze', 'optimize'].includes(statisticsProbe))
assert.ok(!statisticsProbe || (!analyzed && !process.env.JAVDEX_BENCH_PROFILE), 'Statistics probes require the full un-analyzed matrix')
const experimentsOnly = process.env.JAVDEX_BENCH_PROFILE === 'experiments'
const coreOnly = process.env.JAVDEX_BENCH_PROFILE === 'core'
assert.ok(count <= 10000 || analyzed || coreOnly, 'Large default-statistics runs require PROFILE=core or ANALYZE=1 to bound pathological aggregation time')
const samples = Number(process.env.JAVDEX_BENCH_SAMPLES ?? 3)
assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 20)
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-library-bench-'))
const priorUserData = process.env.JAVDEX_TEST_USER_DATA
process.env.JAVDEX_TEST_USER_DATA = directory
const db = initDatabaseAtPath(path.join(directory, 'synthetic.db'))
const actors = Math.min(10000, Math.floor(count / 5))
const results: any[] = []
const plans = new Map<string, any>()
const statisticsRuns: any[] = []
const indexRuns: any[] = []
const probeActions: Array<{ name: string; action: () => any; before: any }> = []
let replayingProbe = false
// Preserve the released V15 tag-index comparison baseline in disposable index experiments.
if (indexProbe || migrationFrom) db.exec('DROP INDEX idx_video_tag_tag_id; CREATE INDEX idx_video_tag_tag_id ON video_tag(tag_id)')
if (migrationFrom) db.pragma('user_version = 16')
const rawPrepare = db.prepare.bind(db)
let current: { calls: number; sqlMs: number; statements: any[] } | null = null
// Record the real repository statements without changing their SQL or execution order.
;(db as any).prepare = (sql: string) => {
  const statement = rawPrepare(sql)
  return new Proxy(statement, { get(target, property) {
    const value = Reflect.get(target, property)
    if (typeof value !== 'function') return value
    if (!['get', 'all', 'run'].includes(String(property))) return value.bind(target)
    return (...params: any[]) => {
      const started = performance.now()
      const result = value.apply(target, params)
      if (current) {
        current.calls++
        current.sqlMs += performance.now() - started
        current.statements.push({ sql, params, method: property })
      }
      return result
    }
  } })
}
function measure(name: string, action: () => any) {
  if (selectedCase && name !== selectedCase && !name.endsWith(`.${selectedCase}`)) return { value: null, statements: [] }
  if (process.env.JAVDEX_BENCH_PROFILE === 'playlist' && !name.startsWith('playlist.')) return {value:null,statements:[]}
  if (process.env.JAVDEX_BENCH_PROFILE === 'startup' && name !== 'startup.current_schema') return {value:null,statements:[]}
  if (experimentsOnly && !/^(legacy.first|scoped.library|tags.all|experiment\.)$/.test(name) && !name.startsWith('experiment.')) return {value:null,statements:[]}
  if (coreOnly && /^(tags\.|actors\.|web\.|home\.)/.test(name)) return {value: null, statements: []}
  console.log(`BEGIN ${name}`)
  const times: number[] = []
  let trace: any
  let value: any
  for (let i = 0; i <= samples; i++) {
    current = { calls: 0, sqlMs: 0, statements: [] }
    const started = performance.now()
    value = action()
    times.push(performance.now() - started)
    trace = current
    current = null
  }
  for (const entry of trace.statements) {
    const planKey = statisticsProbe || indexProbe ? `${name}\0${entry.sql}` : entry.sql
    if (!plans.has(planKey)) {
      try { plans.set(planKey, { ...entry, caseName: name, plan: rawPrepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...entry.params) }) }
      catch { /* Some PRAGMA statements do not expose EQP. */ }
    }
  }
  const warm = times.slice(1).sort((a,b) => a-b)
  const bytes = Buffer.byteLength(JSON.stringify(value) ?? '')
  const row = { name, firstMs: times[0], warmMedianMs: warm[Math.floor(warm.length / 2)], warmMaxMs: warm.at(-1), samples,
    sqlCalls: trace.calls, sqlMsLast: trace.sqlMs, serializedBytes: bytes, rssBytesAfter: process.memoryUsage().rss }
  results.push(row)
  console.log(JSON.stringify(row))
  if ((statisticsProbe || indexProbe) && !replayingProbe) probeActions.push({ name, action, before: structuredClone(value) })
  return { value, statements: trace.statements }
}
function probeStatistics(stage: string): void {
  if (!statisticsProbe) return
  const actions = probeActions.splice(0)
  const priorLimit = db.pragma('analysis_limit', { simple: true }) as number
  const started = performance.now()
  try {
    if (statisticsProbe === 'analyze') db.exec('ANALYZE')
    else {
      // Explicit budget plus the current runtime's bounded-analysis bit. This
      // is an experiment, not an automatic production maintenance hook.
      db.pragma('analysis_limit = 1000')
      db.pragma('optimize = 0x10012')
    }
  } finally { db.pragma(`analysis_limit = ${priorLimit}`) }
  const elapsedMs = performance.now() - started
  const statRows = rawPrepare('SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx').all()
  replayingProbe = true
  try {
    for (const entry of actions) {
      const after = measure(`statistics.${stage}.${entry.name}`, entry.action)
      assert.deepEqual(after.value, entry.before, `Statistics changed results for ${entry.name}`)
    }
  } finally { replayingProbe = false }
  statisticsRuns.push({ stage, mode: statisticsProbe, elapsedMs, analysisLimitRestored: db.pragma('analysis_limit', { simple: true }),
    comparedCases: actions.map((entry) => entry.name), statRows })
}
function probeIndex(stage: string): void {
  if (!indexProbe) return
  const actions = probeActions.splice(0)
  assert.ok(actions.length > 0, 'Index probe must compare at least one case in each stage; JAVDEX_BENCH_CASE must name a single-library case')
  const replaceIndex = (fields: string) => db.transaction(() => {
    db.exec('DROP INDEX idx_video_tag_tag_id')
    db.exec(`CREATE INDEX idx_video_tag_tag_id ON video_tag(${fields})`)
  })()
  const started = performance.now()
  replaceIndex('tag_id,origin')
  db.exec('ANALYZE')
  const buildAndAnalyzeMs = performance.now() - started
  replayingProbe = true
  try {
    for (const entry of actions) {
      const after = measure(`index.${stage}.${entry.name}`, entry.action)
      assert.deepEqual(after.value, entry.before, `Index changed results for ${entry.name}`)
    }
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }])
  } finally {
    // Restore the baseline before adding overlapping library memberships so
    // each stage compares the same data with and without the candidate.
    try {
      replaceIndex('tag_id')
      db.exec('ANALYZE')
      if (selectedCase) {
        for (const entry of actions) {
          const restored = measure(`index-control.${stage}.${entry.name}`, entry.action)
          assert.deepEqual(restored.value, entry.before, `Restored index changed results for ${entry.name}`)
        }
      }
    } finally { replayingProbe = false }
  }
  indexRuns.push({ stage, candidate: indexProbe, buildAndAnalyzeMs,
    comparedCases: actions.map(entry => entry.name) })
}
try {
  const seedStart = performance.now()
  db.transaction(() => {
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${count})
      INSERT INTO videos(id,code,title,summary,release_date,rating,add_time)
      SELECT x,printf('TEST-%06d',x),'Synthetic movie '||x, printf('%0128d',x),
        CASE WHEN x%20=0 THEN NULL WHEN x%20=1 THEN '' WHEN x%20=2 THEN ' ' ELSE date('2000-01-01','+'||(x%9000)||' days') END,
        x%100/10.0,datetime('2020-01-01','+'||x||' seconds') FROM n;
      INSERT INTO library_video_memberships(library_id,video_id,added_at,discovery_key)
        SELECT 1,id,add_time,(id*1103515245+12345)%2147483648 FROM videos;
      INSERT INTO video_resources(library_id,video_id,kind,locator,resource_key,is_primary)
        SELECT 1,id,'direct','https://example.invalid/'||id||'.mp4','bench-'||id,1 FROM videos;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${actors})
        INSERT INTO actresses(id,main_name,gender) SELECT x,'Actor '||x,'female' FROM n;
      INSERT INTO actress_names(actress_id,name,type,is_primary) SELECT id,main_name,'main',1 FROM actresses;
      INSERT INTO actress_name_ownership(normalized_name,actress_id) SELECT 'actor'||id,id FROM actresses;
      INSERT INTO video_actress SELECT id,1+id%${actors} FROM videos;
      INSERT INTO video_actress SELECT id,1+(id+1)%${actors} FROM videos;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
        INSERT INTO tags(id,name) SELECT x,'Tag '||x FROM n;
      INSERT INTO video_tag(video_id,tag_id) SELECT id,1+id%1000 FROM videos;
      INSERT INTO video_tag(video_id,tag_id) SELECT id,1+(id+1)%1000 FROM videos;
      INSERT INTO video_tag(video_id,tag_id) SELECT id,1+(id+2)%1000 FROM videos;
      INSERT INTO video_tag(video_id,tag_id) SELECT id,1+(id+3)%1000 FROM videos;
      INSERT INTO video_tag(video_id,tag_id) SELECT id,1+(id+4)%1000 FROM videos WHERE id%3=0;
      ${sparseManual ? "UPDATE video_tag SET origin=CASE WHEN video_id%100=0 THEN 'manual' ELSE 'scraped' END;" : ''}
      INSERT INTO playlists(id,name) VALUES(1,'Synthetic large playlist');
      INSERT INTO playlist_video(playlist_id,video_id,position) SELECT 1,id,id FROM videos WHERE id<=30000;`)
  })()
  db.pragma('wal_checkpoint(TRUNCATE)')
  if (analyzed) db.exec('ANALYZE')
  const seedMs = performance.now() - seedStart
  measure('startup.current_schema', () => { migrateDatabase(db); return {schema: db.pragma('user_version',{simple:true})} })
  const catalog = createScopedVideoCatalogRepo(db)
  const web = new WebCatalog(db)
  const base = measure('legacy.first', () => listVideos({ limit: 60 }))
  measure('legacy.deep', () => listVideos({ limit: 60, offset: Math.max(0,count-60) }))
  measure('legacy.release', () => listVideos({ limit: 60, sortBy: 'release_date' }))
  measure('legacy.search_code', () => listVideos({ search: 'TEST-001234', limit: 60 }))
  const scopedBase = measure('scoped.library', () => catalog.list({ kind:'library',libraryId:1 }))
  measure('scoped.all_single_active', () => catalog.list({ kind:'all' }))
  measure('scoped.all_selected_one', () => catalog.list({ kind:'all',libraryIds:[1] }))
  measure('scoped.release', () => catalog.list({ kind:'library',libraryId:1 },{sortBy:'release_date'}))
  measure('scoped.search_code', () => catalog.list({ kind:'all' },{search:'TEST-001234'}))
  const tagsBase = measure('tags.all', () => listTags())
  measure('tags.manual', () => listManualTags())
  measure('tags.selected_labels', () => getTagLabels([1, 2, 3]))
  measure('tags.selected_labels_100', () => getTagLabels(Array.from({ length: 100 }, (_, i) => i + 1)))
  measure('tags.filter_options', () => listTagFilterOptions({}))
  measure('tags.filter_options_cached', () => tagQueryService.filterOptions({}))
  measure('tags.filter_options_invalidated', () => {
    // Same data, genuine SQLite write revision: measure the required miss path.
    db.prepare('UPDATE tags SET name=name WHERE id=1').run()
    return tagQueryService.filterOptions({})
  })
  measure('tags.filter_options_search', () => listTagFilterOptions({ search: 'Tag 99' }))
  measure('tags.filter_options_deep', () => listTagFilterOptions({ offset: 900 }))
  measure('tags.manual_options', () => listManualTagOptions({}))
  measure('tags.manual_options_search', () => listManualTagOptions({ search: 'Tag 99' }))
  measure('tags.manual_options_deep', () => listManualTagOptions({ offset: 900 }))
  measure('actors.first', () => listActressPage({ limit: 240 }))
  measure('overview', () => getLibraryOverviewStats())
  measure('home.single', () => createHomeDiscoveryRepo({database:db}).load({seed:'benchmark'}))
  measure('web.first', () => web.browse(new URLSearchParams()))
  measure('web.search', () => web.browse(new URLSearchParams('q=TEST-001234')))
  measure('web.collections', () => web.collections())
  measure('playlist.full', () => getPlaylistDetail(1))
  measure('playlist.page', () => getPlaylistPage(1, {limit:60}))
  measure('playlist.metadata', () => getPlaylistMetadata(1))
  measure('playlist.video_page', () => listPlaylistVideoPage(1, {limit:60}))
  measure('playlist.deep_page', () => getPlaylistPage(1, {limit:60, offset: Math.min(count, 30000) - 60}))
  // Diagnostic SQL experiment only. No production schema or query changes.
  for (const [index,entry] of base.statements.entries()) {
    const sql = entry.sql.replace('COUNT(DISTINCT v.id)', 'COUNT(*)').replace('SELECT DISTINCT v.*','SELECT v.*')
    const original = rawPrepare(entry.sql)[entry.method](...entry.params)
    const variant = rawPrepare(sql)[entry.method](...entry.params)
    assert.deepEqual(variant, original)
    measure(`experiment.no_distinct.${index}`, () => (db.prepare(sql) as any)[entry.method](...entry.params))
  }
  if (experimentsOnly) {
    for (const [index,entry] of scopedBase.statements.entries()) {
      const sql = entry.sql.replace('COUNT(DISTINCT v.id)', 'COUNT(*)').replace('SELECT DISTINCT v.*','SELECT v.*')
      assert.deepEqual(rawPrepare(sql)[entry.method](...entry.params),rawPrepare(entry.sql)[entry.method](...entry.params))
      measure(`experiment.scoped_no_distinct.${index}`, () => (db.prepare(sql) as any)[entry.method](...entry.params))
    }
    const tagsSql = `WITH members AS MATERIALIZED (
      SELECT DISTINCT m.video_id FROM library_video_memberships m JOIN media_libraries l ON l.id=m.library_id
      WHERE m.is_hidden=0 AND l.status='active'
    ), counts AS (
      SELECT vt.tag_id,COUNT(*) AS n FROM video_tag vt JOIN members m ON m.video_id=vt.video_id GROUP BY vt.tag_id
    ) SELECT t.*,COALESCE(c.n,0) AS video_count FROM tags t LEFT JOIN counts c ON c.tag_id=t.id
      ORDER BY video_count DESC,t.name`
    assert.deepEqual(rawPrepare(tagsSql).all(),tagsBase.value)
    measure('experiment.tags_preaggregate', () => db.prepare(tagsSql).all())
  }
  const singleLibraryActions = probeActions.map(({ name, action }) => ({ name, action }))
  probeStatistics('single-library')
  probeIndex('single-library')
  db.transaction(() => db.exec(`INSERT INTO media_libraries(id,name,status) VALUES(2,'Overlap','active');
    INSERT INTO media_library_configs(library_id) VALUES(2);
    INSERT INTO library_video_memberships(library_id,video_id,added_at,discovery_key)
      SELECT 2,video_id,added_at,discovery_key FROM library_video_memberships WHERE library_id=1 AND video_id%3=0;
    INSERT INTO video_resources(library_id,video_id,kind,locator,resource_key,is_primary)
      SELECT 2,video_id,kind,locator,resource_key,1 FROM video_resources WHERE library_id=1 AND video_id%3=0;`))()
  if (analyzed) db.exec('ANALYZE')
  // Capture fresh expected results after the write, rather than comparing with
  // the old single-library fixture. Replay the whole matrix in this state too.
  for (const entry of singleLibraryActions) measure(`overlap.${entry.name}`, entry.action)
  measure('scoped.all_overlap', () => catalog.list({kind:'all'}))
  measure('home.overlap', () => createHomeDiscoveryRepo({database:db}).load({seed:'benchmark'}))
  probeStatistics('after-overlap-write')
  probeIndex('after-overlap-write')
  const output = { baselineCommit: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    generatedAt: new Date().toISOString(), environment: { sqliteRuntime: rawPrepare('SELECT sqlite_version() AS version').get(), compileOptions: db.pragma('compile_options'), platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,totalMemory:os.totalmem(),versions:process.versions },
    fixture: { analyzed, sparseManual, statisticsProbe, indexProbe, migrationFrom, selectedCase, coreOnly, experimentsOnly, videos:count,actors,tags:1000,videoTags:rawPrepare('SELECT count(*) AS n FROM video_tag').get(),summaryBytes:128,seedMs,
      finalDatabaseBytes:(db.pragma('page_count',{simple:true}) as number) * (db.pragma('page_size',{simple:true}) as number) },
    pragmas: Object.fromEntries(['journal_mode','synchronous','cache_size','mmap_size','temp_store','busy_timeout','user_version'].map(p=>[p,db.pragma(p,{simple:true})])),
    caveats:['Synthetic data on local host; not the reporter Windows/HDD database.', 'First call is not cold-disk: fixture generation warms OS cache.', 'Three warm samples by default; median/max are not p95.', 'RSS after each case includes retained fixture/query memory and is not peak RSS.', 'SQL interception and timing bookkeeping are included; EQP and JSON byte calculation are outside the measured action.', 'Without a statistics or index probe, overlap library is added only for the last two cases. Probes replay the full matrix on fresh overlap results unless fixture.selectedCase is nonempty; focused diagnosis compares only that single-library case in each stage and additionally measures the restored baseline index. Index probes replace only the disposable tag index, compare full results, and restore the baseline index before the next stage. Full ANALYZE when fixture.analyzed=true; optional statisticsProbe explicitly records maintenance and result-equality checks. Probe analysis_limit is restored afterward.'],
    statisticsRuns, indexRuns, results,plans:[...plans.values()] }
  if (migrationFrom) {
    closeDatabase()
    const reopened = new Database(path.join(directory, 'synthetic.db'), { readonly: true })
    try {
      assert.equal(reopened.pragma('user_version', { simple: true }), 17)
      assert.deepEqual((reopened.pragma('index_info(idx_video_tag_tag_id)') as { name: string }[]).map(row => row.name), ['tag_id', 'origin'])
      assert.deepEqual(reopened.prepare('SELECT count(*) AS n FROM video_tag').get(), output.fixture.videoTags)
      assert.equal((reopened.prepare('SELECT count(*) AS n FROM videos').get() as { n: number }).n, count)
      assert.deepEqual(reopened.pragma('foreign_key_check'), [])
      assert.deepEqual(reopened.pragma('integrity_check'), [{ integrity_check: 'ok' }])
    } finally { reopened.close() }
  }
  if (process.env.JAVDEX_BENCH_OUTPUT) fs.writeFileSync(path.resolve(process.env.JAVDEX_BENCH_OUTPUT),JSON.stringify(output,null,2)+'\n')
} finally {
  closeDatabase()
  if(priorUserData===undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA=priorUserData
  fs.rmSync(directory,{recursive:true,force:true})
}
