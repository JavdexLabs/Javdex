import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'

const V16_SCHEMA_VERSION = 16

describe('V17 pending scan path identity migration', () => {
  it('preserves V16 rows and changes normalized path uniqueness from global to per-library', () => {
    const database = new Database(':memory:')
    try {
      database.pragma('foreign_keys = ON')
      migrateDatabase(database)
      database.exec(`
        DROP INDEX idx_pending_scan_resources_group;
        DROP INDEX idx_pending_scan_resources_root;
        DROP TABLE pending_scan_resources;
        CREATE TABLE pending_scan_resources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          library_id INTEGER NOT NULL,
          group_id INTEGER NOT NULL,
          root_id INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          normalized_path TEXT NOT NULL UNIQUE,
          source_kind TEXT NOT NULL DEFAULT 'local' CHECK(source_kind IN ('local', 'strm')),
          target_kind TEXT CHECK(target_kind IN ('direct', 'web', 'magnet', 'ed2k')),
          target_locator TEXT,
          target_key TEXT,
          size_bytes INTEGER,
          duration_seconds INTEGER,
          file_mtime_ms INTEGER,
          display_name TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (group_id, library_id)
            REFERENCES pending_scan_groups(id, library_id) ON DELETE CASCADE,
          FOREIGN KEY (root_id, library_id)
            REFERENCES media_library_roots(id, library_id) ON DELETE RESTRICT
        );
        CREATE INDEX idx_pending_scan_resources_group
          ON pending_scan_resources(library_id, group_id);
        CREATE INDEX idx_pending_scan_resources_root
          ON pending_scan_resources(library_id, root_id);

        INSERT INTO media_libraries (id, name, status) VALUES (2, '接管库', 'active');
        INSERT INTO media_library_roots (
          id, library_id, path, normalized_path, state
        ) VALUES
          (101, 1, '/shared', '/shared', 'disabled'),
          (102, 2, '/shared', '/shared', 'active');
        INSERT INTO pending_scan_groups (id, library_id, normalized_code)
          VALUES (201, 1, 'SAME-001'), (202, 2, 'SAME-001');
        INSERT INTO pending_scan_resources (
          id, library_id, group_id, root_id, file_path, normalized_path
        ) VALUES (301, 1, 201, 101, '/shared/SAME-001.mp4', '/shared/SAME-001.mp4');
      `)
      database.pragma(`user_version = ${V16_SCHEMA_VERSION}`)

      migrateDatabase(database)

      assert.equal(CURRENT_SCHEMA_VERSION, 18)
      assert.equal(database.pragma('user_version', { simple: true }), 18)
      assert.deepEqual(
        database
          .prepare(
            `SELECT id, library_id, normalized_path
               FROM pending_scan_resources
              ORDER BY id`
          )
          .all(),
        [{ id: 301, library_id: 1, normalized_path: '/shared/SAME-001.mp4' }]
      )
      database
        .prepare(
          `INSERT INTO pending_scan_resources (
             library_id, group_id, root_id, file_path, normalized_path
           ) VALUES (2, 202, 102, ?, ?)`
        )
        .run('/shared/SAME-001.mp4', '/shared/SAME-001.mp4')
      assert.throws(
        () =>
          database
            .prepare(
              `INSERT INTO pending_scan_resources (
                 library_id, group_id, root_id, file_path, normalized_path
               ) VALUES (2, 202, 102, ?, ?)`
            )
            .run('/shared/alias.mp4', '/shared/SAME-001.mp4'),
        /UNIQUE constraint failed: pending_scan_resources\.library_id, pending_scan_resources\.normalized_path/
      )
      assert.deepEqual(database.pragma('foreign_key_check'), [])
    } finally {
      database.close()
    }
  })
})
