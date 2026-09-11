import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateDatabase } from './migrations'
import { recoverInterruptedLibraryScanRuns } from './libraryScanRepo'
let db: Database.Database
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); migrateDatabase(db) })
afterEach(() => db.close())
function run(id = 'run', json: string | null = null, status = 'running') {
  db.prepare(`INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json)
    VALUES(?,1,1,'manual',?,'start',?)`).run(id, status, json)
}
function start(id = 'run') {
  run(id)
  db.prepare('INSERT INTO library_scan_audit_manifests(run_id,meta_json) VALUES(?,?)').run(id, '{}')
}
function insert(id = 'run', ordinal = 0, key: string | null = '/file', section = 'files', body = '{"outcome":"added"}') {
  db.prepare('INSERT INTO library_scan_audit_entries(run_id,section,ordinal,entry_key,entry_json,entry_bytes) VALUES(?,?,?,?,?,?)')
    .run(id, section, ordinal, key, body, Buffer.byteLength(body))
}
function seal(id = 'run') {
  db.prepare("UPDATE library_scan_audit_manifests SET state='sealed',sealed_at='seal' WHERE run_id=?").run(id)
}
function publish(id = 'run') {
  db.transaction(() => {
    db.prepare("UPDATE library_scan_runs SET status='completed',finished_at='finish' WHERE id=?").run(id)
    db.prepare("UPDATE library_scan_audit_manifests SET state='published',published_at='publish' WHERE run_id=?").run(id)
  })()
}
function snapshot(id = 'run') {
  return {
    manifest: db.prepare('SELECT * FROM library_scan_audit_manifests WHERE run_id=?').get(id),
    entries: db.prepare('SELECT * FROM library_scan_audit_entries WHERE run_id=? ORDER BY section,ordinal').all(id),
    run: db.prepare('SELECT * FROM library_scan_runs WHERE id=?').get(id)
  }
}
it('accepts collecting revisions and ordered section entries with exact byte accounting', () => {
  start(); insert(); insert('run', 1, '/next')
  insert('run', 0, null, 'pendingGroups', '{"name":"中文"}')
  db.prepare("UPDATE library_scan_audit_entries SET entry_json='{}',entry_bytes=2 WHERE run_id='run' AND section='files' AND ordinal=0").run()
  db.prepare("DELETE FROM library_scan_audit_entries WHERE run_id='run' AND section='files' AND ordinal=1").run()
  assert.equal(snapshot().entries.length, 2)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})
