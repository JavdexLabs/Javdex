/** Synthetic decision probe; only finishLibraryScanRun is timed. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { LibraryScanAudit, LibraryScanSummary } from '../../src/shared/libraryTypes'
import { normalizeLocalPathIdentity } from '../../src/shared/localPathIdentity'
import { initDatabaseAtPath, closeDatabase } from '../../src/main/db/database'
import { beginLibraryScanRun, finishLibraryScanRun } from '../../src/main/db/libraryScanRepo'

it('measures actual scan finalization across root counts with consistent persisted results', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-finalization-roots-'))
  const count = 30_000
  const sourcePath = path.resolve('src/main/db/libraryScanRepo.ts')
  const sourceHash = (): string => createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex')
  const productionSha256 = sourceHash()
  const results: unknown[] = []
  try {
    for (const rootCount of [1, 100, 1000]) {
      const db = initDatabaseAtPath(path.join(directory, `${rootCount}.db`))
      const libraryId = 1
      const insertRoot = db.prepare('INSERT INTO media_library_roots(library_id,path,normalized_path,position) VALUES(?,?,?,?)')
      const rootIds = db.transaction(() => Array.from({ length: rootCount }, (_, i) => {
        const rootPath = path.join(directory, `roots-${rootCount}`, String(i))
        return Number(insertRoot.run(libraryId, rootPath, normalizeLocalPathIdentity(rootPath), i).lastInsertRowid)
      }))()
      const files = Array.from({ length: count }, (_, i) => {
        const filePath = path.join(directory, `roots-${rootCount}`, String(i % rootCount), `unknown-${i}.mp4`)
        return { rootId: rootIds[i % rootCount], filePath, normalizedPath: normalizeLocalPathIdentity(filePath) }
      })
      // Seed the same number of old rows before warmup, so every sample replaces 30k rows.
      db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,finished_at) VALUES('seed',?,1,'manual','completed','before','before')").run(libraryId)
      const seed = db.prepare('INSERT INTO library_unrecognized_files(library_id,root_id,file_path,normalized_path,scan_run_id,last_seen_at) VALUES(?,?,?,?,?,?)')
      db.transaction(() => { for (const file of files) seed.run(libraryId, file.rootId, file.filePath, file.normalizedPath, 'seed', 'before') })()
      const samples: number[] = []
      for (let sample = -1; sample < 3; sample++) {
        const runId = `roots-${rootCount}-sample-${sample}`
        const startedAt = '2026-09-11T00:00:00.000Z'
        const finishedAt = '2026-09-11T00:00:01.000Z'
        const summary: LibraryScanSummary = {
          libraryId, runId, configRevision: 1, trigger: 'manual', startedAt, finishedAt,
          status: 'success', scannedFiles: count, resourcesAdded: 0, resourcesUpdated: 0,
          resourcesRemoved: 0, primaryResourcesPromoted: 0, videosDeleted: 0,
          skippedFiles: 0, failedFiles: count, pendingScanGroups: 0, pendingScanResources: 0,
          offlineFolders: [], errorSummary: null
        }
        const audit: LibraryScanAudit = {
          schemaVersion: 2, libraryId, runId, configRevision: 1, trigger: 'manual', startedAt, finishedAt, status: 'success',
          files: files.map(file => ({ rootId: file.rootId, filePath: file.filePath, sourceKind: 'local', outcome: 'unrecognized' })),
          removedResources: [], promotedResources: [], deletedVideos: [], pendingGroups: []
        }
        beginLibraryScanRun({ libraryId, runId, configRevision: 1, trigger: 'manual', startedAt })
        const start = performance.now()
        finishLibraryScanRun({ libraryId, runId, status: 'completed', summary, audit, replaceUnrecognizedRootIds: rootIds, unrecognizedFiles: files })
        const elapsedMs = performance.now() - start
        // Verify the final committed run, summary and all paths together outside timing.
        db.transaction(() => {
          const run = db.prepare('SELECT status,summary_json,audit_json FROM library_scan_runs WHERE id=? AND library_id=?').get(runId, libraryId) as { status: string; summary_json: string; audit_json: string }
          assert.equal(run.status, 'completed')
          assert.deepEqual(JSON.parse(run.summary_json), summary)
          assert.deepEqual(JSON.parse(run.audit_json), audit)
          const state = db.prepare('SELECT active_run_id,last_status,last_summary_json FROM media_library_scan_state WHERE library_id=?').get(libraryId) as { active_run_id: string | null; last_status: string; last_summary_json: string }
          assert.equal(state.active_run_id, null)
          assert.equal(state.last_status, 'completed')
          assert.deepEqual(JSON.parse(state.last_summary_json), summary)
          const rows = db.prepare('SELECT root_id,file_path,normalized_path,scan_run_id FROM library_unrecognized_files WHERE library_id=? ORDER BY normalized_path').all(libraryId) as { root_id: number; file_path: string; normalized_path: string; scan_run_id: string }[]
          assert.equal(rows.length, count)
          const expected = new Map(files.map(file => [file.normalizedPath, file]))
          for (const row of rows) {
            const file = expected.get(row.normalized_path)
            assert.ok(file)
            assert.equal(row.root_id, file.rootId)
            assert.equal(row.file_path, file.filePath)
            assert.equal(row.scan_run_id, runId)
            expected.delete(row.normalized_path)
          }
          assert.equal(expected.size, 0)
        })()
        if (sample >= 0) samples.push(elapsedMs)
      }
      results.push({ rootCount, unrecognizedFiles: count, samplesMs: samples, medianMs: [...samples].sort((a, b) => a - b)[1] })
      closeDatabase()
    }
    assert.equal(sourceHash(), productionSha256, 'Production source changed during measurement; discard comparison')
  } finally {
    closeDatabase()
    fs.rmSync(directory, { recursive: true, force: true })
  }
  console.log(JSON.stringify({ productionSha256, runtime: process.versions, results, notes: [
    'Synthetic isolated databases; valid root rows inserted directly. No real source directories or user database are scanned.',
    'Fixed 1/100/1000-root order; each case 30000 entries distributed cyclically across roots. One warmup and three hot samples.',
    'Only finishLibraryScanRun is timed, including its JSON serialization, transaction and DELETE/INSERT work. Fixture, begin and verification excluded.',
    'Every sample replaces 30000 seeded/current rows; full audit/summary/path equality verified after commit. No fault-injection proof of crash atomicity.',
    'Not p95, cold/Windows/HDD, mixed load, memory peak or maximum SQL-variable boundary evidence; 1000 roots is below usual variable limits.'
  ] }, null, 2))
})
