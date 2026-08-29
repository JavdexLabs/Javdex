import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'

const V17_SCHEMA_VERSION = 17

describe('V18 global cover presentation migration', () => {
  it('removes the library cover override while preserving every other config value', () => {
    const database = new Database(':memory:')
    try {
      database.pragma('foreign_keys = ON')
      database.exec(`
        CREATE TABLE media_libraries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          icon TEXT NOT NULL DEFAULT 'library',
          color TEXT NOT NULL DEFAULT 'slate',
          position INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          is_default INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE media_library_configs (
          library_id INTEGER PRIMARY KEY,
          auto_scan_enabled INTEGER NOT NULL DEFAULT 0,
          auto_scan_interval_minutes INTEGER NOT NULL DEFAULT 1440,
          min_import_duration_minutes INTEGER NOT NULL DEFAULT 0,
          auto_merge_same_code_resources INTEGER NOT NULL DEFAULT 0,
          remove_resource_less_memberships INTEGER NOT NULL DEFAULT 0,
          default_video_scraper TEXT,
          default_sort_by TEXT NOT NULL DEFAULT 'release_date',
          default_sort_dir TEXT NOT NULL DEFAULT 'desc',
          default_cover_mode TEXT NOT NULL DEFAULT 'cover',
          include_in_home_discovery INTEGER NOT NULL DEFAULT 1,
          revision INTEGER NOT NULL DEFAULT 1,
          legacy_settings_imported_at TEXT,
          FOREIGN KEY (library_id) REFERENCES media_libraries(id) ON DELETE CASCADE
        );
        INSERT INTO media_libraries (id, name, is_default, revision)
          VALUES (1, '默认媒体库', 1, 3), (2, 'NAS', 0, 5);
        INSERT INTO media_library_configs (
          library_id,
          auto_scan_enabled,
          auto_scan_interval_minutes,
          min_import_duration_minutes,
          auto_merge_same_code_resources,
          remove_resource_less_memberships,
          default_video_scraper,
          default_sort_by,
          default_sort_dir,
          default_cover_mode,
          include_in_home_discovery,
          revision,
          legacy_settings_imported_at
        ) VALUES
          (1, 1, 180, 15, 1, 0, 'JavDB', 'rating', 'asc', 'poster', 0, 7,
           '2026-08-29T00:00:00.000Z'),
          (2, 0, 1440, 0, 0, 1, NULL, 'release_date', 'desc', 'cover', 1, 2, NULL);
      `)
      database.pragma(`user_version = ${V17_SCHEMA_VERSION}`)

      migrateDatabase(database)

      assert.equal(CURRENT_SCHEMA_VERSION, 18)
      assert.equal(database.pragma('user_version', { simple: true }), 18)
      const columns = database.prepare('PRAGMA table_info(media_library_configs)').all() as Array<{
        name: string
      }>
      assert.equal(columns.some((column) => column.name === 'default_cover_mode'), false)
      assert.deepEqual(
        database
          .prepare(
            `SELECT library_id, auto_scan_enabled, auto_scan_interval_minutes,
                    min_import_duration_minutes, auto_merge_same_code_resources,
                    remove_resource_less_memberships, default_video_scraper,
                    default_sort_by, default_sort_dir, include_in_home_discovery,
                    revision, legacy_settings_imported_at
               FROM media_library_configs
              ORDER BY library_id`
          )
          .all(),
        [
          {
            library_id: 1,
            auto_scan_enabled: 1,
            auto_scan_interval_minutes: 180,
            min_import_duration_minutes: 15,
            auto_merge_same_code_resources: 1,
            remove_resource_less_memberships: 0,
            default_video_scraper: 'JavDB',
            default_sort_by: 'rating',
            default_sort_dir: 'asc',
            include_in_home_discovery: 0,
            revision: 7,
            legacy_settings_imported_at: '2026-08-29T00:00:00.000Z'
          },
          {
            library_id: 2,
            auto_scan_enabled: 0,
            auto_scan_interval_minutes: 1440,
            min_import_duration_minutes: 0,
            auto_merge_same_code_resources: 0,
            remove_resource_less_memberships: 1,
            default_video_scraper: null,
            default_sort_by: 'release_date',
            default_sort_dir: 'desc',
            include_in_home_discovery: 1,
            revision: 2,
            legacy_settings_imported_at: null
          }
        ]
      )
      assert.deepEqual(database.pragma('foreign_key_check'), [])
      database.prepare('DELETE FROM media_libraries WHERE id = 2').run()
      assert.deepEqual(
        database
          .prepare('SELECT COUNT(*) AS count FROM media_library_configs WHERE library_id = 2')
          .get(),
        { count: 0 }
      )
    } finally {
      database.close()
    }
  })
})
