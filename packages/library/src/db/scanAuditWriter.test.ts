import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LibraryScanFileAuditEntry, LibraryScanSummary } from '@shared/libraryTypes'
import { initDatabaseAtPath, closeDatabase } from './database'
import { finishLibraryScanEntriesRun } from './libraryScanRepo'
import { createScanAuditWriter, type ScanAuditMetadata, SCAN_AUDIT_WRITE_MAX_BYTES } from './scanAuditWriter'
import { readScanAuditSource } from './scanAuditSource'

let db: Database.Database
let directory: string
const scope = { libraryId: 1, runId: 'writer-run' }
const meta = (finishedAt = 'pending'): ScanAuditMetadata => ({
  schemaVersion: 2, ...scope, configRevision: 1, trigger: 'manual',
  startedAt: 'start', finishedAt, status: 'success'
})
const file = (filePath: string): LibraryScanFileAuditEntry => ({
  rootId: 1, filePath, sourceKind: 'local', outcome: 'unrecognized'
})
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-audit-writer-'))
  db = initDatabaseAtPath(path.join(directory, 'catalog.db'))
  db.prepare(`INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at)
    VALUES(?,1,1,'manual','running','start')`).run(scope.runId)
})
afterEach(() => { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) })
function snapshot() {
  return {
    manifest: db.prepare('SELECT * FROM library_scan_audit_manifests').all(),
    entries: db.prepare('SELECT * FROM library_scan_audit_entries ORDER BY section,ordinal').all()
  }
}
function rows() {
  return db.prepare('SELECT section,ordinal,entry_key,entry_json,entry_bytes FROM library_scan_audit_entries ORDER BY section,ordinal')
    .all() as { section: string; ordinal: number; entry_key: string | null; entry_json: string; entry_bytes: number }[]
}

it('upserts exact file paths with stable ordinals, appends other sections and preserves UTF-8 bytes', () => {
  const writer = createScanAuditWriter(db, scope)
  writer.start(meta())
  writer.writeBatch('files', [file('/中文'), file('/B'), { ...file('/中文'), sourceKind: 'strm' }])
  writer.writeBatch('files', [file('/C'), file('/b')])
  writer.writeBatch('pendingGroups', [{ groupId: 1, normalizedCode: 'ABC', resourceCount: 0 }])
  writer.writeBatch('pendingGroups', [{ groupId: 1, normalizedCode: 'ABC', resourceCount: 2 }])
  const actual = rows()
  assert.deepEqual(actual.slice(0, 4).map((row) => [row.ordinal, row.entry_key]), [[0, '/中文'], [1, '/B'], [2, '/C'], [3, '/b']])
  assert.equal(JSON.parse(actual[0].entry_json).sourceKind, 'strm')
  assert.deepEqual(actual.slice(4).map((row) => [row.ordinal, row.entry_key]), [[0, null], [1, null]])
  for (const row of actual) assert.equal(row.entry_bytes, Buffer.byteLength(row.entry_json))
})

