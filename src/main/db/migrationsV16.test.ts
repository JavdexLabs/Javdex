import { it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SCHEMA_SQL, SCAN_AUDIT_ENTRIES_V18_SCHEMA_SQL } from './schema'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'

function releasedDatabase() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL.replace(SCAN_AUDIT_ENTRIES_V18_SCHEMA_SQL, ''))
  db.exec('DROP TABLE agent_resource_cleanup')
  db.exec('DROP INDEX idx_video_tag_tag_id; CREATE INDEX idx_video_tag_tag_id ON video_tag(tag_id)')
  db.pragma('user_version = 15')
  db.prepare(`INSERT INTO agent_runs
    (id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
    VALUES ('old-run','plugin-developer','closed','test','bad config','pi','bad state','old','old')`).run()
  db.prepare("INSERT INTO actresses (main_name) VALUES ('migration fixture')").run()
  return db
}

it('adds the cleanup queue and later indexes when upgrading V15 and preserves old business data and damaged diagnostic state', () => {
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
