import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { LibraryScanFileAuditEntry, LibraryScanPendingGroupAuditEntry } from '@shared/libraryTypes'
import { initDatabaseAtPath, closeDatabase } from './database'
import { createMediaLibrary } from './mediaLibraryRepo'
import { createScanAuditWriter } from './scanAuditWriter'
import { readPendingScanAuditEntries, visitPendingScanAuditEntriesForRun } from './pendingScanAuditRepo'

let directory: string, db: Database.Database, scope: { libraryId: number; runId: string }, rootId: number, otherId: number
let writer: ReturnType<typeof createScanAuditWriter>
function meta() { return { schemaVersion: 2 as const, ...scope, configRevision: 1,
  trigger: 'manual' as const, status: 'success' as const, startedAt: 'start', finishedAt: 'pending' } }
function pending(filePath: string, groupId: number | null): LibraryScanFileAuditEntry {
  return { rootId, filePath, sourceKind: 'local', outcome: 'pending', normalizedCode: null, groupId, addedToQueue: true }
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pending-entries-'))
  db = initDatabaseAtPath(path.join(directory, 'catalog.db'))
  const root = path.join(directory, 'media'), otherRoot = path.join(directory, 'other')
  fs.mkdirSync(root); fs.mkdirSync(otherRoot)
  const library = createMediaLibrary({ name: 'Pending', roots: [{ path: root }] })
  const other = createMediaLibrary({ name: 'Other', roots: [{ path: otherRoot }] })
  scope = { libraryId: library.id, runId: 'pending-run' }; rootId = library.roots[0].id; otherId = other.id
  db.prepare(`INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at)
    VALUES(?,?,1,'manual','running','start')`).run(scope.runId, scope.libraryId)
  writer = createScanAuditWriter(db, scope)
  writer.start(meta())
  const group = db.prepare('INSERT INTO pending_scan_groups(id,library_id,normalized_code,updated_at) VALUES(?,?,?,?)')
  for (const [id, code, updated] of [[10, 'TEN', 'b'], [20, 'TWENTY', 'a'], [30, 'EMPTY', 'a'], [40, 'UNREFERENCED', '0']] as const) {
    group.run(id, scope.libraryId, code, updated)
  }
  group.run(50, otherId, 'OTHER', '0')
  const resource = db.prepare(`INSERT INTO pending_scan_resources(library_id,group_id,root_id,file_path,normalized_path,source_kind)
    VALUES(?,?,?,?,?,'local')`)
  for (const [id, filePath, normalized] of [[10, '/Global', 'one'], [10, '/global', 'two'],
    [10, '/Global', 'duplicate'], [20, '/Global', 'cross-group'], [20, '/twenty', 'twenty'], [40, '/Global', 'unreferenced']] as const) {
    resource.run(scope.libraryId, id, rootId, filePath, normalized)
  }
  resource.run(otherId, 50, other.roots[0].id, '/Global', 'other')
})
afterEach(() => { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) })
function collect() {
  const result: LibraryScanPendingGroupAuditEntry[] = []
  visitPendingScanAuditEntriesForRun(db, scope, (entry) => { result.push(entry) })
  return result
}
function fixture() {
  const files = [pending('/reference-ten', 10), pending('/twenty', 20), pending('/empty', 30),
    pending('/Global', null), pending('/missing', 999), pending('/other', 50)]
  writer.writeBatch('files', files)
  return files
}

it('matches the legacy oracle with exact global paths, duplicate resources, empty/missing groups and library scope', () => {
  const files = fixture()
  const expected = readPendingScanAuditEntries(scope.libraryId,
    new Set(files.flatMap((entry) => entry.outcome === 'pending' && entry.groupId != null ? [entry.groupId] : [])),
    new Set(files.map((entry) => entry.filePath)))
  assert.deepEqual(collect(), expected)
  assert.deepEqual(expected, [
    { groupId: 20, normalizedCode: 'TWENTY', resourceCount: 2 },
    { groupId: 30, normalizedCode: 'EMPTY', resourceCount: 0 },
    { groupId: 10, normalizedCode: 'TEN', resourceCount: 2 }
  ])
})

it('uses final upsert outcomes and current pending metadata, with NFO unrelated to primary pending state', () => {
  fixture()
  writer.patchNfo('/Global', { disposition: 'warning', warnings: [{ code: 'nfo', message: 'warn' }] })
  assert.equal(collect()[0].resourceCount, 2)
  writer.writeBatch('files', [{ rootId, filePath: '/Global', sourceKind: 'local', outcome: 'unrecognized' }])
  writer.writeBatch('files', [pending('/twenty', null)])
  db.prepare("UPDATE pending_scan_groups SET normalized_code='LATEST',updated_at='0' WHERE id=10").run()
  assert.deepEqual(collect(), [
    { groupId: 10, normalizedCode: 'LATEST', resourceCount: 0 },
    { groupId: 30, normalizedCode: 'EMPTY', resourceCount: 0 }
  ])
  writer.writeBatch('files', [pending('/global', null)])
  assert.equal(collect()[0].resourceCount, 1)
})

it('runs actual writer callbacks under the read transaction without leaving an active iterator', () => {
  fixture()
  visitPendingScanAuditEntriesForRun(db, scope, (entry) => {
    assert.equal(db.inTransaction, true)
    writer.writeBatch('pendingGroups', [entry])
  })
  const saved = db.prepare("SELECT entry_json FROM library_scan_audit_entries WHERE run_id=? AND section='pendingGroups' ORDER BY ordinal")
    .all(scope.runId) as { entry_json: string }[]
  assert.deepEqual(saved.map((row) => JSON.parse(row.entry_json)), collect())
  assert.equal(db.inTransaction, false)
  db.pragma('journal_mode = DELETE')
})

