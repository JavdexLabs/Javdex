import { it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  AGENT_RESOURCE_CLEANUP_SCHEMA_SQL,
  CATALOG_IMAGE_UPLOAD_SCHEMA_SQL,
  CATALOG_PROTOCOL_SCHEMA_SQL,
  CATALOG_TASK_SCHEMA_SQL,
  SCAN_AUDIT_ENTRIES_SCHEMA_SQL
} from './schema'
import { releasedV15Database } from '../testFixtures/releasedV15Database'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'

function officialSchema16() {
  const db = releasedV15Database()
  db.exec(AGENT_RESOURCE_CLEANUP_SCHEMA_SQL)
  db.exec('DROP INDEX idx_video_tag_tag_id')
  db.exec('CREATE INDEX idx_video_tag_tag_id ON video_tag(tag_id,origin)')
  db.exec(SCAN_AUDIT_ENTRIES_SCHEMA_SQL)
  db.pragma('user_version = 16')
  return db
}

function officialSchema18() {
  const db = officialSchema16()
  db.exec(CATALOG_PROTOCOL_SCHEMA_SQL)
  db.exec('ALTER TABLE videos ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0)')
  db.exec('ALTER TABLE videos ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)')
  db.exec(CATALOG_IMAGE_UPLOAD_SCHEMA_SQL)
  db.pragma('user_version = 18')
  return db
}

it('upgrades official schema 18 and empty databases to the same schema 19 task tables', () => {
  const from18 = officialSchema18()
  const fresh = new Database(':memory:')
  try {
    fresh.pragma('foreign_keys = ON')
    migrateDatabase(from18)
    migrateDatabase(fresh)
    assert.equal(CURRENT_SCHEMA_VERSION, 19)
    for (const db of [from18, fresh]) {
      assert.equal(db.pragma('user_version', { simple: true }), 19)
      for (const name of [
        'catalog_tasks',
        'catalog_maintenance_plans',
        'catalog_settings',
        'catalog_root_markers'
      ]) {
        assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(name), name)
      }
      assert.deepEqual(db.pragma('foreign_key_check'), [])
    }
  } finally {
    from18.close()
    fresh.close()
  }
})

it('rolls back V19 DDL when task tables fail, then upgrades on retry', (t) => {
  const db = officialSchema18()
  try {
    const exec = db.exec
    const fault = t.mock.method(db, 'exec', (sql: string) => {
      const result = exec.call(db, sql)
      if (sql.includes('CREATE TABLE IF NOT EXISTS catalog_tasks')) {
        throw new Error('v19 interrupted')
      }
      return result
    })
    assert.throws(() => migrateDatabase(db), /v19 interrupted/)
    assert.equal(db.pragma('user_version', { simple: true }), 18)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_tasks'").get(), undefined)
    fault.mock.restore()
    migrateDatabase(db)
    assert.equal(db.pragma('user_version', { simple: true }), 19)
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_tasks'").get())
  } finally {
    t.mock.restoreAll()
    db.close()
  }
})

it('leaves official schema 19 databases unchanged', () => {
  const db = new Database(':memory:')
  try {
    db.exec(CATALOG_PROTOCOL_SCHEMA_SQL)
    db.exec(CATALOG_IMAGE_UPLOAD_SCHEMA_SQL)
    db.exec(CATALOG_TASK_SCHEMA_SQL)
    db.pragma('user_version = 19')
    const before = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()
    migrateDatabase(db)
    assert.equal(db.pragma('user_version', { simple: true }), 19)
    assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(), before)
  } finally {
    db.close()
  }
})
