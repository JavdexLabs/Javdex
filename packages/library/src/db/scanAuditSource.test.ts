import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initDatabaseAtPath, closeDatabase, getDb } from './database'
import { createMediaLibrary } from './mediaLibraryRepo'
import { readScanAuditSource } from './scanAuditSource'
let directory: string, filename: string, libraryId: number, otherId: number
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-audit-source-'))
  filename = path.join(directory, 'db.sqlite')
  initDatabaseAtPath(filename)
  const first = path.join(directory, 'first'); fs.mkdirSync(first)
  libraryId = createMediaLibrary({ name: 'Source', roots: [{ path: first }] }).id
  const other = path.join(directory, 'other'); fs.mkdirSync(other)
  otherId = createMediaLibrary({ name: 'Other', roots: [{ path: other }] }).id
})
afterEach(() => { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) })
function insert(id: string, body: string | null, started = 'same', library = libraryId, status = 'completed') {
  getDb().prepare(`INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json)
    VALUES(?,?,1,'manual',?,?,?)`).run(id, library, status, started, body)
}

it('keeps exact-run and latest non-NULL policies distinct, scoped and deterministically ordered', () => {
  insert('old', '{"old":true}', 'a')
  insert('tie-a', '{"a":true}')
  insert('tie-b', '{"b":true}')
  insert('new-null', null, 'z')
  insert('other-new', '{}', 'zz', otherId)
  const db = getDb()
  assert.deepEqual(readScanAuditSource(db, { libraryId, latest: true }, 'identity'), { format: 'json', libraryId, runId: 'tie-b' })
  assert.equal(readScanAuditSource(db, { libraryId, runId: 'new-null' }, 'body'), undefined)
  assert.equal(readScanAuditSource(db, { libraryId, runId: 'other-new' }, 'identity'), undefined)
  assert.equal(readScanAuditSource(db, { libraryId, runId: 'missing' }, 'bytes'), undefined)
  assert.deepEqual(readScanAuditSource(db, { libraryId, runId: 'old' }, 'body'), { format: 'json', libraryId, runId: 'old', body: '{"old":true}' })
})

it('does not silently filter empty, malformed, or nonterminal legacy audit bodies', () => {
  insert('empty', '', 'a', libraryId, 'running')
  insert('bad', '{bad', 'b', libraryId, 'failed')
  assert.deepEqual(readScanAuditSource(getDb(), { libraryId, runId: 'empty' }, 'bytes'), { format: 'json', libraryId, runId: 'empty', bytes: 0 })
  assert.equal(readScanAuditSource(getDb(), { libraryId, latest: true }, 'body')?.body, '{bad')
})

