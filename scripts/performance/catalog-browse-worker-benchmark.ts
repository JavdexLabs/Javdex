/** Disposable catalog, built production reader, warm local samples; never opens user data. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { closeDatabase, getDatabaseReadRevision, initDatabaseAtPath } from '../../src/main/db/database'
import { createScopedVideoCatalogRepo } from '../../src/main/db/scopedVideoCatalogRepo'
import { createHomeDiscoveryRepo } from '../../src/main/db/homeDiscoveryRepo'
import { CatalogReadWorkerClient } from '../../src/main/services/catalogReadWorkerClient'
import { createCatalogReadWorkerTransport } from '../../src/main/services/catalogReadWorkerTransport'

it('measures list/home/year reads, cache reuse, invalidation and event-loop gaps', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browse-bench-'))
  const count = Number(process.env.JAVDEX_BROWSE_BENCH_VIDEOS ?? 100000)
  assert.ok(Number.isSafeInteger(count) && count >= 1000 && count <= 300382)
  let client: CatalogReadWorkerClient | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    const file = path.join(root, 'catalog.db'), db = initDatabaseAtPath(file)
    db.transaction(() => {
      db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${count})
        INSERT INTO videos(id,code,title,release_date)
        SELECT x,printf('BROWSE-%07d',x),'Synthetic '||x,printf('%04d-01-01',2000+x%26) FROM n;
        INSERT INTO library_video_memberships(library_id,video_id,added_at,discovery_key)
        SELECT 1,id,'2026-01-01',id FROM videos;
        INSERT INTO media_libraries(id,name,icon,color,position,status,is_default,revision)
        VALUES(2,'Second','star','amber',1,'active',0,1);
        INSERT INTO media_library_configs(library_id) VALUES(2);
        INSERT INTO library_video_memberships(library_id,video_id,added_at,discovery_key)
        SELECT 2,id,'2026-02-01',id FROM videos WHERE id%2=0;`)
    })()
    const repo = createScopedVideoCatalogRepo(db), home = createHomeDiscoveryRepo({ database: db })
    client = new CatalogReadWorkerClient({
      contextProvider: () => {
        const revision = getDatabaseReadRevision(db)
        return { identity: db, path: file, revision: JSON.stringify([revision.changes, revision.dataVersion]) }
      },
      transportFactory: context => createCatalogReadWorkerTransport(path.resolve('out/main/catalogReadWorker.js'), context.path)
    })
    const scope = { kind: 'all' } as const
    const query = { search: 'Synthetic', limit: 36, sortBy: 'code' as const }
    const input = { seed: 'fixed-benchmark-seed', recentLimit: 12, discoveryLimit: 12 }
    const operations = [
      { name: 'global-list', main: () => repo.list(scope, query), worker: () => client!.readVideos(scope, query) },
      { name: 'home', main: () => home.load(input), worker: () => client!.readHome(input) },
      { name: 'years', main: () => repo.listYears(scope), worker: () => client!.readVideoYears(scope) }
    ]
    let last = performance.now(), maxGap = 0, ticks = 0
    timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++ }, 5)
    const results: unknown[] = []
    for (const operation of operations) {
      const expected = operation.main()
      for (const route of ['main', 'worker'] as const) {
        for (const mode of ['invalidated', 'cached'] as const) {
          const durations: number[] = [], gaps: number[] = [], tickCounts: number[] = []
          for (let sample = 0; sample < 3; sample++) {
            if (mode === 'invalidated') db.exec("UPDATE videos SET updated_at=COALESCE(updated_at,'')||'.' WHERE id=1")
            await new Promise(resolve => setTimeout(resolve, 10))
            last = performance.now(); maxGap = 0; ticks = 0
            const start = performance.now(), actual = await operation[route]()
            durations.push(performance.now() - start)
            await new Promise(resolve => setTimeout(resolve, 10))
            gaps.push(maxGap); tickCounts.push(ticks)
            // Timestamp mutations deliberately invalidate without changing projected membership/year semantics.
            if (operation.name === 'years') assert.deepEqual(actual, expected)
            else if (operation.name === 'global-list') {
              assert.equal((actual as { total: number }).total, count)
              assert.equal((actual as { items: unknown[] }).items.length, 36)
            } else assert.equal((actual as { seed: string }).seed, input.seed)
          }
          results.push({ operation: operation.name, route, mode, durationsMs: durations, maxTimerGapsMs: gaps, timerTicks: tickCounts })
        }
      }
      assert.deepEqual(await operation.worker(), operation.main())
    }
    const output = { videos: count, memberships: count + Math.floor(count / 2), results,
      sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get(),
      platform: process.platform, arch: process.arch, versions: process.versions,
      caveats: ['Synthetic metadata-only file database; three warm local samples, no ANALYZE, no customer data.',
        'Invalidation includes a committed write before timing. First worker sample includes startup.',
        'Timer gaps include scheduling and a 10 ms drain; samples are not p95 or renderer end-to-end latency.',
        'Does not establish Windows/HDD, cold storage, sustained writer contention or hard SQL cancellation guarantees.'] }
    if (process.env.JAVDEX_BROWSE_BENCH_OUTPUT) fs.writeFileSync(path.resolve(process.env.JAVDEX_BROWSE_BENCH_OUTPUT), JSON.stringify(output, null, 2) + '\n')
    console.log(JSON.stringify(output))
  } finally {
    if (timer) clearInterval(timer)
    await client?.dispose()
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
