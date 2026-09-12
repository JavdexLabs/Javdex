import { it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  AGENT_RESOURCE_CLEANUP_SCHEMA_SQL,
  CATALOG_IMAGE_UPLOAD_SCHEMA_SQL,
  CATALOG_PROTOCOL_SCHEMA_SQL,
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

function officialSchema17() {
  const db = officialSchema16()
  db.exec(CATALOG_PROTOCOL_SCHEMA_SQL)
  db.exec('ALTER TABLE videos ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0)')
  db.exec('ALTER TABLE videos ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)')
  db.pragma('user_version = 17')
  return db
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name)
}

it('upgrades official 16/17 and empty databases to the same schema 18 upload tables and version columns', () => {
  const from16 = officialSchema16()
  const from17 = officialSchema17()
  const fresh = new Database(':memory:')
  try {
    fresh.pragma('foreign_keys = ON')
    migrateDatabase(from16)
    migrateDatabase(from17)
    migrateDatabase(fresh)
    assert.equal(CURRENT_SCHEMA_VERSION, 19)
    for (const db of [from16, from17, fresh]) {
      assert.equal(db.pragma('user_version', { simple: true }), 19)
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_image_uploads'").get())
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_image_file_jobs'").get())
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_tasks'").get())
      assert.equal(columnNames(db, 'actresses').includes('generation'), true)
      assert.equal(columnNames(db, 'organizations').includes('generation'), true)
      assert.equal(columnNames(db, 'organizations').includes('revision'), true)
      assert.equal(columnNames(db, 'directors').includes('generation'), true)
      assert.equal(columnNames(db, 'series').includes('revision'), true)
      assert.equal(columnNames(db, 'playlists').includes('generation'), true)
      assert.equal(columnNames(db, 'playlists').includes('revision'), true)
      assert.deepEqual(db.pragma('foreign_key_check'), [])
    }
  } finally {
    from16.close()
    from17.close()
    fresh.close()
  }
})

it('rolls back V18 DDL when upload tables fail, then upgrades on retry', (t) => {
  const db = officialSchema17()
  try {
    const exec = db.exec
    const fault = t.mock.method(db, 'exec', (sql: string) => {
      const result = exec.call(db, sql)
      if (sql.includes('CREATE TABLE IF NOT EXISTS catalog_image_uploads')) {
        throw new Error('v18 interrupted')
      }
      return result
    })
    assert.throws(() => migrateDatabase(db), /v18 interrupted/)
    assert.equal(db.pragma('user_version', { simple: true }), 17)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_image_uploads'").get(), undefined)
    fault.mock.restore()
    migrateDatabase(db)
    assert.equal(db.pragma('user_version', { simple: true }), 19)
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_image_uploads'").get())
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_tasks'").get())
  } finally {
    t.mock.restoreAll()
    db.close()
  }
})

it('upgrades official schema 18 to durable catalog task tables at schema 19', () => {
  const db = new Database(':memory:')
  try {
    db.exec(CATALOG_PROTOCOL_SCHEMA_SQL)
    db.exec(CATALOG_IMAGE_UPLOAD_SCHEMA_SQL)
    db.pragma('user_version = 18')
    migrateDatabase(db)
    assert.equal(db.pragma('user_version', { simple: true }), 19)
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_tasks'").get())
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_maintenance_plans'").get())
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_settings'").get())
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'catalog_root_markers'").get())
  } finally {
    db.close()
  }
})
