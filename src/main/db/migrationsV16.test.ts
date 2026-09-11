import { it } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_RESOURCE_CLEANUP_SCHEMA_SQL } from './schema'
import { releasedV15Database } from '../testFixtures/releasedV15Database'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'

function releasedDatabase() {
  const db = releasedV15Database()
  db.prepare(`INSERT INTO agent_runs
    (id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
    VALUES ('old-run','plugin-developer','closed','test','bad config','pi','bad state','old','old')`).run()
  db.prepare("INSERT INTO actresses (main_name) VALUES ('migration fixture')").run()
  return db
}

it('adds the cleanup queue, tag index and scan audit tables when upgrading V15 and preserves old business data and damaged diagnostic state', () => {
  const db = releasedDatabase()
  try {
    const schemaBefore = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB 'library_scan_audit_*' AND name <> 'idx_video_tag_tag_id' ORDER BY name").all()
    const runsBefore = db.prepare('SELECT * FROM agent_runs').all()
    const actressesBefore = db.prepare('SELECT * FROM actresses').all()
    migrateDatabase(db)
    assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
    const schemaAfter = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB 'library_scan_audit_*' AND name <> 'agent_resource_cleanup' AND name <> 'idx_video_tag_tag_id' ORDER BY name").all()
    assert.deepEqual(schemaAfter, schemaBefore)
    assert.deepEqual(db.prepare('SELECT * FROM agent_runs').all(), runsBefore)
    assert.deepEqual(db.prepare('SELECT * FROM actresses').all(), actressesBefore)
    db.prepare("INSERT INTO agent_resource_cleanup VALUES ('old-run','now')").run()
    assert.throws(() => db.prepare("INSERT INTO agent_resource_cleanup VALUES ('missing','now')").run(), /FOREIGN KEY/)
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }])
    migrateDatabase(db)
    assert.equal((db.prepare('SELECT COUNT(*) AS total FROM agent_resource_cleanup').get() as { total: number }).total, 1)
    db.prepare("DELETE FROM agent_runs WHERE id = 'old-run'").run()
    assert.equal((db.prepare('SELECT COUNT(*) AS total FROM agent_resource_cleanup').get() as { total: number }).total, 0)
  } finally { db.close() }
})

it('rolls back both DDL and version when V16 fails after table creation, then upgrades on retry', (t) => {
  const db = releasedDatabase()
  try {
    const exec = db.exec
    const fault = t.mock.method(db, 'exec', (sql: string) => {
      const result = exec.call(db, sql)
      if (sql.includes('CREATE TABLE IF NOT EXISTS agent_resource_cleanup')) throw new Error('migration interrupted')
      return result
    })
    assert.throws(() => migrateDatabase(db), /migration interrupted/)
    assert.equal(db.pragma('user_version', { simple: true }), 15)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_resource_cleanup'").get(), undefined)
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
    fault.mock.restore()
    migrateDatabase(db)
    assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  } finally {
    t.mock.restoreAll()
    db.close()
  }
})

it('does not silently accept the old unpublished partial V16 or rewrite higher development versions', () => {
  for (const version of [16, 17, 18]) {
    const db = releasedDatabase()
    try {
      db.exec(AGENT_RESOURCE_CLEANUP_SCHEMA_SQL)
      db.pragma(`user_version = ${version}`)
      const snapshot = () => db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()
      const before = snapshot()
      assert.throws(() => migrateDatabase(db), /unreleased|no longer supported/)
      assert.equal(db.pragma('user_version', { simple: true }), version)
      assert.deepEqual(snapshot(), before)
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
    } finally { db.close() }
  }
})