it('rolls back the entire batch including earlier upserts after a later SQL failure', () => {
  const writer = createScanAuditWriter(db, scope)
  writer.start(meta())
  writer.writeBatch('files', [file('/old')])
  const before = snapshot()
  db.exec(`CREATE TRIGGER reject_writer_test BEFORE INSERT ON library_scan_audit_entries
    WHEN NEW.entry_key='/reject' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)
  assert.throws(() => writer.writeBatch('files', [
    { ...file('/old'), sourceKind: 'strm' }, file('/new'), file('/reject')
  ]), /injected failure/)
  assert.deepEqual(snapshot(), before)
})

it('participates in caller transactions and uses savepoints for recoverable batch errors', () => {
  const writer = createScanAuditWriter(db, scope)
  const before = db.prepare('SELECT name FROM media_libraries WHERE id=1').get()
  assert.throws(() => db.transaction(() => {
    db.prepare("UPDATE media_libraries SET name='business' WHERE id=1").run()
    writer.start(meta())
    writer.writeBatch('files', [file('/atomic')])
    writer.seal(meta('finish'))
    throw new Error('outer failure')
  })(), /outer failure/)
  assert.deepEqual(snapshot(), { manifest: [], entries: [] })
  assert.deepEqual(db.prepare('SELECT name FROM media_libraries WHERE id=1').get(), before)
  writer.start(meta())
  db.exec(`CREATE TRIGGER reject_writer_test BEFORE INSERT ON library_scan_audit_entries
    WHEN NEW.entry_key='/reject' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)
  db.transaction(() => {
    db.prepare("UPDATE media_libraries SET name='committed' WHERE id=1").run()
    assert.throws(() => writer.writeBatch('files', [file('/rolled-back'), file('/reject')]), /injected failure/)
    writer.writeBatch('files', [file('/kept')])
  })()
  assert.deepEqual(rows().map((row) => row.entry_key), ['/kept'])
  assert.deepEqual(db.prepare('SELECT name FROM media_libraries WHERE id=1').get(), { name: 'committed' })
})

it('patches NFO in place without inserting missing files or losing the primary audit outcome', () => {
  const writer = createScanAuditWriter(db, scope)
  writer.start(meta())
  writer.writeBatch('files', [file('/file')])
  const nfo = { disposition: 'warning' as const, warnings: [{ code: 'warning', message: '中文警告' }] }
  assert.equal(writer.patchNfo('/file', nfo), true)
  assert.equal(writer.patchNfo('/missing', nfo), false)
  assert.equal(rows().length, 1)
  assert.equal(rows()[0].ordinal, 0)
  assert.deepEqual(JSON.parse(rows()[0].entry_json), { ...file('/file'), nfo })
  const before = snapshot()
  assert.throws(() => writer.patchNfo('/missing', { disposition: 'invalid' } as never), /Invalid audit entry/)
  assert.throws(() => writer.patchNfo('/file', { disposition: 'warning', warnings: [{ code: '', message: 'bad' }] }), /Invalid audit entry/)
  assert.deepEqual(snapshot(), before)
})

it('seals final metadata atomically, keeps the run running, and does not publish or permit late writes', () => {
  const writer = createScanAuditWriter(db, scope)
  writer.start(meta())
  writer.writeBatch('files', [file('/file')])
  const before = snapshot()
  db.exec(`CREATE TRIGGER reject_seal_test BEFORE UPDATE OF state ON library_scan_audit_manifests
    WHEN NEW.state='sealed' BEGIN SELECT RAISE(ABORT, 'seal failure'); END`)
  assert.throws(() => writer.seal(meta('finish')), /seal failure/)
  assert.deepEqual(snapshot(), before)
  db.exec('DROP TRIGGER reject_seal_test')
  writer.seal(meta('finish'))
  assert.deepEqual(db.prepare('SELECT state,meta_json FROM library_scan_audit_manifests').get(),
    { state: 'sealed', meta_json: JSON.stringify(meta('finish')) })
  assert.deepEqual(db.prepare('SELECT status,audit_json FROM library_scan_runs WHERE id=?').get(scope.runId),
    { status: 'running', audit_json: null })
  assert.equal(readScanAuditSource(db, scope, 'body'), undefined)
  const sealed = snapshot()
  assert.throws(() => writer.writeBatch('files', []), /not collecting/)
  assert.throws(() => writer.patchNfo('/missing', { disposition: 'imported' }), /not collecting/)
  assert.throws(() => writer.seal(meta('finish')), /not collecting/)
  assert.deepEqual(snapshot(), sealed)
})

it('seals unchanged metadata without a forbidden no-op metadata update', () => {
  const writer = createScanAuditWriter(db, scope)
  writer.start(meta('finish'))
  writer.seal(meta('finish'))
  assert.deepEqual(db.prepare('SELECT state FROM library_scan_audit_manifests').get(), { state: 'sealed' })
})