it('rejects invalid sections, JSON, identities, byte metadata and duplicate file keys', () => {
  start(); insert()
  assert.throws(() => insert('missing'))
  assert.throws(() => insert('run', -1, '/negative'))
  assert.throws(() => insert('run', 2, '/file'))
  assert.throws(() => insert('run', 3, null))
  assert.throws(() => insert('run', 4, '/key', 'pendingGroups', '{}'))
  assert.throws(() => insert('run', 5, null, 'bad-section', '{}'))
  assert.throws(() => insert('run', 6, '/array', 'files', '[]'))
  assert.throws(() => insert('run', 7, '/bad', 'files', '{bad'))
  assert.throws(() => db.prepare("UPDATE library_scan_audit_entries SET entry_bytes=1 WHERE run_id='run'").run())
  assert.equal(snapshot().entries.length, 1)
})
it('does not mix legacy JSON audits with the new manifest or start from terminal runs', () => {
  run('legacy', '{bad')
  assert.throws(() => db.prepare("INSERT INTO library_scan_audit_manifests(run_id,meta_json) VALUES('legacy','{}')").run())
  run('finished', null, 'completed')
  assert.throws(() => db.prepare("INSERT INTO library_scan_audit_manifests(run_id,meta_json) VALUES('finished','{}')").run())
  start()
  assert.throws(() => db.prepare("UPDATE library_scan_runs SET audit_json='{}' WHERE id='run'").run())
  assert.throws(() => db.prepare("INSERT INTO library_scan_audit_manifests(run_id,meta_json,state,sealed_at) VALUES('legacy','{}','sealed','seal')").run())
})
it('enforces sealed immutability and permits publication only with a terminal completed run', () => {
  start(); insert(); seal()
  const before = snapshot()
  for (const sql of [
    "UPDATE library_scan_audit_manifests SET meta_json='{\"changed\":true}' WHERE run_id='run'",
    "UPDATE library_scan_audit_manifests SET state='collecting',sealed_at=NULL WHERE run_id='run'",
    "UPDATE library_scan_audit_manifests SET state='published',published_at='publish' WHERE run_id='run'",
    "UPDATE library_scan_audit_entries SET entry_json='{}',entry_bytes=2 WHERE run_id='run'",
    "DELETE FROM library_scan_audit_entries WHERE run_id='run'",
    "DELETE FROM library_scan_audit_manifests WHERE run_id='run'"
  ]) assert.throws(() => db.exec(sql), sql)
  assert.throws(() => insert('run', 1, '/later'))
  assert.deepEqual(snapshot(), before)
  publish()
  const published = snapshot()
  assert.equal((published.manifest as { state: string }).state, 'published')
  for (const sql of [
    "UPDATE library_scan_audit_manifests SET state='abandoned',published_at=NULL WHERE run_id='run'",
    "UPDATE library_scan_runs SET finished_at='changed' WHERE id='run'",
    "UPDATE library_scan_runs SET status='running' WHERE id='run'",
    "DELETE FROM library_scan_audit_manifests WHERE run_id='run'",
    "DELETE FROM library_scan_audit_entries WHERE run_id='run'"
  ]) assert.throws(() => db.exec(sql), sql)
  assert.deepEqual(snapshot(), published)
})
it('rolls back run completion and audit publication together on a later failure', () => {
  start(); insert(); seal(); const before = snapshot()
  assert.throws(() => db.transaction(() => { publish(); throw Error('publication fault') })(), /publication fault/)
  assert.deepEqual(snapshot(), before)
  publish()
})
it('retains interrupted audit entries for abandoned cleanup and does not permit late writes', () => {
  for (const id of ['collecting', 'sealed']) { start(id); insert(id); if (id === 'sealed') seal(id) }
  assert.equal(recoverInterruptedLibraryScanRuns(db).recoveredRunCount, 2)
  for (const id of ['collecting', 'sealed']) {
    assert.throws(() => insert(id, 1, '/late'))
    assert.equal((snapshot(id).manifest as { state: string }).state, 'abandoned')
    assert.equal(snapshot(id).entries.length, 1)
    assert.throws(() => db.prepare("UPDATE library_scan_audit_manifests SET state='collecting',sealed_at=NULL WHERE run_id=?").run(id))
    db.prepare('DELETE FROM library_scan_audit_manifests WHERE run_id=?').run(id)
    assert.equal(snapshot(id).entries.length, 0)
  }
})
it('allows deleting whole runs or a library to cascade without permitting partial published deletion', () => {
  start('one'); insert('one'); seal('one'); publish('one')
  start('two'); insert('two'); seal('two'); publish('two')
  db.prepare("DELETE FROM library_scan_runs WHERE id='one'").run()
  assert.equal(snapshot('one').manifest, undefined)
  assert.equal(snapshot('one').entries.length, 0)
  db.prepare('DELETE FROM media_libraries WHERE id=1').run()
  assert.equal(snapshot('two').manifest, undefined)
  assert.equal(snapshot('two').entries.length, 0)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
})

it('keeps entry identity stable while collecting and preserves every terminal publication outcome', () => {
  start(); start('other'); insert()
  const before = snapshot()
  for (const assignment of ["run_id='other'", "section='removedResources',entry_key=NULL", 'ordinal=10', "entry_key='/changed'"]) {
    assert.throws(() => db.exec(`UPDATE library_scan_audit_entries SET ${assignment} WHERE run_id='run'`))
    assert.deepEqual(snapshot(), before)
  }
  for (const status of ['failed', 'cancelled', 'unavailable']) {
    start(status); insert(status); seal(status)
    db.prepare('UPDATE library_scan_runs SET status=? WHERE id=?').run(status, status)
    assert.throws(() => db.prepare("UPDATE library_scan_audit_manifests SET state='published',published_at='end' WHERE run_id=?").run(status))
    db.transaction(() => {
      db.prepare("UPDATE library_scan_runs SET finished_at='end' WHERE id=?").run(status)
      db.prepare("UPDATE library_scan_audit_manifests SET state='published',published_at='end' WHERE run_id=?").run(status)
    })()
    assert.equal((snapshot(status).run as { status: string }).status, status)
  }
})
