import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'

const V14_SCHEMA_VERSION = 14

function tableExists(database: Database.Database, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
  )
}

function columnNames(database: Database.Database, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
}

/** Released V14 library tables touched by the additive V15 migration. */
function createV14ReleaseFixture(database: Database.Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    -- Minimal unaffected relationship/index required by the combined V16 migration.
    CREATE TABLE video_tag (video_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
      origin TEXT NOT NULL DEFAULT 'manual', PRIMARY KEY(video_id,tag_id));
    CREATE INDEX idx_video_tag_tag_id ON video_tag(tag_id);
    CREATE TABLE media_libraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1
    );
CREATE TABLE IF NOT EXISTS library_scan_runs (
    id TEXT PRIMARY KEY,
    library_id INTEGER NOT NULL,
    config_revision INTEGER NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('manual', 'automatic', 'initial', 'root')),
    status TEXT NOT NULL
        CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'unavailable')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    summary_json TEXT,
    audit_json TEXT,
    error_summary TEXT,
    FOREIGN KEY (library_id) REFERENCES media_libraries(id) ON DELETE CASCADE
);
    CREATE TABLE media_library_configs (
      library_id INTEGER PRIMARY KEY,
      auto_scan_enabled INTEGER NOT NULL DEFAULT 0 CHECK(auto_scan_enabled IN (0, 1)),
      auto_scan_interval_minutes INTEGER NOT NULL DEFAULT 1440,
      min_import_duration_minutes INTEGER NOT NULL DEFAULT 30,
      auto_merge_same_code_resources INTEGER NOT NULL DEFAULT 1,
      remove_resource_less_memberships INTEGER NOT NULL DEFAULT 0,
      default_video_scraper TEXT,
      default_sort_by TEXT NOT NULL DEFAULT 'release_date',
      default_sort_dir TEXT NOT NULL DEFAULT 'desc',
      include_in_home_discovery INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 1,
      legacy_settings_imported_at TEXT,
      FOREIGN KEY (library_id) REFERENCES media_libraries(id) ON DELETE CASCADE
    );
    CREATE TABLE media_library_roots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      normalized_path TEXT NOT NULL,
      real_path TEXT,
      normalized_real_path TEXT,
      device_id TEXT,
      inode TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (library_id) REFERENCES media_libraries(id) ON DELETE CASCADE,
      UNIQUE (id, library_id)
    );
    INSERT INTO media_libraries (id, name) VALUES (1, 'Existing');
    INSERT INTO media_library_configs (library_id, auto_scan_enabled) VALUES (1, 0);
    INSERT INTO media_library_roots (
      id, library_id, path, normalized_path, real_path, normalized_real_path, device_id, inode
    ) VALUES (2, 1, '/library', '/library', '/library', '/library', '1', '2');
  `)
  database.pragma(`user_version = ${V14_SCHEMA_VERSION}`)
}

describe('V15 local NFO import migration', () => {
  it('creates fresh V15 databases with automatic import enabled and identity constraints', () => {
    const database = new Database(':memory:')
    try {
      database.pragma('foreign_keys = ON')
      migrateDatabase(database)
      assert.equal(CURRENT_SCHEMA_VERSION, 16)
      assert.equal(database.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      assert.equal(columnNames(database, 'media_library_configs').has('auto_import_local_nfo'), true)
      assert.equal(tableExists(database, 'pending_resource_identities'), true)
      assert.deepEqual(
        database
          .prepare('SELECT auto_import_local_nfo FROM media_library_configs WHERE library_id = 1')
          .get(),
        { auto_import_local_nfo: 1 }
      )
      assert.throws(
        () =>
          database
            .prepare('UPDATE media_library_configs SET auto_import_local_nfo = 2 WHERE library_id = 1')
            .run(),
        /CHECK constraint failed/u
      )
    } finally {
      database.close()
    }
  })

  it('upgrades V14 rows, preserves the default, and enforces minimal pending identity snapshots', () => {
    const database = new Database(':memory:')
    try {
      createV14ReleaseFixture(database)
      migrateDatabase(database)
      assert.equal(database.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      assert.deepEqual(
        database
          .prepare('SELECT auto_import_local_nfo, revision FROM media_library_configs WHERE library_id = 1')
          .get(),
        { auto_import_local_nfo: 1, revision: 1 }
      )
      const columns = columnNames(database, 'pending_resource_identities')
      for (const forbidden of ['nfo_path', 'nfo_content', 'nfo_hash', 'nfo_mtime', 'processed']) {
        assert.equal(columns.has(forbidden), false)
      }

      const insert = database.prepare(`
        INSERT INTO pending_resource_identities (
          library_id, root_id, file_path, normalized_path, source_kind,
          target_kind, target_locator, target_key, filename_code, nfo_code,
          size_bytes, file_mtime_ms
        ) VALUES (1, 2, '/library/ABC-001.strm', '/library/abc-001.strm', 'strm',
          'direct', 'https://example.test/video.mp4', 'http:https://example.test/video.mp4',
          'ABC-001', 'XYZ-002', 48, 1234)
      `)
      insert.run()
      assert.throws(() => insert.run(), /UNIQUE constraint failed/u)
      assert.throws(
        () =>
          database
            .prepare(`
              INSERT INTO pending_resource_identities (
                library_id, root_id, file_path, normalized_path, source_kind,
                filename_code, nfo_code, size_bytes, file_mtime_ms
              ) VALUES (1, 999, '/library/other.mp4', '/library/other.mp4', 'local',
                'ABC-001', 'XYZ-002', 1, 2)
            `)
            .run(),
        /FOREIGN KEY constraint failed/u
      )

      migrateDatabase(database)
      assert.equal(
        (database.prepare('SELECT COUNT(*) AS count FROM pending_resource_identities').get() as {
          count: number
        }).count,
        1
      )
    } finally {
      database.close()
    }
  })

  it('rolls the migration back and leaves user_version at V14 on schema conflict', () => {
    const database = new Database(':memory:')
    try {
      createV14ReleaseFixture(database)
      database.exec('ALTER TABLE media_library_configs ADD COLUMN auto_import_local_nfo TEXT')
      assert.throws(() => migrateDatabase(database), /duplicate column name/u)
      assert.equal(database.pragma('user_version', { simple: true }), V14_SCHEMA_VERSION)
      assert.equal(tableExists(database, 'pending_resource_identities'), false)
    } finally {
      database.close()
    }
  })
})