it('guards scope, running status and legacy JSON and snapshots scope against caller mutation', () => {
  assert.throws(() => createScanAuditWriter(db, { ...scope, libraryId: 0 }), /scope/)
  assert.throws(() => createScanAuditWriter(db, { ...scope, runId: 'x'.repeat(257) }), /scope/)
  const wrong = createScanAuditWriter(db, { ...scope, libraryId: 999 })
  assert.throws(() => wrong.start({ ...meta(), libraryId: 999 }), /belong/)
  const mutable = { ...scope }, writer = createScanAuditWriter(db, mutable)
  mutable.runId = 'other'
  writer.start(meta())
  assert.throws(() => wrong.writeBatch('files', [file('/wrong')]), /belong/)
  assert.throws(() => writer.start({ ...meta(), runId: 'other' }), /scope/)
  db.prepare("UPDATE library_scan_runs SET status='failed' WHERE id=?").run(scope.runId)
  assert.throws(() => writer.patchNfo('/missing', { disposition: 'imported' }), /running/)
  assert.throws(() => writer.seal(meta('finish')), /running/)
  db.prepare(`INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json)
    VALUES('legacy',1,1,'manual','running','start','{}')`).run()
  assert.throws(() => createScanAuditWriter(db, { ...scope, runId: 'legacy' }).start({ ...meta(), runId: 'legacy' }), /JSON-free/)
})

it('rejects malformed metadata and section shapes without writing anything', () => {
  const writer = createScanAuditWriter(db, scope)
  for (const invalid of [null, [], { ...meta(), files: [] }, { ...meta(), finishedAt: '' },
    { ...meta(), finishedAt: 'x'.repeat(101) }, { ...meta(), extra: 'x'.repeat(256 * 1024) }]) {
    assert.throws(() => writer.start(invalid as never))
  }
  writer.start(meta())
  const before = snapshot()
  assert.throws(() => writer.writeBatch('bad' as never, []), /section/)
  for (const [section, entry] of [
    ['files', {}], ['removedResources', {}], ['promotedResources', []],
    ['deletedVideos', { videoId: 1, videoCode: 'A', reason: 'resource_less' }],
    ['deletedVideos', { videoId: -1, videoCode: 'A', videoTitle: null, reason: 'resource_less' }],
    ['pendingGroups', { groupId: 1, normalizedCode: 'A', resourceCount: -1 }],
    ['pendingGroups', { groupId: 1, normalizedCode: '', resourceCount: 0 }]
  ] as const) assert.throws(() => writer.writeBatch(section, [entry] as never))
  const circular: Record<string, unknown> = { ...file('/circular') }; circular.self = circular
  assert.throws(() => writer.writeBatch('files', [circular] as never))
  assert.deepEqual(snapshot(), before)
})

it('enforces item, normalized batch and reserved single-page budgets without truncation', () => {
  const writer = createScanAuditWriter(db, scope)
  writer.start(meta())
  assert.throws(() => writer.writeBatch('files', Array.from({ length: 101 }, (_, i) => file(`/${i}`))), /100 items/)
  assert.throws(() => writer.writeBatch('files', [{ ...file('/big'), extra: '中'.repeat(400_000) }] as never), /batch exceeds/)
  // Fits the input array, but cannot fit a raw page after the reserved envelope.
  const base = { ...file('/edge'), extra: '' }
  const edge = { ...base, extra: 'x'.repeat(SCAN_AUDIT_WRITE_MAX_BYTES - Buffer.byteLength(JSON.stringify([base])) - 100) }
  assert.ok(Buffer.byteLength(JSON.stringify([edge])) < SCAN_AUDIT_WRITE_MAX_BYTES)
  assert.throws(() => writer.writeBatch('files', [file('/first'), edge] as never), /page exceeds/)
  assert.equal(rows().length, 0)
  writer.writeBatch('files', [file('/patch')])
  const before = snapshot()
  const hugeNfo = { disposition: 'imported', extra: 'x'.repeat(SCAN_AUDIT_WRITE_MAX_BYTES - 200) }
  assert.throws(() => writer.patchNfo('/patch', hugeNfo as never), /page exceeds/)
  assert.deepEqual(snapshot(), before)
  writer.writeBatch('files', Array.from({ length: 100 }, (_, i) => file(`/batch-${i}`)))
  assert.equal(rows().length, 101)
})

