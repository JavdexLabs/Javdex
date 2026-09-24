import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { LibraryScanSummary } from '@shared/libraryTypes'
import { initDatabaseAtPath, closeDatabase } from './database'
import { beginLibraryScanRun, finishLibraryScanEntriesRun, type LibraryUnrecognizedFileInput } from './libraryScanRepo'
import { createScanAuditWriter } from './scanAuditWriter'

let directory: string, db: Database.Database
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-unrecognized-publication-'))
  db = initDatabaseAtPath(path.join(directory, 'catalog.db'))
  db.exec(`INSERT INTO media_libraries(id,name) VALUES(2,'Other');
    INSERT INTO media_library_roots(id,library_id,path,normalized_path) VALUES(10,1,'/media','/media'),(20,2,'/other','/other');
    INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at)
      VALUES('old',1,1,'manual','completed','old'),('other',2,1,'manual','completed','old');
    INSERT INTO library_unrecognized_files(library_id,root_id,file_path,normalized_path,scan_run_id,last_seen_at)
      VALUES(1,10,'/media/old','/media/old','old','old'),(2,20,'/other/old','/other/old','other','old');`)
})
afterEach(() => { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) })
function prepare(runId: string, status: LibraryScanSummary['status'] = 'success') {
  const summary: LibraryScanSummary = { libraryId: 1, runId, configRevision: 1, trigger: 'manual', startedAt: 'start', finishedAt: 'finish', status,
    scannedFiles: 2, resourcesAdded: 0, resourcesUpdated: 0, resourcesRemoved: 0, primaryResourcesPromoted: 0, videosDeleted: 0,
    skippedFiles: 0, failedFiles: 0, pendingScanGroups: 0, pendingScanResources: 0, offlineFolders: [], errorSummary: null }
  beginLibraryScanRun({ libraryId: 1, runId, configRevision: 1, trigger: 'manual', startedAt: 'start' })
  const writer = createScanAuditWriter(db, { libraryId: 1, runId })
  const meta = { schemaVersion: 2 as const, libraryId: 1, runId, configRevision: 1, trigger: 'manual' as const,
    startedAt: 'start', finishedAt: 'finish', status }
  writer.start(meta)
  writer.writeBatch('files', [{ rootId: 10, filePath: '/media/new', sourceKind: 'local', outcome: 'unrecognized' }])
  writer.seal(meta)
  return summary
}
function finish(summary: LibraryScanSummary, files: Iterable<LibraryUnrecognizedFileInput>, status: 'completed' | 'failed' | 'cancelled' = 'completed') {
  finishLibraryScanEntriesRun({ libraryId: 1, runId: summary.runId, summary, status,
    replaceUnrecognizedRootIds: [10, 10], unrecognizedFiles: files })
}
const files: LibraryUnrecognizedFileInput[] = [
  { rootId: 10, filePath: '/media/a', normalizedPath: '/media/a' },
  { rootId: 20, filePath: '/other/ignored', normalizedPath: '/other/ignored' },
  { rootId: 10, filePath: '/media/b', normalizedPath: '/media/b', reason: 'test' }
]
function snapshot() {
  return ['library_scan_runs', 'media_library_scan_state', 'library_unrecognized_files',
    'library_scan_audit_manifests', 'library_scan_audit_entries'].map((table) => db.prepare(`SELECT * FROM ${table}`).all())
}
function pendingRows() {
  return db.prepare('SELECT library_id,root_id,file_path,normalized_path,reason FROM library_unrecognized_files ORDER BY library_id,normalized_path').all()
}

it('publishes array and generator inputs equivalently and filters roots without touching another library', () => {
  finish(prepare('array'), files)
  const expected = pendingRows()
  let enumerated = 0, closed = false
  function* input() { try { for (const file of files) { enumerated++; yield file } } finally { closed = true } }
  finish(prepare('generator'), input())
  assert.equal(enumerated, files.length)
  assert.equal(closed, true)
  assert.deepEqual(pendingRows(), expected)
  assert.deepEqual(db.prepare("SELECT state FROM library_scan_audit_manifests WHERE run_id='generator'").get(), { state: 'published' })
  assert.equal(expected.length, 3)
})

