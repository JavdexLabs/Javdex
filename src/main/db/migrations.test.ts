import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'

function indexNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
    name: string
  }[]).map((r) => r.name)
}

function rowCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

function createV3ActressSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE actresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      main_name TEXT UNIQUE NOT NULL,
      avatar_path TEXT,
      avatar_source_path TEXT,
      avatar_crop_json TEXT,
      poster_path TEXT,
      birth_date TEXT,
      debut_date TEXT,
      height_cm INTEGER,
      bust_cm INTEGER,
      waist_cm INTEGER,
      hip_cm INTEGER,
      cup_size TEXT,
      blood_type TEXT,
      zodiac TEXT,
      nationality TEXT,
      profile_summary TEXT,
      last_scraped_at TEXT,
      updated_at TEXT,
      gender TEXT CHECK(gender IN ('female', 'male'))
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
    CREATE TABLE actress_gallery_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actress_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'gallery',
      position INTEGER DEFAULT 0,
      remote_url TEXT,
      local_path TEXT,
      width INTEGER,
      height INTEGER,
      created_at TEXT
    );
    CREATE TABLE video_actress (
      video_id INTEGER NOT NULL,
      actress_id INTEGER NOT NULL,
      PRIMARY KEY (video_id, actress_id)
    );
    CREATE TABLE actress_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
    CREATE TABLE actress_tag (
      actress_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (actress_id, tag_id)
    );
  `)
  db.pragma('user_version = 3')
}

describe('database schema', () => {
  it('creates the current schema and records user_version', () => {
    const db = new Database(':memory:')
    try {
      migrateDatabase(db)
      migrateDatabase(db)

      assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      const actressCols = db.prepare('PRAGMA table_info(actresses)').all() as Array<{
        name: string
        notnull: number
        dflt_value: string | null
      }>
      assert.equal(actressCols.some((column) => column.name === 'avatar_source_path'), true)
      assert.equal(actressCols.some((column) => column.name === 'avatar_crop_json'), true)
      const scrapedStatusColumn = actressCols.find((column) => column.name === 'scraped_status')
      assert.deepEqual(
        scrapedStatusColumn
          ? {
              name: scrapedStatusColumn.name,
              notnull: scrapedStatusColumn.notnull,
              dflt_value: scrapedStatusColumn.dflt_value
            }
          : undefined,
        { name: 'scraped_status', notnull: 1, dflt_value: '0' }
      )
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
      assert.equal(indexNames(db).includes('idx_actresses_scraped_status'), true)
      assert.equal(indexNames(db).includes('idx_videos_studio'), false)
      assert.equal(indexNames(db).includes('idx_videos_file_path'), false)

      db.prepare("INSERT INTO actresses (main_name) VALUES ('Default status')").run()
      assert.equal(
        (
          db
            .prepare("SELECT scraped_status FROM actresses WHERE main_name = 'Default status'")
            .get() as { scraped_status: number }
        ).scraped_status,
        0
      )
      assert.throws(
        () =>
          db
            .prepare("INSERT INTO actresses (main_name, scraped_status) VALUES ('Invalid status', 3)")
            .run(),
        /CHECK constraint failed/
      )

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

  it('classifies v3 actresses only when a success time has actual profile evidence', () => {
    const db = new Database(':memory:')
    try {
      createV3ActressSchema(db)
      const successAt = '2025-02-03T04:05:06.000Z'
      const insert = db.prepare(
        `INSERT INTO actresses (
           main_name, avatar_path, avatar_source_path, avatar_crop_json, poster_path,
           birth_date, debut_date, height_cm, bust_cm, waist_cm, hip_cm, cup_size,
           blood_type, zodiac, nationality, profile_summary, last_scraped_at, updated_at, gender
         ) VALUES (
           @main_name, @avatar_path, @avatar_source_path, @avatar_crop_json, @poster_path,
           @birth_date, @debut_date, @height_cm, @bust_cm, @waist_cm, @hip_cm, @cup_size,
           @blood_type, @zodiac, @nationality, @profile_summary, @last_scraped_at,
           @updated_at, @gender
         )`
      )
      const emptyRow = {
        avatar_path: null,
        avatar_source_path: null,
        avatar_crop_json: null,
        poster_path: null,
        birth_date: null,
        debut_date: null,
        height_cm: null,
        bust_cm: null,
        waist_cm: null,
        hip_cm: null,
        cup_size: null,
        blood_type: null,
        zodiac: null,
        nationality: null,
        profile_summary: null,
        last_scraped_at: successAt,
        updated_at: null,
        gender: null
      }
      const insertActress = (mainName: string, values: Record<string, unknown> = {}): number =>
        Number(
          insert.run({ ...emptyRow, main_name: mainName, ...values }).lastInsertRowid
        )

      insertActress('No success time', { last_scraped_at: null, avatar_path: 'avatars/kept.jpg' })
      insertActress('Blank success time', { last_scraped_at: '   ', poster_path: 'posters/kept.jpg' })
      const noEvidenceId = insertActress('No evidence', {
        avatar_crop_json: '{"x":0.5}',
        updated_at: successAt,
        gender: 'female'
      })
      db.prepare(
        "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'main', 1)"
      ).run(noEvidenceId, 'No evidence')
      db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (1, ?)').run(noEvidenceId)
      db.prepare("INSERT INTO actress_tags (id, name) VALUES (1, 'Manual tag')").run()
      db.prepare('INSERT INTO actress_tag (actress_id, tag_id) VALUES (?, 1)').run(noEvidenceId)
      const emptyGalleryId = insertActress('Empty gallery placeholder')
      db.prepare(
        `INSERT INTO actress_gallery_assets
           (actress_id, type, position, remote_url, local_path)
         VALUES (?, 'gallery', 0, NULL, '   ')`
      ).run(emptyGalleryId)

      const directEvidence: Array<[string, string, unknown]> = [
        ['Avatar evidence', 'avatar_path', 'avatars/avatar.jpg'],
        ['Avatar source evidence', 'avatar_source_path', 'actress_avatar_sources/source.jpg'],
        ['Poster evidence', 'poster_path', 'posters/poster.jpg'],
        ['Birth date evidence', 'birth_date', '1990-01-02'],
        ['Debut date evidence', 'debut_date', '2010-03-04'],
        ['Height evidence', 'height_cm', 160],
        ['Bust evidence', 'bust_cm', 90],
        ['Waist evidence', 'waist_cm', 60],
        ['Hip evidence', 'hip_cm', 88],
        ['Cup evidence', 'cup_size', 'D'],
        ['Blood type evidence', 'blood_type', 'A'],
        ['Zodiac evidence', 'zodiac', 'Aries'],
        ['Nationality evidence', 'nationality', 'Japan'],
        ['Summary evidence', 'profile_summary', 'Profile']
      ]
      for (const [mainName, column, value] of directEvidence) {
        insertActress(mainName, { [column]: value })
      }

      const galleryId = insertActress('Gallery evidence')
      db.prepare(
        `INSERT INTO actress_gallery_assets
           (actress_id, type, position, remote_url)
         VALUES (?, 'gallery', 0, ?)`
      ).run(galleryId, 'https://example.test/gallery.jpg')
      const typedNameId = insertActress('Typed name evidence')
      db.prepare(
        "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'zh', 1)"
      ).run(typedNameId, '中文名')
      const aliasId = insertActress('Alias evidence')
      db.prepare(
        "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'alias', 0)"
      ).run(aliasId, 'Visible Alias')

      migrateDatabase(db)

      const rows = db
        .prepare(
          `SELECT main_name, scraped_status, last_scraped_at
           FROM actresses
           ORDER BY id`
        )
        .all() as Array<{
        main_name: string
        scraped_status: number
        last_scraped_at: string | null
      }>
      assert.deepEqual(rows.slice(0, 4), [
        { main_name: 'No success time', scraped_status: 0, last_scraped_at: null },
        { main_name: 'Blank success time', scraped_status: 0, last_scraped_at: null },
        { main_name: 'No evidence', scraped_status: 0, last_scraped_at: null },
        { main_name: 'Empty gallery placeholder', scraped_status: 0, last_scraped_at: null }
      ])
      assert.equal(rows.slice(4).every((row) => row.scraped_status === 1), true)
      assert.equal(rows.slice(4).every((row) => row.last_scraped_at === successAt), true)
      assert.equal(rows.some((row) => row.scraped_status === 2), false)
      assert.equal(rowCount(db, 'actresses'), rows.length)
      assert.equal(rowCount(db, 'actress_gallery_assets'), 2)
      assert.equal(rowCount(db, 'actress_names'), 3)
      assert.equal(rowCount(db, 'actress_tag'), 1)
      assert.equal(rowCount(db, 'video_actress'), 1)
    } finally {
      db.close()
    }
  })

  it('keeps the migrated classification unchanged when migration is run again', () => {
    const db = new Database(':memory:')
    try {
      createV3ActressSchema(db)
      db.prepare(
        `INSERT INTO actresses (main_name, avatar_path, last_scraped_at)
         VALUES (?, ?, ?)`
      ).run('Repeatable success', 'avatars/repeatable.jpg', '2025-03-04T05:06:07.000Z')
      db.prepare(
        `INSERT INTO actresses (main_name, last_scraped_at)
         VALUES (?, ?)`
      ).run('Repeatable cleanup', '2025-03-04T05:06:07.000Z')

      migrateDatabase(db)
      const first = db
        .prepare(
          `SELECT main_name, scraped_status, last_scraped_at
           FROM actresses
           ORDER BY id`
        )
        .all()

      migrateDatabase(db)

      assert.deepEqual(
        db
          .prepare(
            `SELECT main_name, scraped_status, last_scraped_at
             FROM actresses
             ORDER BY id`
          )
          .all(),
        first
      )
      assert.equal(
        indexNames(db).filter((name) => name === 'idx_actresses_scraped_status').length,
        1
      )
    } finally {
      db.close()
    }
  })

  it('rolls back the whole actress status migration when classification fails', () => {
    const db = new Database(':memory:')
    try {
      createV3ActressSchema(db)
      db.prepare(
        `INSERT INTO actresses (main_name, avatar_path, last_scraped_at)
         VALUES (?, ?, ?)`
      ).run('Rollback evidence', 'avatars/rollback.jpg', '2025-04-05T06:07:08.000Z')
      db.exec(`
        CREATE TRIGGER reject_actress_classification
        BEFORE UPDATE ON actresses
        BEGIN
          SELECT RAISE(ABORT, 'classification rejected');
        END;
      `)

      assert.throws(() => migrateDatabase(db), /classification rejected/)

      assert.equal(db.pragma('user_version', { simple: true }), 3)
      assert.equal(
        (db.prepare('PRAGMA table_info(actresses)').all() as { name: string }[]).some(
          (column) => column.name === 'scraped_status'
        ),
        false
      )
      assert.equal(indexNames(db).includes('idx_actresses_scraped_status'), false)
      assert.deepEqual(
        db
          .prepare(
            `SELECT main_name, avatar_path, last_scraped_at
             FROM actresses`
          )
          .get(),
        {
          main_name: 'Rollback evidence',
          avatar_path: 'avatars/rollback.jpg',
          last_scraped_at: '2025-04-05T06:07:08.000Z'
        }
      )
    } finally {
      db.close()
    }
  })
})