it('projects only requested fields and counts raw UTF-8 bytes including NUL', () => {
  const body = '中文\0payload'
  insert('bytes', body)
  const db = getDb(), originalPrepare = db.prepare, prepare = db.prepare.bind(db), sql: string[] = []
  db.prepare = ((statement: string) => { sql.push(statement); return prepare(statement) }) as typeof db.prepare
  try {
    assert.deepEqual(readScanAuditSource(db, { libraryId, runId: 'bytes' }, 'identity'), { format: 'json', libraryId, runId: 'bytes' })
    const identitySql = sql.pop()!
    assert.match(identitySql, /^SELECT r\.id,/)
    assert.doesNotMatch(identitySql, /AS body|meta_json|entry_json|entry_bytes|length\(CAST/i)
    assert.deepEqual(readScanAuditSource(db, { libraryId, runId: 'bytes' }, 'bytes'), { format: 'json', libraryId, runId: 'bytes', bytes: Buffer.byteLength(body) })
    assert.doesNotMatch(sql.pop()!, /AS body/)
    assert.deepEqual(readScanAuditSource(db, { libraryId, runId: 'bytes' }, 'body'), { format: 'json', libraryId, runId: 'bytes', body })
  } finally { db.prepare = originalPrepare }
})

it('binds literal run IDs and leaves snapshot ownership with the reader transaction', () => {
  const id = "' OR 1=1 --"
  insert(id, 'before')
  const db = getDb(), writer = new Database(filename)
  try {
    db.transaction(() => {
      const selected = readScanAuditSource(db, { libraryId, runId: id }, 'identity')!
      writer.prepare('UPDATE library_scan_runs SET audit_json=? WHERE id=?').run('after', id)
      assert.equal(readScanAuditSource(db, selected, 'body')?.body, 'before')
    })()
    assert.equal(readScanAuditSource(db, { libraryId, runId: id }, 'body')?.body, 'after')
  } finally { writer.close() }
})


function staged(
  id: string,
  state: 'collecting' | 'sealed' | 'published' | 'abandoned' = 'published',
  overrides: Record<string, unknown> = {},
  rows: { section: string; ordinal: number; key: string | null; entry: Record<string, unknown> }[] = [],
  library = libraryId
) {
  insert(id, null, 'same', library, 'running')
  const meta = { schemaVersion: 2, libraryId: library, runId: id, configRevision: 1,
    trigger: 'manual', status: 'success', startedAt: 'same', finishedAt: 'finish', ...overrides }
  const db = getDb(), metaJson = JSON.stringify(meta)
  db.prepare('INSERT INTO library_scan_audit_manifests(run_id,meta_json) VALUES(?,?)').run(id, metaJson)
  for (const row of rows) {
    const body = JSON.stringify(row.entry)
    db.prepare(`INSERT INTO library_scan_audit_entries(run_id,section,ordinal,entry_key,entry_json,entry_bytes)
      VALUES(?,?,?,?,?,?)`).run(id, row.section, row.ordinal, row.key, body, Buffer.byteLength(body))
  }
  if (state === 'sealed' || state === 'published') {
    db.prepare("UPDATE library_scan_audit_manifests SET state='sealed',sealed_at='seal' WHERE run_id=?").run(id)
  }
  if (state === 'published') db.transaction(() => {
    db.prepare("UPDATE library_scan_runs SET status='completed',finished_at='finish' WHERE id=?").run(id)
    db.prepare("UPDATE library_scan_audit_manifests SET state='published',published_at='publish' WHERE run_id=?").run(id)
  })()
  if (state === 'abandoned') {
    db.prepare("UPDATE library_scan_audit_manifests SET state='abandoned' WHERE run_id=?").run(id)
  }
  return { meta, metaJson }
}

it('selects only published entries, scopes exact reads, and orders mixed formats by the same timestamp/id', () => {
  const db = getDb()
  insert('a-json', '{}')
  staged('b-entries')
  for (const state of ['collecting', 'sealed', 'abandoned'] as const) {
    const id = `z-${state}`
    staged(id, state)
    for (const projection of ['identity', 'bytes', 'body'] as const) {
      // Each overload is literal at the call boundary.
      const selected = projection === 'identity' ? readScanAuditSource(db, { libraryId, runId: id }, 'identity')
        : projection === 'bytes' ? readScanAuditSource(db, { libraryId, runId: id }, 'bytes')
          : readScanAuditSource(db, { libraryId, runId: id }, 'body')
      assert.equal(selected, undefined)
    }
  }
  staged('other-entries', 'published', {}, [], otherId)
  assert.equal(readScanAuditSource(db, { libraryId, runId: 'other-entries' }, 'body'), undefined)
  assert.deepEqual(readScanAuditSource(db, { libraryId, latest: true }, 'identity'),
    { format: 'entries', libraryId, runId: 'b-entries' })
  insert('c-json', '{bad')
  assert.equal(readScanAuditSource(db, { libraryId, latest: true }, 'body')?.body, '{bad')
  insert('earlier-id-later-time', '{}', 'z')
  assert.equal(readScanAuditSource(db, { libraryId, latest: true }, 'identity')?.runId, 'earlier-id-later-time')
})

it('reconstructs all five ordered arrays and counts stored UTF-8 payload without hydrating identity/bytes', () => {
  const file = (filePath: string) => ({ rootId: 1, filePath, sourceKind: 'local', outcome: 'added' })
  const resource = { resourceId: 1, videoId: 2, videoCode: '中文', sourcePath: null }
  const rows = [
    { section: 'files', ordinal: 20, key: '/后', entry: file('/后') },
    { section: 'files', ordinal: 2, key: '/先', entry: file('/先') },
    { section: 'removedResources', ordinal: 0, key: null, entry: resource },
    { section: 'promotedResources', ordinal: 0, key: null, entry: resource },
    { section: 'deletedVideos', ordinal: 0, key: null, entry: { videoId: 2, videoCode: '中文' } },
    { section: 'pendingGroups', ordinal: 0, key: null, entry: { groupId: 3, note: '待办' } }
  ]
  const { meta, metaJson } = staged('payload', 'published', { note: '中文\0元数据' }, rows)
  const db = getDb(), originalPrepare = db.prepare, prepare = db.prepare.bind(db), sql: string[] = []
  db.prepare = ((statement: string) => { sql.push(statement); return prepare(statement) }) as typeof db.prepare
  try {
    assert.equal(readScanAuditSource(db, { libraryId, runId: 'payload' }, 'identity')?.format, 'entries')
    assert.doesNotMatch(sql.pop()!, /meta_json|entry_json|entry_bytes/)
    const storedBytes = Buffer.byteLength(metaJson) + rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.entry)), 0)
    assert.deepEqual(readScanAuditSource(db, { libraryId, runId: 'payload' }, 'bytes'),
      { format: 'entries', libraryId, runId: 'payload', bytes: storedBytes })
    assert.doesNotMatch(sql.pop()!, /entry_json|AS body/)
    const body = readScanAuditSource(db, { libraryId, runId: 'payload' }, 'body')!.body
    assert.deepEqual(JSON.parse(body), { ...meta, files: [file('/先'), file('/后')],
      removedResources: [resource], promotedResources: [resource],
      deletedVideos: [rows[4].entry], pendingGroups: [rows[5].entry] })
    assert.notEqual(Buffer.byteLength(body), storedBytes)
  } finally { db.prepare = originalPrepare }
})