it('rolls back a native second INSERT failure, closes the generator, and retries', () => {
  const summary = prepare('insert-fault'), before = snapshot()
  db.exec(`CREATE TRIGGER fail_unrecognized_insert AFTER INSERT ON library_unrecognized_files
    WHEN NEW.file_path='/media/b' BEGIN SELECT RAISE(ABORT, 'native unrecognized fault'); END`)
  let closed = false, produced = 0
  function* input() { try { for (const file of files) { produced++; yield file } } finally { closed = true } }
  const failedAttempt = input()
  assert.throws(() => finish(summary, failedAttempt), /native unrecognized fault/)
  assert.equal(closed, true)
  assert.equal(produced, 3)
  assert.equal(failedAttempt.next().done, true)
  assert.deepEqual(snapshot(), before)
  db.exec('DROP TRIGGER fail_unrecognized_insert')
  finish(summary, input())
  assert.equal(produced, 6, 'retry factory must produce every input again')
  assert.deepEqual(db.prepare("SELECT state FROM library_scan_audit_manifests WHERE run_id='insert-fault'").get(), { state: 'published' })
})

for (const kind of ['next', 'authorization'] as const) {
  it(`rolls back iterator ${kind} failure after an earlier insert`, () => {
    const summary = prepare(kind), before = snapshot(), failure = new Error(`${kind} failed`)
    let closed = false
    function* input(): Generator<LibraryUnrecognizedFileInput> {
      try {
        yield files[0]
        if (kind === 'next') throw failure
        yield { get rootId(): number { throw failure }, filePath: '/media/b', normalizedPath: '/media/b' }
      } finally { closed = true }
    }
    assert.throws(() => finish(summary, input()), (error) => error === failure)
    assert.equal(closed, true)
    assert.deepEqual(snapshot(), before)
    finish(summary, files)
  })
}

it('rolls back all writes on late native publication failure after fully consuming the generator', () => {
  const summary = prepare('publish-fault'), before = snapshot()
  db.exec(`CREATE TRIGGER fail_unrecognized_publish AFTER UPDATE OF state ON library_scan_audit_manifests
    WHEN NEW.run_id='publish-fault' AND NEW.state='published'
    BEGIN SELECT RAISE(ABORT, 'native publication fault'); END`)
  let closed = false
  function* input() { try { yield* files } finally { closed = true } }
  assert.throws(() => finish(summary, input()), /native publication fault/)
  assert.equal(closed, true)
  assert.deepEqual(snapshot(), before)
  db.exec('DROP TRIGGER fail_unrecognized_publish')
  finish(summary, input())
})

for (const status of ['failed', 'cancelled'] as const) {
  it(`does not acquire or enumerate the iterable for ${status} runs`, () => {
    const summary = prepare(status, status), before = pendingRows()
    const input: Iterable<LibraryUnrecognizedFileInput> = {
      get [Symbol.iterator](): () => Iterator<LibraryUnrecognizedFileInput> { throw new Error('must not enumerate') }
    }
    finish(summary, input, status)
    assert.deepEqual(pendingRows(), before)
    assert.deepEqual(db.prepare('SELECT status FROM library_scan_runs WHERE id=?').get(status), { status })
    assert.deepEqual(db.prepare('SELECT state FROM library_scan_audit_manifests WHERE run_id=?').get(status), { state: 'published' })
  })
}

it('does not enumerate on scope validation failure or empty replacement roots, and rejects async-only input', () => {
  const summary = prepare('guarded'), before = snapshot()
  const input: Iterable<LibraryUnrecognizedFileInput> = {
    get [Symbol.iterator](): () => Iterator<LibraryUnrecognizedFileInput> { throw new Error('must not enumerate') }
  }
  assert.throws(() => finishLibraryScanEntriesRun({ libraryId: 2, runId: summary.runId, summary, status: 'completed',
    replaceUnrecognizedRootIds: [10], unrecognizedFiles: input }))
  assert.deepEqual(snapshot(), before)
  const asyncOnly = { async *[Symbol.asyncIterator]() { yield files[0] } }
  assert.throws(() => finish(summary, asyncOnly as never), /iterable/)
  assert.deepEqual(snapshot(), before)
  finishLibraryScanEntriesRun({ libraryId: 1, runId: summary.runId, summary, status: 'completed',
    replaceUnrecognizedRootIds: [], unrecognizedFiles: input })
})
