import { it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SCHEMA_SQL, SCAN_AUDIT_ENTRIES_V18_SCHEMA_SQL } from './schema'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'

function v16() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL.replace(SCAN_AUDIT_ENTRIES_V18_SCHEMA_SQL, ''))
  db.exec('DROP INDEX idx_video_tag_tag_id; CREATE INDEX idx_video_tag_tag_id ON video_tag(tag_id)')
  db.pragma('user_version = 16')
  db.exec(`INSERT INTO videos(id,code) VALUES (1,'migration-1'),(2,'migration-2');
    INSERT INTO tags(id,name) VALUES (1,'manual'),(2,'scraped');
    INSERT INTO video_tag(video_id,tag_id,origin,source,created_at)
      VALUES (1,1,'manual',NULL,'old'),(1,2,'scraped','source','old'),(2,1,'scraped','source','old');`)
  return db
}
function snapshot(db: Database.Database) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB 'library_scan_audit_*' ORDER BY name").all() as { name: string }[]
  return tables.map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() }))
}
function columns(db: Database.Database) {
  return (db.pragma('index_info(idx_video_tag_tag_id)') as { name: string }[]).map(row => row.name)
}

it('upgrades V16 without changing any business rows or other schema and matches the current fresh tag index', () => {
  const db = v16()
  const fresh = new Database(':memory:')
  try {
    const before = snapshot(db)
    const schema = () => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB 'library_scan_audit_*' AND name <> 'idx_video_tag_tag_id' ORDER BY name").all()
    const oldSchema = schema()
    migrateDatabase(db)
    assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
    assert.deepEqual(columns(db), ['tag_id', 'origin'])
    assert.deepEqual(snapshot(db), before)
    assert.deepEqual(schema(), oldSchema)
    migrateDatabase(fresh)
    assert.deepEqual(columns(db), columns(fresh))
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_video_tag_tag_id'").get(), fresh.prepare("SELECT sql FROM sqlite_master WHERE name='idx_video_tag_tag_id'").get())
    migrateDatabase(db)
    assert.deepEqual(snapshot(db), before)
    db.exec("UPDATE video_tag SET origin='manual',source=NULL WHERE video_id=1 AND tag_id=2")
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM video_tag INDEXED BY idx_video_tag_tag_id WHERE tag_id=2 AND origin='manual'").get() as { n: number }).n, 1)
    db.exec('DELETE FROM tags WHERE id=1')
    db.exec('DELETE FROM videos WHERE id=1')
    assert.deepEqual(db.prepare('SELECT * FROM video_tag').all(), [])
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }])
  } finally { db.close(); fresh.close() }
})

for (const phase of ['drop', 'create'] as const) {
  it(`rolls back index DDL and version after ${phase} failure, then retries`, (t) => {
    const db = v16()
    try {
      const before = snapshot(db)
      const exec = db.exec
      const fault = t.mock.method(db, 'exec', (sql: string) => {
        const result = exec.call(db, sql)
        if (sql.includes(phase === 'drop' ? 'DROP INDEX idx_video_tag_tag_id' : 'CREATE INDEX idx_video_tag_tag_id')) throw new Error('index migration interrupted')
        return result
      })
      assert.throws(() => migrateDatabase(db), /index migration interrupted/)
      assert.equal(db.pragma('user_version', { simple: true }), 16)
      assert.deepEqual(columns(db), ['tag_id'])
      assert.deepEqual(snapshot(db), before)
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
      fault.mock.restore()
      migrateDatabase(db)
      assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      assert.deepEqual(columns(db), ['tag_id', 'origin'])
      assert.deepEqual(snapshot(db), before)
    } finally { t.mock.restoreAll(); db.close() }
  })
}