it('throws for inconsistent new metadata, embedded sections, invalid final audits, and mismatched file keys', () => {
  insert('older-json', '{}', 'a')
  const invalid = [
    { libraryId: otherId }, { runId: 'wrong' }, { finishedAt: 'wrong' }, { schemaVersion: 99 },
    ...['files', 'removedResources', 'promotedResources', 'deletedVideos', 'pendingGroups'].map((key) => ({ [key]: [] }))
  ]
  invalid.forEach((meta, index) => {
    const runId = `invalid-${index}`
    staged(runId, 'published', meta)
    assert.equal(readScanAuditSource(getDb(), { libraryId, runId }, 'identity')?.format, 'entries')
    assert.ok(readScanAuditSource(getDb(), { libraryId, runId }, 'bytes')!.bytes > 0)
    assert.throws(() => readScanAuditSource(getDb(), { libraryId, runId }, 'body'), /audit/i)
  })
  staged('z-invalid-key', 'published', {}, [{ section: 'files', ordinal: 0, key: '/key',
    entry: { rootId: 1, filePath: '/different', sourceKind: 'local', outcome: 'added' } }])
  assert.throws(() => readScanAuditSource(getDb(), { libraryId, latest: true }, 'body'), /file key/)
  staged('invalid-file', 'published', {}, [{ section: 'files', ordinal: 0, key: '/key', entry: { filePath: '/key' } }])
  assert.throws(() => readScanAuditSource(getDb(), { libraryId, runId: 'invalid-file' }, 'body'), /reconstructed/)
})

it('keeps standalone multi-query body reconstruction on one snapshot during concurrent run deletion', () => {
  const { meta } = staged('snapshot', 'published', {}, [{ section: 'files', ordinal: 0, key: '/file',
    entry: { rootId: 1, filePath: '/file', sourceKind: 'local', outcome: 'added' } }])
  const db = getDb(), writer = new Database(filename), originalPrepare = db.prepare, prepare = db.prepare.bind(db)
  writer.pragma('foreign_keys = ON')
  let deleted = false
  db.prepare = ((sql: string) => {
    const statement = prepare(sql)
    if (sql.startsWith('SELECT r.id,')) {
      const get = statement.get.bind(statement)
      statement.get = ((...args: unknown[]) => {
        const result = get(...args)
        assert.equal(db.inTransaction, true)
        if (!deleted) {
          writer.prepare('DELETE FROM library_scan_runs WHERE id=?').run('snapshot')
          deleted = true
        }
        return result
      }) as typeof statement.get
    }
    return statement
  }) as typeof db.prepare
  try {
    const body = readScanAuditSource(db, { libraryId, runId: 'snapshot' }, 'body')!.body
    assert.deepEqual(JSON.parse(body), { ...meta,
      files: [{ rootId: 1, filePath: '/file', sourceKind: 'local', outcome: 'added' }],
      removedResources: [], promotedResources: [], deletedVideos: [], pendingGroups: [] })
    assert.equal(deleted, true)
    assert.equal(readScanAuditSource(db, { libraryId, runId: 'snapshot' }, 'body'), undefined)
  } finally { db.prepare = originalPrepare; writer.close() }
})

it('rejects duplicate metadata root keys even when JSON.parse would keep a valid final value', () => {
  for (const key of ['libraryId', 'runId', 'finishedAt', 'note']) {
    const runId = `duplicate-${key}`
    const { metaJson } = staged(runId, 'collecting')
    const body = `{"${key}":"discarded",${metaJson.slice(1, -1)}${key === 'note' ? ',"note":"last"' : ''}}`
    const db = getDb()
    db.prepare('UPDATE library_scan_audit_manifests SET meta_json=? WHERE run_id=?').run(body, runId)
    db.prepare("UPDATE library_scan_audit_manifests SET state='sealed',sealed_at='seal' WHERE run_id=?").run(runId)
    db.transaction(() => {
      db.prepare("UPDATE library_scan_runs SET status='completed',finished_at='finish' WHERE id=?").run(runId)
      db.prepare("UPDATE library_scan_audit_manifests SET state='published',published_at='publish' WHERE run_id=?").run(runId)
    })()
    assert.equal(readScanAuditSource(db, { libraryId, runId }, 'identity')?.format, 'entries')
    assert.equal(readScanAuditSource(db, { libraryId, runId }, 'bytes')?.bytes, Buffer.byteLength(body))
    assert.throws(() => readScanAuditSource(db, { libraryId, runId }, 'body'), /duplicate root keys/)
  }
})
