import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'

function indexNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
    name: string
  }[]).map((r) => r.name)
}

describe('database schema', () => {
  it('creates the current schema and records user_version', () => {
    const db = new Database(':memory:')
    try {
      migrateDatabase(db)
      migrateDatabase(db)

      assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      const actressCols = (
        db.prepare('PRAGMA table_info(actresses)').all() as { name: string }[]
      ).map((c) => c.name)
      assert.equal(actressCols.includes('avatar_source_path'), true)
      assert.equal(actressCols.includes('avatar_crop_json'), true)
      const expectedTables = [
        'videos',
        'video_files',
        'actresses',
        'video_actress',
        'tags',
        'video_tag',
        'facet_entries',
        'video_external_ids',
        'video_external_stats',
        'video_assets',
        'playlists',
        'playlist_video',
        'actress_names',
        'actress_tags',
        'actress_tag',
        'actress_gallery_assets'
      ]
      assert.deepEqual(
        expectedTables.map(
          (name) =>
            db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(name)
        ).map(Boolean),
        expectedTables.map(() => true)
      )
      assert.equal(indexNames(db).includes('idx_videos_release_date'), true)
      assert.equal(indexNames(db).includes('idx_video_files_file_path'), true)
      assert.equal(indexNames(db).includes('idx_video_tag_tag_id'), true)
      assert.equal(indexNames(db).includes('idx_videos_maker'), true)
      assert.equal(indexNames(db).includes('idx_playlist_video_video_id'), true)
      assert.equal(indexNames(db).includes('idx_actress_names_one_main'), true)
      assert.equal(indexNames(db).includes('idx_videos_studio'), false)
      assert.equal(indexNames(db).includes('idx_videos_file_path'), false)

      const fileCols = (db.prepare('PRAGMA table_info(video_files)').all() as { name: string }[]).map(
        (c) => c.name
      )
      assert.equal(fileCols.includes('file_mtime_ms'), true)
    } finally {
      db.close()
    }
  })

  it('rejects databases newer than the supported schema version', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE videos (id INTEGER PRIMARY KEY)')
      db.pragma('user_version = 99')
      assert.throws(() => migrateDatabase(db), /no longer supported/)
    } finally {
      db.close()
    }
  })

  it('upgrades v1 actresses table with avatar source columns', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE actresses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          main_name TEXT UNIQUE NOT NULL,
          avatar_path TEXT
        )
      `)
      db.pragma('user_version = 1')
      migrateDatabase(db)
      assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      const cols = (db.prepare('PRAGMA table_info(actresses)').all() as { name: string }[]).map(
        (c) => c.name
      )
      assert.equal(cols.includes('avatar_source_path'), true)
      assert.equal(cols.includes('avatar_crop_json'), true)
    } finally {
      db.close()
    }
  })

  it('upgrades v2 actress names to one current primary name without removing visible names', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE actresses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          main_name TEXT UNIQUE NOT NULL
        );
        CREATE TABLE actress_names (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actress_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          locale TEXT,
          source TEXT,
          is_primary INTEGER DEFAULT 0,
          UNIQUE (actress_id, name, type)
        );
        INSERT INTO actresses (id, main_name) VALUES
          (1, 'Current Name'),
          (2, 'Second Current');
        INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES
          (1, 'Former (Name)', 'main', 0),
          (1, 'Current Name', 'main', 0),
          (1, '当前中文名', 'zh', 1),
          (1, 'Current English', 'en', 1),
          (1, 'Visible Alias', 'alias', 0),
          (2, 'Second Former', 'main', 0),
          (2, 'Second Former', 'alias', 0);
      `)
      db.pragma('user_version = 2')

      migrateDatabase(db)

      assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      const names = db
        .prepare(
          `SELECT actress_id, name, type, is_primary
           FROM actress_names
           ORDER BY actress_id, type, name`
        )
        .all()
      assert.deepEqual(names, [
        { actress_id: 1, name: 'Visible Alias', type: 'alias', is_primary: 0 },
        { actress_id: 1, name: 'Current English', type: 'en', is_primary: 1 },
        { actress_id: 1, name: 'Current Name', type: 'main', is_primary: 1 },
        { actress_id: 1, name: '当前中文名', type: 'zh', is_primary: 1 },
        { actress_id: 2, name: 'Second Former', type: 'alias', is_primary: 0 },
        { actress_id: 2, name: 'Second Current', type: 'main', is_primary: 1 }
      ])
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (1, 'Another Main', 'main', 1)"
            )
            .run(),
        /UNIQUE constraint failed/
      )
    } finally {
      db.close()
    }
  })

  it('leaves current-version databases unchanged', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE actresses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          main_name TEXT UNIQUE NOT NULL,
          avatar_path TEXT,
          avatar_source_path TEXT,
          avatar_crop_json TEXT
        )
      `)
      db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`)
      migrateDatabase(db)
      assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      const cols = (db.prepare('PRAGMA table_info(actresses)').all() as { name: string }[]).map(
        (c) => c.name
      )
      assert.deepEqual(
        cols.filter((name) => name === 'avatar_source_path' || name === 'avatar_crop_json'),
        ['avatar_source_path', 'avatar_crop_json']
      )
    } finally {
      db.close()
    }
  })
})