it('rolls back outer business and audit writes on callback failure and closes the iterator for retry', () => {
  fixture()
  const name = db.prepare('SELECT name FROM media_libraries WHERE id=?').get(scope.libraryId)
  let calls = 0
  assert.throws(() => db.transaction(() => {
    db.prepare("UPDATE media_libraries SET name='changed' WHERE id=?").run(scope.libraryId)
    visitPendingScanAuditEntriesForRun(db, scope, (entry) => {
      writer.writeBatch('pendingGroups', [entry])
      if (++calls === 2) throw new Error('audit callback failed')
    })
  })(), /audit callback failed/)
  assert.equal(calls, 2)
  assert.deepEqual(db.prepare('SELECT name FROM media_libraries WHERE id=?').get(scope.libraryId), name)
  assert.equal(db.prepare("SELECT 1 FROM library_scan_audit_entries WHERE section='pendingGroups'").get(), undefined)
  assert.equal(db.inTransaction, false)
  db.pragma('journal_mode = DELETE')
  visitPendingScanAuditEntriesForRun(db, scope, (entry) => { writer.writeBatch('pendingGroups', [entry]) })
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM library_scan_audit_entries WHERE section='pendingGroups'").get(), { count: 3 })
})

it('rejects thenable visitors, observes rejected promises, and rolls back callback writes', async () => {
  fixture()
  for (const rejected of [false, true]) {
    assert.throws(() => visitPendingScanAuditEntriesForRun(db, scope, async (entry) => {
      writer.writeBatch('pendingGroups', [entry])
      if (rejected) throw new Error('async rejected')
    }), /must be synchronous/)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(db.inTransaction, false)
    assert.equal(db.prepare("SELECT 1 FROM library_scan_audit_entries WHERE section='pendingGroups'").get(), undefined)
  }
})

it('guards scope and manifest lifecycle even with no pending files', () => {
  assert.deepEqual(collect(), [])
  for (const invalid of [{ ...scope, libraryId: 0 }, { ...scope, runId: 'x'.repeat(257) },
    { ...scope, libraryId: otherId }, { ...scope, runId: 'missing' }]) {
    assert.throws(() => visitPendingScanAuditEntriesForRun(db, invalid, () => {}))
  }
  db.prepare(`INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at)
    VALUES('nostage',?,1,'manual','running','start')`).run(scope.libraryId)
  assert.throws(() => visitPendingScanAuditEntriesForRun(db, { ...scope, runId: 'nostage' }, () => {}), /collecting/)
  writer.seal(meta())
  assert.throws(() => collect(), /collecting/)
  db.prepare("UPDATE library_scan_audit_manifests SET state='abandoned' WHERE run_id=?").run(scope.runId)
  assert.throws(() => collect(), /collecting/)
  db.prepare("UPDATE library_scan_runs SET status='failed' WHERE id=?").run(scope.runId)
  assert.throws(() => collect(), /running/)
})

it('projects narrow SQL only and uses the exact file key lookup', () => {
  fixture()
  const originalPrepare = db.prepare, prepare = db.prepare.bind(db), statements: string[] = []
  db.prepare = ((sql: string) => {
    statements.push(sql)
    assert.doesNotMatch(sql, /SELECT\s+\*|SELECT\s+entry_json|target_locator|display_name/i)
    return prepare(sql)
  }) as typeof db.prepare
  try { assert.equal(collect().length, 3) } finally { db.prepare = originalPrepare }
  const insertSql = statements.find((statement) => statement.includes('WITH referenced'))!
  const sql = insertSql.slice(insertSql.indexOf('WITH referenced'))
  assert.match(sql, /entry_key=r.file_path COLLATE BINARY/)
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(scope) as { detail: string }[]
  assert.ok(plan.some((row) => /SEARCH f.*USING.*entry_key=/.test(row.detail)), JSON.stringify(plan))
})


it('snapshots metadata and counts before callbacks mutate live pending rows and cleans its TEMP result', () => {
  fixture()
  const expected = collect(), actual: LibraryScanPendingGroupAuditEntry[] = []
  visitPendingScanAuditEntriesForRun(db, scope, (entry) => {
    actual.push(entry)
    db.prepare("UPDATE pending_scan_groups SET normalized_code='CHANGED-'||id,updated_at='z' WHERE library_id=?").run(scope.libraryId)
    db.prepare('DELETE FROM pending_scan_resources WHERE library_id=?').run(scope.libraryId)
    writer.writeBatch('pendingGroups', [entry])
  })
  assert.deepEqual(actual, expected)
  assert.notDeepEqual(collect(), expected)
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'pending_scan_audit_visit_%'").all(), [])
})

it('delivers an oversized singleton unchanged for writer rejection and rolls back TEMP and callback writes', () => {
  fixture()
  const huge = '中'.repeat(400_000)
  db.prepare('UPDATE pending_scan_groups SET normalized_code=? WHERE id=30').run(huge)
  let sawHuge = false
  assert.throws(() => visitPendingScanAuditEntriesForRun(db, scope, (entry) => {
    if (entry.groupId === 30) { sawHuge = true; assert.equal(entry.normalizedCode, huge) }
    writer.writeBatch('pendingGroups', [entry])
  }), /1 MiB/)
  assert.equal(sawHuge, true)
  assert.equal(db.inTransaction, false)
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'pending_scan_audit_visit_%'").all(), [])
  assert.equal(db.prepare("SELECT 1 FROM library_scan_audit_entries WHERE section='pendingGroups'").get(), undefined)
})
