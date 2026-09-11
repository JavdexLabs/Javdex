import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { LibraryScanAudit } from '@shared/libraryTypes'
import { closeDatabase, initDatabaseAtPath } from '../db/database'
import { createMediaLibrary } from '../db/mediaLibraryRepo'
import { insertScannedVideo } from '../db/videoRepo'
import { readScanAuditSource } from '../db/scanAuditSource'
import { confirmLibraryPathRemoval, previewLibraryPathRemoval } from '../services/libraryPathCleanupService'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { createScanCoordinator } from './scanCoordinator'

let db: Database.Database, directory: string, previous: string | undefined
const size = 260
beforeEach(() => {
  previous = process.env.JAVDEX_TEST_USER_DATA
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-cleanup-recovery-'))
  process.env.JAVDEX_TEST_USER_DATA = directory
  db = initDatabaseAtPath(path.join(directory, 'catalog.db'))
})
afterEach(() => {
  closeDatabase(); resetSettingsCacheForTests()
  if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previous
  fs.rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const target = path.join(directory, 'target'), active = path.join(directory, 'active')
  fs.mkdirSync(target); fs.mkdirSync(active)
  const library = createMediaLibrary({ name: 'Recovery pages', roots: [{ path: target }, { path: active }] })
  const root = library.roots[0]
  db.prepare('UPDATE media_library_configs SET remove_resource_less_memberships=0 WHERE library_id=?').run(library.id)
  const resourceIds: number[] = []
  for (let index = 1; index <= size; index++) {
    const file = path.join(target, `REC-${index}.mp4`)
    fs.writeFileSync(file, 'video')
    const videoId = insertScannedVideo({ libraryId: library.id, rootId: root.id, code: `REC-${index}`, locator: file, size_bytes: 5 })!
    resourceIds.push((db.prepare('SELECT id FROM video_resources WHERE library_id=? AND video_id=?').get(library.id, videoId) as {id: number}).id)
  }
  const preview = previewLibraryPathRemoval({ libraryId: library.id, rootId: root.id })
  const job = confirmLibraryPathRemoval({ libraryId: library.id, rootId: root.id,
    expectedRevision: preview.libraryRevision, expectedImpactRevision: preview.impactRevision })
  const remaining = () => (db.prepare('SELECT id FROM video_resources WHERE library_id=? ORDER BY id').all(library.id) as {id: number}[]).map(row => row.id)
  const states = () => ({
    root: (db.prepare('SELECT state FROM media_library_roots WHERE id=?').get(root.id) as {state: string}).state,
    job: (db.prepare('SELECT state FROM library_root_cleanup_jobs WHERE id=?').get(job.jobId) as {state: string}).state
  })
  const audit = (runId: string) => JSON.parse(readScanAuditSource(db, { libraryId: library.id, runId }, 'body')!.body) as LibraryScanAudit
  const published = (runId: string, expectedStatus: string, removed: number) => {
    const run = db.prepare('SELECT status,summary_json,audit_json FROM library_scan_runs WHERE id=?').get(runId) as {status: string; summary_json: string; audit_json: null}
    assert.equal(run.status, expectedStatus)
    const summary = JSON.parse(run.summary_json)
    assert.equal(summary.resourcesRemoved, removed)
    assert.equal(summary.primaryResourcesPromoted, 0)
    assert.equal(summary.status, expectedStatus === 'completed' ? 'success' : expectedStatus)
    const state = db.prepare('SELECT active_run_id,last_status,last_summary_json FROM media_library_scan_state WHERE library_id=?')
      .get(library.id) as {active_run_id: string | null; last_status: string; last_summary_json: string}
    assert.equal(state.active_run_id, null)
    assert.equal(state.last_status, expectedStatus)
    assert.deepEqual(JSON.parse(state.last_summary_json), summary)
    assert.equal(run.audit_json, null)
    assert.deepEqual(db.prepare('SELECT state FROM library_scan_audit_manifests WHERE run_id=?').get(runId), { state: 'published' })
    assert.equal(audit(runId).status, summary.status)
    assert.equal(audit(runId).removedResources.length, removed)
    assert.ok(audit(runId).removedResources.every(entry => entry.reason === 'removed_library_path'))
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'scan_cleanup_%'").all(), [])
    assert.equal(db.inTransaction, false)
  }
  return { libraryId: library.id, root, job, resourceIds, remaining, states, audit, published }
}

it('cancels between deferred multi-video pages, publishes committed audit and retries remaining work', async () => {
  const current = fixture()
  let immediate: ReturnType<typeof setImmediate> | undefined, delivered = 0, atCancel = 0
  const coordinator = createScanCoordinator({ createRunId: () => 'cancel-deferred', recordCleanupAudit: (_scope, event) => {
    if (event.section !== 'removedResources' || event.entry.reason !== 'removed_library_path') return
    if (++delivered === 1) immediate = setImmediate(() => {
      assert.equal(db.inTransaction, false)
      atCancel = delivered
      coordinator.cancel()
    })
  } })
  try {
    const result = await coordinator.run({ libraryId: current.libraryId })
    assert.equal(result.cancelled, true)
    assert.equal(atCancel, 128)
    assert.equal(result.removed, 128)
    assert.equal(result.promoted, 0)
    assert.deepEqual(current.remaining(), current.resourceIds.slice(128))
    assert.deepEqual(current.states(), { root: 'pending_removal', job: 'pending' })
    current.published('cancel-deferred', 'cancelled', 128)
    assert.deepEqual(current.audit('cancel-deferred').removedResources.map(entry => entry.resourceId), current.resourceIds.slice(0, 128))
    const retry = await createScanCoordinator({ createRunId: () => 'cancel-retry' }).run({ libraryId: current.libraryId })
    assert.equal(retry.removed, size - 128)
    assert.deepEqual(current.remaining(), [])
    assert.deepEqual(current.states(), { root: 'disabled', job: 'completed' })
    current.published('cancel-retry', 'completed', size - 128)
  } finally { if (immediate) clearImmediate(immediate) }
})

it('native finish ABORT rolls root/job changes back while preserving all committed resource pages and truthful retry', async () => {
  const current = fixture()
  db.exec(`CREATE TEMP TRIGGER abort_cleanup_finish AFTER UPDATE ON library_root_cleanup_jobs
    WHEN NEW.id='${current.job.jobId}' AND NEW.state='completed'
      AND (SELECT state FROM media_library_roots WHERE id=NEW.root_id)='disabled'
      AND NOT EXISTS(SELECT 1 FROM video_resources WHERE library_id=NEW.library_id AND root_id=NEW.root_id)
    BEGIN SELECT RAISE(ABORT,'native finish failure'); END`)
  await assert.rejects(createScanCoordinator({ createRunId: () => 'finish-failed' }).run({ libraryId: current.libraryId }), /native finish failure/)
  assert.deepEqual(current.remaining(), [])
  assert.deepEqual(current.states(), { root: 'pending_removal', job: 'pending' })
  assert.deepEqual(db.prepare('SELECT started_at,completed_at FROM library_root_cleanup_jobs WHERE id=?').get(current.job.jobId), { started_at: null, completed_at: null })
  current.published('finish-failed', 'failed', size)
  assert.deepEqual(current.audit('finish-failed').removedResources.map(entry => entry.resourceId), current.resourceIds)
  db.exec('DROP TRIGGER abort_cleanup_finish')
  const retry = await createScanCoordinator({ createRunId: () => 'finish-retry' }).run({ libraryId: current.libraryId })
  assert.equal(retry.removed, 0)
  assert.deepEqual(current.states(), { root: 'disabled', job: 'completed' })
  current.published('finish-retry', 'completed', 0)
})

it('rejects changed root identity before the next deferred page and resumes only after restoring it', async () => {
  const current = fixture()
  const original = (db.prepare('SELECT normalized_real_path FROM media_library_roots WHERE id=?').get(current.root.id) as {normalized_real_path: string}).normalized_real_path
  let immediate: ReturnType<typeof setImmediate> | undefined, delivered = 0, changed = false
  const coordinator = createScanCoordinator({ createRunId: () => 'identity-failed', recordCleanupAudit: (_scope, event) => {
    if (event.section !== 'removedResources' || event.entry.reason !== 'removed_library_path') return
    if (++delivered === 1) immediate = setImmediate(() => {
      assert.equal(db.inTransaction, false)
      db.prepare('UPDATE media_library_roots SET normalized_real_path=? WHERE id=?').run(`${original}-changed`, current.root.id)
      changed = true
    })
  } })
  try {
    await assert.rejects(coordinator.run({ libraryId: current.libraryId }), /身份已变化/)
    assert.equal(changed, true)
    assert.equal(delivered, 128)
    assert.deepEqual(current.remaining(), current.resourceIds.slice(128))
    assert.deepEqual(current.states(), { root: 'pending_removal', job: 'pending' })
    current.published('identity-failed', 'failed', 128)
    db.prepare('UPDATE media_library_roots SET normalized_real_path=? WHERE id=?').run(original, current.root.id)
    const retry = await createScanCoordinator({ createRunId: () => 'identity-retry' }).run({ libraryId: current.libraryId })
    assert.equal(retry.removed, size - 128)
    assert.deepEqual(current.remaining(), [])
    assert.deepEqual(current.states(), { root: 'disabled', job: 'completed' })
    current.published('identity-retry', 'completed', size - 128)
  } finally { if (immediate) clearImmediate(immediate) }
})