it('writes and patches all sections, seals, finishes through the actual repository, and reads compatibility output', () => {
  const writer = createScanAuditWriter(db, scope)
  const resource = { resourceId: 1, videoId: 1, videoCode: 'A', videoTitle: null,
    resourceKind: 'local' as const, sourcePath: null, displayName: null, reason: 'missing' as const }
  const deleted = { videoId: 1, videoCode: 'A', videoTitle: null, reason: 'resource_less' as const }
  const pending = { groupId: 1, normalizedCode: 'A', resourceCount: 1 }
  writer.start(meta())
  writer.writeBatch('files', [file('/file')])
  writer.writeBatch('removedResources', [resource])
  writer.writeBatch('promotedResources', [{ ...resource, reason: 'promoted_after_removal' }])
  writer.writeBatch('deletedVideos', [deleted])
  writer.writeBatch('pendingGroups', [pending])
  const nfo = { disposition: 'imported' as const, warnings: [] }
  assert.equal(writer.patchNfo('/file', nfo), true)
  writer.seal(meta('finish'))
  const summary: LibraryScanSummary = {
    ...scope, configRevision: 1, trigger: 'manual', startedAt: 'start', finishedAt: 'finish', status: 'success',
    scannedFiles: 1, resourcesAdded: 0, resourcesUpdated: 0, resourcesRemoved: 1, primaryResourcesPromoted: 1,
    videosDeleted: 1, skippedFiles: 0, failedFiles: 0, pendingScanGroups: 1, pendingScanResources: 1,
    offlineFolders: [], errorSummary: null
  }
  finishLibraryScanEntriesRun({ ...scope, status: 'completed', summary })
  assert.deepEqual(db.prepare('SELECT state FROM library_scan_audit_manifests').get(), { state: 'published' })
  assert.deepEqual(JSON.parse(readScanAuditSource(db, scope, 'body')!.body), {
    ...meta('finish'), files: [{ ...file('/file'), nfo }], removedResources: [resource],
    promotedResources: [{ ...resource, reason: 'promoted_after_removal' }], deletedVideos: [deleted], pendingGroups: [pending]
  })
})


it('rejects raw oversized stored entries before selecting their JSON for an NFO patch', () => {
  const writer = createScanAuditWriter(db, scope)
  writer.start(meta())
  const body = JSON.stringify({ ...file('/raw'), extra: 'x'.repeat(SCAN_AUDIT_WRITE_MAX_BYTES) })
  db.prepare(`INSERT INTO library_scan_audit_entries(run_id,section,ordinal,entry_key,entry_json,entry_bytes)
    VALUES(?,'files',0,'/raw',?,?)`).run(scope.runId, body, Buffer.byteLength(body))
  const originalPrepare = db.prepare, prepare = db.prepare.bind(db)
  let preflight = false
  db.prepare = ((sql: string) => {
    assert.doesNotMatch(sql, /SELECT\s+ordinal,entry_json/i)
    if (sql.startsWith('SELECT entry_bytes')) preflight = true
    return prepare(sql)
  }) as typeof db.prepare
  try {
    assert.throws(() => writer.patchNfo('/raw', { disposition: 'imported' }), /before hydration/)
    assert.equal(preflight, true)
  } finally { db.prepare = originalPrepare }
  assert.equal(rows()[0].entry_json, body)
})

