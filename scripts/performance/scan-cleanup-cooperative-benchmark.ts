/** Real coordinator/audit commits on disposable catalogs, with file scanning stubbed empty. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { ScanResult } from '../../src/shared/libraryTypes'
import { initDatabaseAtPath, closeDatabase } from '../../src/main/db/database'
import { createMediaLibrary } from '../../src/main/db/mediaLibraryRepo'
import { createScanCoordinator } from '../../src/main/scanner/scanCoordinator'
import { resetSettingsCacheForTests } from '../../src/main/settings/settingsStore'

it('compares atomic and cooperative membership cleanup including durable audit and finalization', async () => {
  const count = Number(process.env.JAVDEX_CLEANUP_BENCH_VIDEOS ?? 10000)
  assert.ok(Number.isSafeInteger(count) && count >= 1000 && count <= 100000)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-cooperative-bench-'))
  const previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
  const results: unknown[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    for (const mode of ['atomic', 'cooperative'] as const) for (let sample = 0; sample < 3; sample++) {
      const fixture = path.join(root, `${mode}-${sample}`)
      fs.mkdirSync(fixture)
      const media = path.join(fixture, 'media'); fs.mkdirSync(media)
      const db = initDatabaseAtPath(path.join(fixture, 'catalog.db'))
      const library = createMediaLibrary({ name: 'Benchmark', roots: [{ path: media }] })
      db.prepare('UPDATE media_library_configs SET remove_resource_less_memberships=1 WHERE library_id=?').run(library.id)
      db.transaction(() => {
        db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${count})
          INSERT INTO videos(id,code,title) SELECT x,'CLEANUP-'||x,'Synthetic '||x FROM n;
          INSERT INTO library_video_memberships(library_id,video_id,discovery_key)
          SELECT ${library.id},id,id FROM videos;
          INSERT INTO library_video_memberships(library_id,video_id,discovery_key)
          SELECT 1,id,id FROM videos;`)
      })()
      const runId = `${mode}-${sample}`
      let last = performance.now(), maxGap = 0, ticks = 0, ticksAtFirst = -1, ticksAtLast = -1
      let auditWrites = 0
      const coordinator = createScanCoordinator({ cleanupMode: mode, createRunId: () => runId,
        scanFolders: async scope => ({ ...scope, scannedFiles: 0, imported: 0, skipped: 0,
          skippedShort: 0, failed: 0, pendingGroups: 0, pendingResources: 0, relocated: 0,
          refreshed: 0, removed: 0, promoted: 0, deletedVideos: 0, offlineFolders: [], newCodes: [],
          unrecognizedFiles: [], strmFailures: [], omittedStrmFailures: 0 } as ScanResult),
        recordCleanupAudit: (_scope, event) => {
          assert.equal(db.inTransaction, true)
          if (event.section !== 'deletedVideos') return
          auditWrites++
          if (auditWrites === 1) ticksAtFirst = ticks
          if (auditWrites === count) ticksAtLast = ticks
        }
      })
      timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++ }, 5)
      const start = performance.now()
      last = start
      const result = await coordinator.run({ libraryId: library.id })
      const durationMs = performance.now() - start
      await new Promise(resolve => setTimeout(resolve, 10))
      clearInterval(timer); timer = undefined
      assert.equal(result.deletedVideos, count)
      assert.equal(auditWrites, count)
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM library_scan_audit_entries WHERE run_id=? AND section='deletedVideos'").get(runId) as { n: number }).n, count)
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM library_video_memberships WHERE library_id=?').get(library.id) as { n: number }).n, 0)
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM library_video_memberships WHERE library_id=1').get() as { n: number }).n, count)
      assert.equal((db.prepare('SELECT state FROM library_scan_audit_manifests WHERE run_id=?').get(runId) as { state: string }).state, 'published')
      assert.deepEqual(db.pragma('foreign_key_check'), [])
      if (mode === 'cooperative') assert.ok(ticksAtLast > ticksAtFirst)
      results.push({ mode, sample, durationMs, maxTimerGapMs: maxGap, ticksDuringCleanup: ticksAtLast - ticksAtFirst,
        auditWrites, sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get() })
      await coordinator.stopAndDrain()
      closeDatabase(); resetSettingsCacheForTests()
    }
    const output = { videos: count, results, platform: process.platform, arch: process.arch,
      caveats: ['Three warm local synthetic samples per mode; real SQLite audit writes and final publication, empty stubbed file scan.',
        'Only resource-less membership stage measured; pending/deferred/FS stages need independent workload measurements.',
        'Timer drain includes terminal synchronous publication. Not Windows/HDD, p95, hard deadline, or crash recovery benchmark.'] }
    if (process.env.JAVDEX_CLEANUP_BENCH_OUTPUT) fs.writeFileSync(path.resolve(process.env.JAVDEX_CLEANUP_BENCH_OUTPUT), JSON.stringify(output, null, 2) + '\n')
    console.log(JSON.stringify(output))
  } finally {
    if (timer) clearInterval(timer)
    closeDatabase(); resetSettingsCacheForTests()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
