import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { findActressIdByOwnedName } from './actressNameOwnership'
import { closeDatabase, initDatabaseAtPath } from './database'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'
import { ActressIdentityConflictWorkflow } from '../services/actressIdentityConflictWorkflow'

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

function createV4ActressSchema(db: Database.Database): void {
  createV3ActressSchema(db)
  db.exec(`
    ALTER TABLE actresses
    ADD COLUMN scraped_status INTEGER NOT NULL DEFAULT 0
    CHECK(scraped_status IN (0, 1, 2));
    CREATE INDEX idx_actresses_scraped_status ON actresses(scraped_status);
  `)
  db.pragma('user_version = 4')
}

describe('database schema', () => {
  it('migrates uncontested names to ownership and preserves cross-actress collisions for review', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-name-ownership-'))
    const dbPath = path.join(tempDir, 'library.db')
    const fixture = new Database(dbPath)
    try {
      createV4ActressSchema(fixture)
      fixture.exec(`
        INSERT INTO actresses (id, main_name) VALUES
          (1, 'Ａlice Smith'),
          (2, 'Bob'),
          (3, 'Main Without Row');
        INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES
          (1, 'Ａlice Smith', 'main', 1),
          (1, 'Alice Smith', 'alias', 0),
          (1, 'Shared Name', 'alias', 0),
          (1, '爱丽丝', 'zh', 1),
          (1, '山田・太郎-Ａ', 'alias', 0),
          (1, '櫻井', 'alias', 0),
          (1, '樱井', 'alias', 0),
          (1, 'さくら', 'alias', 0),
          (1, 'サクラ', 'alias', 0),
          (1, 'Yu', 'alias', 0),
          (1, 'Yuu', 'alias', 0),
          (2, 'Bob', 'main', 1),
          (2, 'ＳＨＡＲＥＤ　ＮＡＭＥ', 'en', 1),
          (2, '　', 'alias', 0);
      `)
    } finally {
      fixture.close()
    }

    try {
      const db = initDatabaseAtPath(dbPath)

      const ownership = Object.fromEntries(
        (
          db
            .prepare(
              `SELECT normalized_name, actress_id
               FROM actress_name_ownership`
            )
            .all() as Array<{ normalized_name: string; actress_id: number }>
        ).map((row) => [row.normalized_name, row.actress_id])
      )
      assert.deepEqual(ownership, {
        alicesmith: 1,
        bob: 2,
        mainwithoutrow: 3,
        '爱丽丝': 1,
        '山田・太郎-a': 1,
        櫻井: 1,
        樱井: 1,
        さくら: 1,
        サクラ: 1,
        yu: 1,
        yuu: 1
      })
      assert.deepEqual(
        db
          .prepare(
            `SELECT actress_id, name, type, is_primary
             FROM actress_names
             WHERE actress_id = 3`
          )
          .get(),
        { actress_id: 3, name: 'Main Without Row', type: 'main', is_primary: 1 }
      )
      assert.deepEqual(
        db
          .prepare(
            `SELECT normalized_name, actress_id, name, type
             FROM pending_actress_name_claims
             ORDER BY actress_id, type`
          )
          .all(),
        [
          {
            normalized_name: 'sharedname',
            actress_id: 1,
            name: 'Shared Name',
            type: 'alias'
          },
          {
            normalized_name: 'sharedname',
            actress_id: 2,
            name: 'ＳＨＡＲＥＤ　ＮＡＭＥ',
            type: 'en'
          }
        ]
      )
      assert.equal(findActressIdByOwnedName(' alice smith '), 1)
      assert.equal(findActressIdByOwnedName('ＳＨＡＲＥＤＮＡＭＥ'), null)
      assert.throws(() => findActressIdByOwnedName(' \t\n\u3000'), /演员名称不能为空/)

      const pendingOwnershipWorkflow = new ActressIdentityConflictWorkflow()
      const pendingOwnershipGroups = pendingOwnershipWorkflow.listConflictGroups()
      assert.equal(pendingOwnershipWorkflow.countPendingScrapes(), 0)
      assert.equal(pendingOwnershipWorkflow.countPendingReviewItems(), 1)
      assert.deepEqual(
        pendingOwnershipGroups.map((group) => ({
          normalizedName: group.normalizedName,
          candidateCount: group.candidates.length,
          claimants: group.claimants.map((claimant) => claimant.actressId),
          claims: group.pendingNameClaims.map((claim) => ({
            actressId: claim.actressId,
            name: claim.name,
            type: claim.type
          }))
        })),
        [
          {
            normalizedName: 'sharedname',
            candidateCount: 0,
            claimants: [1, 2],
            claims: [
              { actressId: 1, name: 'Shared Name', type: 'alias' },
              { actressId: 2, name: 'ＳＨＡＲＥＤ　ＮＡＭＥ', type: 'en' }
            ]
          }
        ]
      )

      const migratedRows = {
        ownership: db.prepare('SELECT * FROM actress_name_ownership ORDER BY normalized_name').all(),
        pending: db
          .prepare('SELECT * FROM pending_actress_name_claims ORDER BY id')
          .all()
      }
      migrateDatabase(db)
      assert.deepEqual(
        {
          ownership: db
            .prepare('SELECT * FROM actress_name_ownership ORDER BY normalized_name')
            .all(),
          pending: db.prepare('SELECT * FROM pending_actress_name_claims ORDER BY id').all()
        },
        migratedRows
      )
    } finally {
      closeDatabase()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rolls back name ownership data and schema version when migration fails', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-name-rollback-'))
    const dbPath = path.join(tempDir, 'library.db')
    const db = new Database(dbPath)
    try {
      createV4ActressSchema(db)
      db.pragma('foreign_keys = ON')
      db.exec(`
        INSERT INTO actresses (id, main_name) VALUES (1, 'Kept Main');
        INSERT INTO actress_names (actress_id, name, type, is_primary)
        VALUES (999, 'Orphan Name', 'alias', 0);
      `)

      assert.throws(() => migrateDatabase(db), /FOREIGN KEY constraint failed/)

      assert.equal(db.pragma('user_version', { simple: true }), 4)
      assert.equal(
        Boolean(
          db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get('actress_name_ownership')
        ),
        false
      )
      assert.deepEqual(
        db.prepare('SELECT actress_id, name, type FROM actress_names').all(),
        [{ actress_id: 999, name: 'Orphan Name', type: 'alias' }]
      )
    } finally {
      db.close()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

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
      assert.equal(actressCols.some((column) => column.name === 'revision'), true)
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
        'video_resources',
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
        'actress_name_ownership',
        'pending_actress_name_claims',
        'pending_actress_scrapes',
        'pending_actress_scrape_conflicts',
        'pending_actress_scrape_resources',
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
      assert.equal(indexNames(db).includes('idx_video_resources_key'), true)
      assert.equal(indexNames(db).includes('idx_video_tag_tag_id'), true)
      assert.equal(indexNames(db).includes('idx_videos_maker'), true)
      assert.equal(indexNames(db).includes('idx_playlist_video_video_id'), true)
      assert.equal(indexNames(db).includes('idx_actress_names_one_main'), true)
      assert.equal(indexNames(db).includes('idx_actresses_scraped_status'), true)
      assert.equal(indexNames(db).includes('idx_videos_studio'), false)
      assert.equal(indexNames(db).includes('idx_videos_file_path'), false)

      db.prepare("INSERT INTO actresses (main_name) VALUES ('Default status')").run()
      const defaultStatusId = Number(
        (
          db
            .prepare("SELECT id FROM actresses WHERE main_name = 'Default status'")
            .get() as { id: number }
        ).id
      )
      assert.throws(
        () =>
          db
            .prepare(
              'INSERT INTO actress_name_ownership (normalized_name, actress_id) VALUES (?, ?)'
            )
            .run('', defaultStatusId),
        /CHECK constraint failed/
      )
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

      const resourceCols = (
        db.prepare('PRAGMA table_info(video_resources)').all() as { name: string }[]
      ).map((c) => c.name)
      assert.deepEqual(
        [
          'kind',
          'locator',
          'resource_key',
          'size_bytes',
          'duration_seconds',
          'file_mtime_ms',
          'display_name'
        ].filter((column) => !resourceCols.includes(column)),
        []
      )
      assert.equal(
        Boolean(
          db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'video_files'")
            .get()
        ),
        false
      )
    } finally {
      db.close()
    }
  })

  it('migrates v6 video files to local resources without losing data', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE videos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT UNIQUE NOT NULL
        );
        CREATE TABLE video_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          video_id INTEGER NOT NULL,
          file_path TEXT NOT NULL UNIQUE,
          file_size INTEGER,
          file_duration_seconds INTEGER,
          file_mtime_ms INTEGER,
          label TEXT,
          is_primary INTEGER NOT NULL DEFAULT 0,
          add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
        );
        INSERT INTO videos (id, code) VALUES (7, 'ABC-123');
        INSERT INTO video_files (
          id, video_id, file_path, file_size, file_duration_seconds,
          file_mtime_ms, label, is_primary, add_time
        ) VALUES (
          19, 7, '/library/ABC-123.mp4', 123456789, 5400,
          1786300000000, 'Main cut', 1, '2026-08-10T10:00:00.000Z'
        );
      `)
      db.pragma('user_version = 6')

      migrateDatabase(db)
      migrateDatabase(db)

      assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      assert.deepEqual(
        db
          .prepare(
            `SELECT id, video_id, kind, locator, resource_key, size_bytes,
                    duration_seconds, file_mtime_ms, display_name, is_primary, add_time
             FROM video_resources`
          )
          .get(),
        {
          id: 19,
          video_id: 7,
          kind: 'local',
          locator: '/library/ABC-123.mp4',
          resource_key: 'local:/library/ABC-123.mp4',
          size_bytes: 123456789,
          duration_seconds: 5400,
          file_mtime_ms: 1786300000000,
          display_name: 'Main cut',
          is_primary: 1,
          add_time: '2026-08-10T10:00:00.000Z'
        }
      )
      assert.equal(
        Boolean(
          db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'video_files'")
            .get()
        ),
        false
      )
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
      assert.equal(rowCount(db, 'actress_names'), rowCount(db, 'actresses') + 2)
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