it('reads only detached NFO values and distinguishes missing files from absent NFO', () => {
  const writer = createScanAuditWriter(db, scope)
  writer.start(meta())
  writer.writeBatch('files', [file('/empty'), file('/nfo')])
  writer.writeBatch('files', [{ ...file('/null'), nfo: null }] as never)
  const nfo = { disposition: 'warning' as const, warnings: [{ code: 'old', message: '保留旧警告' }], pendingScrapeId: 9 }
  writer.patchNfo('/nfo', nfo)
  assert.equal(writer.readFileNfo('/missing'), undefined)
  assert.deepEqual(writer.readFileNfo('/empty'), {})
  assert.deepEqual(writer.readFileNfo('/null'), {})
  const originalPrepare = db.prepare, prepare = db.prepare.bind(db)
  let projected = false
  db.prepare = ((sql: string) => {
    assert.equal(db.inTransaction, true)
    assert.doesNotMatch(sql, /SELECT\s+(?:ordinal,)?entry_json\b/i)
    if (sql.startsWith('SELECT json_type')) projected = true
    return prepare(sql)
  }) as typeof db.prepare
  try {
    const result = writer.readFileNfo('/nfo')!
    assert.deepEqual(result, { nfo })
    assert.equal(projected, true)
    result.nfo!.warnings![0].message = 'mutated'
    result.nfo!.warnings!.push({ code: 'new', message: 'new' })
    assert.deepEqual(writer.readFileNfo('/nfo'), { nfo })
  } finally { db.prepare = originalPrepare }
})

it('rejects invalid raw NFO values instead of treating them as absent', () => {
  const writer = createScanAuditWriter(db, scope)
  writer.start(meta())
  for (const nfo of [{}, [], 'imported', 1, { disposition: 'bad' },
    { disposition: 'warning', warnings: [{ code: '', message: 'bad' }] }]) {
    const body = JSON.stringify({ ...file('/raw'), nfo })
    db.prepare(`INSERT INTO library_scan_audit_entries(run_id,section,ordinal,entry_key,entry_json,entry_bytes)
      VALUES(?,'files',0,'/raw',?,?) ON CONFLICT(run_id,section,entry_key)
      DO UPDATE SET entry_json=excluded.entry_json,entry_bytes=excluded.entry_bytes`)
      .run(scope.runId, body, Buffer.byteLength(body))
    assert.throws(() => writer.readFileNfo('/raw'), /Invalid stored audit NFO/)
  }
})

it('checks NFO read scope and lifecycle even for missing paths', () => {
  const writer = createScanAuditWriter(db, scope)
  assert.throws(() => writer.readFileNfo('/missing'), /not collecting/)
  writer.start(meta())
  assert.throws(() => writer.readFileNfo(''), /file path/)
  assert.throws(() => createScanAuditWriter(db, { ...scope, libraryId: 999 }).readFileNfo('/missing'), /belong/)
  writer.seal(meta('finish'))
  assert.throws(() => writer.readFileNfo('/missing'), /not collecting/)
  db.prepare("UPDATE library_scan_runs SET status='failed' WHERE id=?").run(scope.runId)
  assert.throws(() => writer.readFileNfo('/missing'), /running/)
})

it('rejects oversized raw rows before projecting any NFO JSON', () => {
  const writer = createScanAuditWriter(db, scope)
  writer.start(meta())
  const body = JSON.stringify({ ...file('/large'), extra: 'x'.repeat(SCAN_AUDIT_WRITE_MAX_BYTES), nfo: { disposition: 'imported' } })
  db.prepare(`INSERT INTO library_scan_audit_entries(run_id,section,ordinal,entry_key,entry_json,entry_bytes)
    VALUES(?,'files',0,'/large',?,?)`).run(scope.runId, body, Buffer.byteLength(body))
  const originalPrepare = db.prepare, prepare = db.prepare.bind(db)
  let preflight = false
  db.prepare = ((sql: string) => {
    assert.doesNotMatch(sql, /entry_json/)
    if (sql.startsWith('SELECT entry_bytes')) preflight = true
    return prepare(sql)
  }) as typeof db.prepare
  try {
    assert.throws(() => writer.readFileNfo('/large'), /before hydration/)
    assert.equal(preflight, true)
  } finally { db.prepare = originalPrepare }
})
