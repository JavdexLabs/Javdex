import { it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  AGENT_RESOURCE_CLEANUP_SCHEMA_SQL,
  CATALOG_PROTOCOL_SCHEMA_SQL,
  SCAN_AUDIT_ENTRIES_SCHEMA_SQL
} from './schema'
import { releasedV15Database } from '../testFixtures/releasedV15Database'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'

function protocolObjects(db: Database.Database) {
  return db
    .prepare(
      `SELECT type, name, tbl_name FROM sqlite_master
       WHERE name GLOB 'catalog_*'
       ORDER BY name`
    )
    .all()
}

function videoVersionColumns(db: Database.Database) {
  return (db.pragma('table_info(videos)') as Array<{ name: string; type: string }>)
    .filter((column) => column.name === 'generation' || column.name === 'revision')
    .map((column) => `${column.name}:${column.type}`)
}

function officialSchema16() {
  const db = releasedV15Database()
  db.exec(AGENT_RESOURCE_CLEANUP_SCHEMA_SQL)
  db.exec('DROP INDEX idx_video_tag_tag_id')
  db.exec('CREATE INDEX idx_video_tag_tag_id ON video_tag(tag_id,origin)')
  db.exec(SCAN_AUDIT_ENTRIES_SCHEMA_SQL)
  db.pragma('user_version = 16')
  db.prepare("INSERT INTO videos(code, title) VALUES ('S16-KEEP', 'keep')").run()
  return db
}

it('upgrades official schema 16 and empty databases to the same protocol objects', () => {
  const from16 = officialSchema16()
  const fresh = new Database(':memory:')
  const from15 = releasedV15Database()
  try {
    fresh.pragma('foreign_keys = ON')
    migrateDatabase(from16)
    migrateDatabase(fresh)
    migrateDatabase(from15)
    assert.equal(CURRENT_SCHEMA_VERSION, 17)
    for (const db of [from16, fresh, from15]) {
      assert.equal(db.pragma('user_version', { simple: true }), 17)
      assert.deepEqual(db.pragma('foreign_key_check'), [])
      assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }])
    }
    assert.deepEqual(protocolObjects(from16), protocolObjects(fresh))
    assert.deepEqual(protocolObjects(from15), protocolObjects(fresh))
    assert.deepEqual(videoVersionColumns(from16), videoVersionColumns(fresh))
    assert.deepEqual(videoVersionColumns(from15), ['generation:INTEGER', 'revision:INTEGER'])
    assert.equal(
      (from16.prepare("SELECT title, generation, revision FROM videos WHERE code = 'S16-KEEP'").get() as {
        title: string
        generation: number
        revision: number
      }).revision,
      1
    )
  } finally {
    from16.close()
    fresh.close()
    from15.close()
  }
})

it('rolls back V17 DDL and version when the protocol tables fail, then upgrades on retry', (t) => {
  const db = officialSchema16()
  try {
    const exec = db.exec
    const fault = t.mock.method(db, 'exec', (sql: string) => {
      const result = exec.call(db, sql)
      if (sql.includes('CREATE TABLE IF NOT EXISTS catalog_identity')) throw new Error('migration interrupted')
      return result
    })
    assert.throws(() => migrateDatabase(db), /migration interrupted/)
    assert.equal(db.pragma('user_version', { simple: true }), 16)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_identity'").get(), undefined)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_operation_receipts'").get(), undefined)
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
    fault.mock.restore()
    migrateDatabase(db)
    assert.equal(db.pragma('user_version', { simple: true }), 17)
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_identity'").get())
  } finally {
    t.mock.restoreAll()
    db.close()
  }
})

it('rejects unpublished experimental V17/V18 snapshots and does not rewrite them', () => {
  for (const version of [17, 18]) {
    const db = officialSchema16()
    try {
      db.exec(CATALOG_PROTOCOL_SCHEMA_SQL)
      if (version === 17) {
        db.exec('DROP TABLE catalog_identity')
      }
      db.pragma(`user_version = ${version}`)
      const snapshot = () => db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()
      const before = snapshot()
      assert.throws(() => migrateDatabase(db), /unreleased|no longer supported/)
      assert.equal(db.pragma('user_version', { simple: true }), version)
      assert.deepEqual(snapshot(), before)
    } finally {
      db.close()
    }
  }
})
