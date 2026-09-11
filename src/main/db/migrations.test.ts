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
import { normalizeLocalPathIdentity } from '@shared/localPathIdentity'

/** Older fixtures intentionally model only the tables relevant to their test.
 * Supply the unaffected tag index needed by the combined V16 migration. */
function ensureTagFixture(db: Database.Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='video_tag'").get()) {
    db.exec(`CREATE TABLE video_tag (video_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
      origin TEXT NOT NULL DEFAULT 'manual', PRIMARY KEY(video_id,tag_id));
      CREATE INDEX idx_video_tag_tag_id ON video_tag(tag_id);`)
  }
}

function migrateFixture(db: Database.Database): void {
  if (Number(db.pragma('user_version', { simple: true })) > 0) ensureTagFixture(db)
  migrateDatabase(db)
}

function indexNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
    name: string
  }[]).map((r) => r.name)
}

function rowCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

function columnNamesForTest(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
}

function tableExistsForTest(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  )
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

function createV7ClassificationSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      maker TEXT,
      publisher TEXT,
      series TEXT,
      director TEXT
    );
    CREATE TABLE facet_entries (
      type TEXT NOT NULL CHECK(type IN ('maker', 'publisher', 'series', 'director')),
      value TEXT NOT NULL,
      PRIMARY KEY (type, value)
    );
  `)
  db.pragma('user_version = 7')
}

function createV10VideoIdentitySchema(db: Database.Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      main_name TEXT NOT NULL
    );
    CREATE TABLE directors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      main_name TEXT NOT NULL
    );
    CREATE TABLE series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      main_name TEXT NOT NULL
    );
    CREATE TABLE videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      title TEXT,
      summary TEXT,
      cover_path TEXT,
      poster_path TEXT,
      original_title TEXT,
      rating INTEGER DEFAULT 0,
      release_date TEXT,
      maker_organization_id INTEGER,
      publisher_organization_id INTEGER,
      series_id INTEGER,
      director_id INTEGER,
      duration_seconds INTEGER,
      scraped_status INTEGER DEFAULT 0,
      last_scraped_at TEXT,
      updated_at TEXT,
      add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (publisher_organization_id) REFERENCES organizations(id) ON DELETE SET NULL
    );
    CREATE TABLE video_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      locator TEXT NOT NULL,
      resource_key TEXT NOT NULL UNIQUE,
      size_bytes INTEGER,
      duration_seconds INTEGER,
      file_mtime_ms INTEGER,
      display_name TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );
    CREATE TABLE video_external_ids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      external_id TEXT,
      external_code TEXT,
      url TEXT,
      title TEXT,
      fetched_at TEXT,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
      UNIQUE (video_id, source)
    );
    CREATE UNIQUE INDEX idx_video_external_source_id
      ON video_external_ids(source, external_id)
      WHERE external_id IS NOT NULL;
  `)
  db.pragma('user_version = 10')
}

function createV11StrmMigrationSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL
    );
    CREATE TABLE video_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('local', 'direct', 'web', 'magnet', 'ed2k')),
      locator TEXT NOT NULL,
      resource_key TEXT NOT NULL UNIQUE,
      size_bytes INTEGER,
      duration_seconds INTEGER,
      file_mtime_ms INTEGER,
      display_name TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );
    CREATE TABLE pending_scan_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE pending_scan_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      normalized_path TEXT NOT NULL UNIQUE,
      scan_root TEXT NOT NULL,
      size_bytes INTEGER,
      duration_seconds INTEGER,
      file_mtime_ms INTEGER,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES pending_scan_groups(id) ON DELETE CASCADE
    );
  `)
  db.pragma('user_version = 11')
}

describe('database schema', () => {
  it('adds STRM source identity without changing existing resource identity or link deduplication', () => {
    const db = new Database(':memory:')
    try {
      createV11StrmMigrationSchema(db)
      db.prepare("INSERT INTO videos (id, code) VALUES (41, 'ABC-001')").run()
      db.prepare(
        `INSERT INTO video_resources (
           id, video_id, kind, locator, resource_key, display_name, is_primary
         ) VALUES
           (51, 41, 'local', '/library/ABC-001.mp4', 'local:/library/ABC-001.mp4', 'Local', 1),
           (52, 41, 'direct', 'https://example.test/video.mp4',
            'http:https://example.test/video.mp4', 'Manual', 0)`
      ).run()
      db.prepare(
        "INSERT INTO pending_scan_groups (id, normalized_code) VALUES (61, 'WAIT-001')"
      ).run()
      db.prepare(
        `INSERT INTO pending_scan_resources (
           id, group_id, file_path, normalized_path, scan_root, display_name
         ) VALUES (71, 61, '/library/WAIT-001.mp4', '/library/WAIT-001.mp4',
                   '/library', 'WAIT-001.mp4')`
      ).run()

      migrateFixture(db)

      assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      assert.equal(columnNamesForTest(db, 'video_resources').has('strm_source_path'), true)
      assert.deepEqual(
        db.prepare(
          `SELECT id, source_kind, target_kind, target_locator, target_key
           FROM pending_scan_resources WHERE id = 71`
        ).get(),
        {
          id: 71,
          source_kind: 'local',
          target_kind: null,
          target_locator: null,
          target_key: null
        }
      )
      assert.deepEqual(
        db.prepare(
          `SELECT id, resource_key, strm_source_path, is_primary
           FROM video_resources ORDER BY id`
        ).all(),
        [
          {
            id: 51,
            resource_key: 'local:/library/ABC-001.mp4',
            strm_source_path: null,
            is_primary: 1
          },
          {
            id: 52,
            resource_key: 'http:https://example.test/video.mp4',
            strm_source_path: null,
            is_primary: 0
          }
        ]
      )

      for (const [id, sourcePath] of [
        [53, '/library/one/ABC-001.strm'],
        [54, '/library/two/ABC-001.strm']
      ] as const) {
        db.prepare(
          `INSERT INTO video_resources (
             id, library_id, video_id, kind, locator, resource_key, source_identity,
             strm_source_path, display_name
           ) VALUES (?, 1, 41, 'direct', 'https://example.test/video.mp4', ?, ?, ?, ?)`
        ).run(
          id,
          `strm:${normalizeLocalPathIdentity(sourcePath)}`,
          `strm:${normalizeLocalPathIdentity(sourcePath)}`,
          sourcePath,
          path.basename(sourcePath)
        )
      }
      assert.equal(rowCount(db, 'video_resources'), 4)
      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO video_resources (
               library_id, video_id, kind, locator, resource_key, source_identity, strm_source_path
             ) VALUES (1, 41, 'web', 'https://example.test/other', ?, ?, ?)`
          ).run(
            `strm:${normalizeLocalPathIdentity('/library/one/ABC-001.strm')}`,
            `strm:${normalizeLocalPathIdentity('/library/one/ABC-001.strm')}`,
            '/library/one/ABC-001.strm'
          ),
        /UNIQUE constraint failed/
      )
      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO video_resources (library_id, video_id, kind, locator, resource_key)
             VALUES (1, 41, 'direct', 'https://example.test/video.mp4',
                     'http:https://example.test/video.mp4')`
          ).run(),
        /UNIQUE constraint failed/
      )
    } finally {
      db.close()
    }
  })

  it('allows duplicate codes while enforcing complete video business identity', () => {
    const db = new Database(':memory:')
    try {
      migrateFixture(db)
      db.prepare("INSERT INTO organizations (id, main_name) VALUES (1, 'Publisher')").run()

      db.prepare("INSERT INTO videos (code) VALUES ('DUP-001')").run()
      db.prepare("INSERT INTO videos (code) VALUES ('DUP-001')").run()
      const codeColumn = db
        .prepare('PRAGMA table_info(videos)')
        .all()
        .find((column) => (column as { name: string }).name === 'code') as {
          notnull: number
          dflt_value: string | null
        }
      assert.equal(codeColumn.notnull, 1)
      assert.equal(codeColumn.dflt_value, "''")
      const identityPendingId = Number(
        db.prepare('INSERT INTO videos DEFAULT VALUES').run().lastInsertRowid
      )
      assert.deepEqual(
        db.prepare('SELECT code FROM videos WHERE id = ?').get(identityPendingId),
        { code: '' }
      )
      db.prepare(
        "INSERT INTO videos (code, publisher_organization_id, release_date) VALUES ('DUP-001', 1, '2025-01-02')"
      ).run()

      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO videos (code, publisher_organization_id, release_date) VALUES ('DUP-001', 1, '2025-01-02')"
            )
            .run(),
        /UNIQUE constraint failed/
      )
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO videos (code, publisher_organization_id, release_date) VALUES ('  dup-001  ', 1, '2025-01-02')"
            )
            .run(),
        /UNIQUE constraint failed/
      )
      assert.equal(tableExistsForTest(db, 'video_sources'), true)
      assert.equal(tableExistsForTest(db, 'video_external_ids'), false)
      assert.equal(columnNamesForTest(db, 'video_sources').has('external_id'), false)
      for (const table of [
        'pending_scan_groups',
        'pending_scan_resources',
        'pending_video_scrapes',
        'pending_video_scrape_sources',
        'pending_video_scrape_candidates',
        'pending_video_scrape_resources'
      ]) {
        assert.equal(tableExistsForTest(db, table), true, `${table} should exist`)
      }
    } finally {
      db.close()
    }
  })

  it('upgrades video identity without changing ids, resources, or site sources', () => {
    const db = new Database(':memory:')
    try {
      createV10VideoIdentitySchema(db)
      db.prepare("INSERT INTO organizations (id, main_name) VALUES (7, 'Publisher')").run()
      db.prepare(
        `INSERT INTO videos (
           id, code, title, publisher_organization_id, release_date, scraped_status, add_time
         ) VALUES (41, '  abc-001  ', 'Keep me', 7, '2024-03-04', 1, '2024-01-01')`
      ).run()
      db.prepare(
        `INSERT INTO video_resources (
           id, video_id, kind, locator, resource_key, is_primary
         ) VALUES (51, 41, 'local', '/library/ABC-001.mp4', 'local:/library/ABC-001.mp4', 1)`
      ).run()
      db.prepare(
        `INSERT INTO video_external_ids (
           id, video_id, source, external_id, external_code, url, title, fetched_at
         ) VALUES (61, 41, 'Site', NULL, 'ABC-001', 'https://example.test/v/1', 'Source title', '2024-03-05')`
      ).run()

      migrateFixture(db)

      assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      assert.deepEqual(
        db.prepare('SELECT id, code, title FROM videos').get(),
        { id: 41, code: 'ABC-001', title: 'Keep me' }
      )
      assert.deepEqual(
        db.prepare('SELECT id, video_id, locator, is_primary FROM video_resources').get(),
        { id: 51, video_id: 41, locator: '/library/ABC-001.mp4', is_primary: 1 }
      )
      assert.deepEqual(
        db.prepare('SELECT id, video_id, source, external_code, url, title FROM video_sources').get(),
        {
          id: 61,
          video_id: 41,
          source: 'Site',
          external_code: 'ABC-001',
          url: 'https://example.test/v/1',
          title: 'Source title'
        }
      )
    } finally {
      db.close()
    }
  })

  it('leaves a v10 database untouched when normalized business identities conflict', () => {
    const db = new Database(':memory:')
    try {
      createV10VideoIdentitySchema(db)
      db.prepare("INSERT INTO organizations (id, main_name) VALUES (7, 'Publisher')").run()
      db.prepare(
        "INSERT INTO videos (id, code, publisher_organization_id, release_date) VALUES (41, 'abc-001', 7, '2024-03-04')"
      ).run()
      db.prepare(
        "INSERT INTO videos (id, code, publisher_organization_id, release_date) VALUES (42, ' ABC-001 ', 7, '2024-03-04')"
      ).run()

      assert.throws(() => migrateFixture(db), /41.*42|42.*41/)

      assert.equal(db.pragma('user_version', { simple: true }), 10)
      assert.equal(tableExistsForTest(db, 'video_external_ids'), true)
      assert.equal(tableExistsForTest(db, 'video_sources'), false)
      assert.deepEqual(
        db.prepare('SELECT id, code FROM videos ORDER BY id').all(),
        [
          { id: 41, code: 'abc-001' },
          { id: 42, code: ' ABC-001 ' }
        ]
      )
    } finally {
      db.close()
    }
  })

  it('migrates legacy classification text into stable entities and retires legacy storage', () => {
    const db = new Database(':memory:')
    try {
      createV7ClassificationSchema(db)
      db.exec(`
        INSERT INTO videos (id, code, maker, publisher, series, director) VALUES
          (1, 'ONE',   'Ｓ １', 'Publisher A', 'Series A',       'Director A'),
          (2, 'TWO',   'S1',    'Ｓ １',        'Ｓｅｒｉｅｓ　Ａ', 'Ｄirector A'),
          (3, 'THREE', 'S1',    NULL,           NULL,             'Director A'),
          (4, 'FOUR',  NULL,    's 1',          NULL,             NULL);
        INSERT INTO facet_entries (type, value) VALUES
          ('maker', 'Lonely Org'),
          ('publisher', 'Ｌonely　Ｏrg'),
          ('director', 'Empty Director'),
          ('series', 'Empty Series');
      `)

      migrateFixture(db)

      assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      assert.deepEqual(
        db.prepare('SELECT main_name FROM organizations ORDER BY main_name').all(),
        [{ main_name: 'Lonely Org' }, { main_name: 'Publisher A' }, { main_name: 'S1' }]
      )
      const s1 = db
        .prepare("SELECT id FROM organizations WHERE main_name = 'S1'")
        .get() as { id: number }
      assert.deepEqual(
        db
          .prepare(
            `SELECT name, type
             FROM organization_names
             WHERE organization_id = ?
             ORDER BY CASE type WHEN 'main' THEN 0 ELSE 1 END, position, name`
          )
          .all(s1.id),
        [
          { name: 'S1', type: 'main' },
          { name: 's 1', type: 'alias' },
          { name: 'Ｓ １', type: 'alias' }
        ]
      )
      assert.deepEqual(
        db
          .prepare(
            'SELECT role FROM organization_roles WHERE organization_id = ? ORDER BY role'
          )
          .all(s1.id),
        [{ role: 'maker' }, { role: 'publisher' }]
      )
      assert.deepEqual(
        db
          .prepare(
            `SELECT ono.normalized_name, o.main_name
             FROM organization_name_ownership ono
             JOIN organizations o ON o.id = ono.organization_id
             ORDER BY ono.normalized_name`
          )
          .all(),
        [
          { normalized_name: 'lonelyorg', main_name: 'Lonely Org' },
          { normalized_name: 'publishera', main_name: 'Publisher A' },
          { normalized_name: 's1', main_name: 'S1' }
        ]
      )
      assert.deepEqual(
        db.prepare('SELECT main_name FROM directors ORDER BY main_name').all(),
        [{ main_name: 'Director A' }, { main_name: 'Empty Director' }]
      )
      assert.deepEqual(
        db
          .prepare(
            `SELECT s.main_name, s.owner_organization_id, sno.normalized_name
             FROM series s
             JOIN series_name_ownership sno ON sno.series_id = s.id
             ORDER BY s.main_name`
          )
          .all(),
        [
          {
            main_name: 'Empty Series',
            owner_organization_id: null,
            normalized_name: 'emptyseries'
          },
          {
            main_name: 'Series A',
            owner_organization_id: null,
            normalized_name: 'seriesa'
          }
        ]
      )

      assert.deepEqual(
        db
          .prepare(
            `SELECT v.code,
                    maker.main_name AS maker,
                    publisher.main_name AS publisher,
                    s.main_name AS series,
                    d.main_name AS director
             FROM videos v
             LEFT JOIN organizations maker ON maker.id = v.maker_organization_id
             LEFT JOIN organizations publisher ON publisher.id = v.publisher_organization_id
             LEFT JOIN series s ON s.id = v.series_id
             LEFT JOIN directors d ON d.id = v.director_id
             ORDER BY v.id`
          )
          .all(),
        [
          { code: 'ONE', maker: 'S1', publisher: 'Publisher A', series: 'Series A', director: 'Director A' },
          { code: 'TWO', maker: 'S1', publisher: 'S1', series: 'Series A', director: 'Director A' },
          { code: 'THREE', maker: 'S1', publisher: null, series: null, director: 'Director A' },
          { code: 'FOUR', maker: null, publisher: 'S1', series: null, director: null }
        ]
      )

      const videoColumns = columnNamesForTest(db, 'videos')
      assert.equal(videoColumns.has('maker'), false)
      assert.equal(videoColumns.has('publisher'), false)
      assert.equal(videoColumns.has('series'), false)
      assert.equal(videoColumns.has('director'), false)
      assert.equal(tableExistsForTest(db, 'facet_entries'), false)

      const snapshot = {
        organizations: rowCount(db, 'organizations'),
        organizationNames: rowCount(db, 'organization_names'),
        organizationRoles: rowCount(db, 'organization_roles'),
        directors: rowCount(db, 'directors'),
        directorNames: rowCount(db, 'director_names'),
        series: rowCount(db, 'series'),
        seriesNames: rowCount(db, 'series_names')
      }
      migrateFixture(db)
      assert.deepEqual(
        {
          organizations: rowCount(db, 'organizations'),
          organizationNames: rowCount(db, 'organization_names'),
          organizationRoles: rowCount(db, 'organization_roles'),
          directors: rowCount(db, 'directors'),
          directorNames: rowCount(db, 'director_names'),
          series: rowCount(db, 'series'),
          seriesNames: rowCount(db, 'series_names')
        },
        snapshot
      )
    } finally {
      db.close()
    }
  })

  it('retires v8 text storage without changing video metadata, entity ids, or child resources', () => {
    const db = new Database(':memory:')
    try {
      migrateFixture(db)
      db.exec(`
        ALTER TABLE videos ADD COLUMN maker TEXT;
        ALTER TABLE videos ADD COLUMN publisher TEXT;
        ALTER TABLE videos ADD COLUMN series TEXT;
        ALTER TABLE videos ADD COLUMN director TEXT;
        CREATE INDEX idx_videos_maker ON videos(maker);
        CREATE INDEX idx_videos_publisher ON videos(publisher);
        CREATE INDEX idx_videos_series ON videos(series);
        CREATE INDEX idx_videos_director ON videos(director);
        CREATE TABLE facet_entries (
          type TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (type, value)
        );
      `)
      const organizationId = Number(
        db.prepare("INSERT INTO organizations (main_name) VALUES ('Studio')").run().lastInsertRowid
      )
      const directorId = Number(
        db.prepare("INSERT INTO directors (main_name) VALUES ('Director')").run().lastInsertRowid
      )
      const seriesId = Number(
        db.prepare("INSERT INTO series (main_name) VALUES ('Series')").run().lastInsertRowid
      )
      const videoId = Number(
        db
          .prepare(
            `INSERT INTO videos (
               code, title, summary, rating, release_date, maker, publisher, series, director,
               maker_organization_id, publisher_organization_id, series_id, director_id,
               duration_seconds, scraped_status, updated_at, add_time
             ) VALUES (
               'V8-KEEP', 'Title', 'Summary', 5, '2024-01-02', 'Studio', 'Studio', 'Series',
               'Director', ?, ?, ?, ?, 7200, 1, '2024-01-03', '2024-01-04'
             )`
          )
          .run(organizationId, organizationId, seriesId, directorId).lastInsertRowid
      )
      db.prepare(
        `INSERT INTO library_video_memberships (library_id, video_id, discovery_key)
         VALUES (1, ?, ?)`
      ).run(videoId, videoId)
      db.prepare(
        `INSERT INTO video_resources
           (library_id, video_id, kind, locator, resource_key, size_bytes, is_primary)
         VALUES (1, ?, 'web', 'https://example.test/watch', 'http:v8-keep', 1234, 1)`
      ).run(videoId)
      db.prepare(
        `INSERT INTO video_assets (video_id, type, position, remote_url)
         VALUES (?, 'sample', 0, 'https://example.test/sample.jpg')`
      ).run(videoId)
      db.prepare("INSERT INTO facet_entries (type, value) VALUES ('maker', 'Unused')").run()
      db.pragma('user_version = 8')

      migrateFixture(db)

      assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      assert.deepEqual(
        db
          .prepare(
            `SELECT code, title, summary, rating, release_date, maker_organization_id,
                    publisher_organization_id, series_id, director_id, duration_seconds,
                    scraped_status, updated_at, add_time
             FROM videos WHERE id = ?`
          )
          .get(videoId),
        {
          code: 'V8-KEEP',
          title: 'Title',
          summary: 'Summary',
          rating: 5,
          release_date: '2024-01-02',
          maker_organization_id: organizationId,
          publisher_organization_id: organizationId,
          series_id: seriesId,
          director_id: directorId,
          duration_seconds: 7200,
          scraped_status: 1,
          updated_at: '2024-01-03',
          add_time: '2024-01-04'
        }
      )
      assert.equal(rowCount(db, 'video_resources'), 1)
      assert.equal(rowCount(db, 'video_assets'), 1)
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
      assert.equal(tableExistsForTest(db, 'facet_entries'), false)
      const columns = columnNamesForTest(db, 'videos')
      for (const column of ['maker', 'publisher', 'series', 'director']) {
        assert.equal(columns.has(column), false)
      }
    } finally {
      db.close()
    }
  })

  it('stores classification profiles, hierarchy, roles, links, and video references', () => {
    const db = new Database(':memory:')
    try {
      migrateFixture(db)
      const parentOrganizationId = Number(
        db.prepare("INSERT INTO organizations (main_name) VALUES ('Parent Org')").run()
          .lastInsertRowid
      )
      const organizationId = Number(
        db
          .prepare(
            `INSERT INTO organizations (
               main_name, summary, country_region, founded_year, status, parent_organization_id
             ) VALUES ('Studio One', 'Profile', 'JP', 2001, 'active', ?)`
          )
          .run(parentOrganizationId).lastInsertRowid
      )
      db.prepare(
        `INSERT INTO organization_names (
           organization_id, name, normalized_name, type, position
         ) VALUES (?, 'Studio One', 'studioone', 'main', 0)`
      ).run(organizationId)
      db.prepare(
        `INSERT INTO organization_name_ownership (normalized_name, organization_id)
         VALUES ('studioone', ?)`
      ).run(organizationId)
      db.prepare(
        `INSERT INTO organization_roles (organization_id, role)
         VALUES (?, 'maker'), (?, 'publisher')`
      ).run(organizationId, organizationId)
      db.prepare(
        `INSERT INTO organization_links (
           organization_id, label, url, normalized_url, position
         ) VALUES (?, 'Official', 'https://example.com/', 'https://example.com/', 0)`
      ).run(organizationId)

      const directorId = Number(
        db.prepare("INSERT INTO directors (main_name, status) VALUES ('Director One', 'active')").run()
          .lastInsertRowid
      )
      db.prepare(
        `INSERT INTO director_names (director_id, name, normalized_name, type, position)
         VALUES (?, 'Director One', 'directorone', 'main', 0)`
      ).run(directorId)
      db.prepare(
        `INSERT INTO director_links (director_id, label, url, normalized_url, position)
         VALUES (?, 'Profile', 'https://example.com/director', 'https://example.com/director', 0)`
      ).run(directorId)

      const parentSeriesId = Number(
        db.prepare("INSERT INTO series (main_name) VALUES ('Parent Series')").run().lastInsertRowid
      )
      const seriesId = Number(
        db
          .prepare(
            `INSERT INTO series (
               main_name, owner_organization_id, parent_series_id, start_year, status
             ) VALUES ('Series One', ?, ?, 2020, 'ongoing')`
          )
          .run(organizationId, parentSeriesId).lastInsertRowid
      )
      db.prepare(
        `INSERT INTO series_names (series_id, name, normalized_name, type, position)
         VALUES (?, 'Series One', 'seriesone', 'main', 0)`
      ).run(seriesId)
      db.prepare(
        `INSERT INTO series_name_ownership (
           owner_organization_id, normalized_name, series_id
         ) VALUES (?, 'seriesone', ?)`
      ).run(organizationId, seriesId)
      db.prepare(
        `INSERT INTO series_links (series_id, label, url, normalized_url, position)
         VALUES (?, 'Official', 'https://example.com/series', 'https://example.com/series', 0)`
      ).run(seriesId)

      db.prepare(
        `INSERT INTO videos (
           code, maker_organization_id, publisher_organization_id, director_id, series_id
         ) VALUES ('ENTITY-ONE', ?, ?, ?, ?)`
      ).run(organizationId, organizationId, directorId, seriesId)

      assert.deepEqual(
        db
          .prepare(
            `SELECT o.main_name AS organization,
                    parent.main_name AS parent_organization,
                    d.main_name AS director,
                    s.main_name AS series,
                    parent_series.main_name AS parent_series
             FROM videos v
             JOIN organizations o ON o.id = v.maker_organization_id
             LEFT JOIN organizations parent ON parent.id = o.parent_organization_id
             JOIN directors d ON d.id = v.director_id
             JOIN series s ON s.id = v.series_id
             LEFT JOIN series parent_series ON parent_series.id = s.parent_series_id
             WHERE v.code = 'ENTITY-ONE'`
          )
          .get(),
        {
          organization: 'Studio One',
          parent_organization: 'Parent Org',
          director: 'Director One',
          series: 'Series One',
          parent_series: 'Parent Series'
        }
      )
      assert.equal(rowCount(db, 'organization_links'), 1)
      assert.equal(rowCount(db, 'director_links'), 1)
      assert.equal(rowCount(db, 'series_links'), 1)
    } finally {
      db.close()
    }
  })

  it('rolls back the complete classification migration when entity creation fails', () => {
    const db = new Database(':memory:')
    try {
      createV7ClassificationSchema(db)
      db.exec(`
        CREATE TABLE organizations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          main_name TEXT NOT NULL,
          parent_organization_id INTEGER,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TRIGGER reject_classification_migration
        BEFORE INSERT ON organizations
        BEGIN
          SELECT RAISE(ABORT, 'forced classification migration failure');
        END;
        INSERT INTO videos (code, maker) VALUES ('ROLLBACK', 'Broken Org');
      `)

      assert.throws(() => migrateFixture(db), /forced classification migration failure/)
      assert.equal(db.pragma('user_version', { simple: true }), 7)
      assert.equal(rowCount(db, 'organizations'), 0)
      assert.equal(tableExistsForTest(db, 'directors'), false)
      assert.equal(tableExistsForTest(db, 'series'), false)
      const videoColumns = (db.prepare('PRAGMA table_info(videos)').all() as { name: string }[]).map(
        (column) => column.name
      )
      assert.equal(videoColumns.includes('maker_organization_id'), false)
      assert.deepEqual(db.prepare("SELECT maker FROM videos WHERE code = 'ROLLBACK'").get(), {
        maker: 'Broken Org'
      })
    } finally {
      db.close()
    }
  })

  it('rolls back classification entities when retiring legacy storage fails', () => {
    const db = new Database(':memory:')
    try {
      createV7ClassificationSchema(db)
      db.exec(`
        INSERT INTO videos (id, code, maker) VALUES (1, 'ROLLBACK-001', 'Legacy Studio');
        CREATE VIEW legacy_video_makers AS SELECT maker FROM videos;
      `)

      assert.throws(() => migrateFixture(db))

      assert.equal(db.pragma('user_version', { simple: true }), 7)
      assert.equal(tableExistsForTest(db, 'organizations'), false)
      assert.equal(columnNamesForTest(db, 'videos').has('maker_organization_id'), false)
      assert.deepEqual(db.prepare('SELECT maker FROM videos').get(), { maker: 'Legacy Studio' })
    } finally {
      db.close()
    }
  })

  it('migrates uncontested names to ownership and preserves cross-actress collisions for review', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-name-ownership-'))
    const dbPath = path.join(tempDir, 'library.db')
    const fixture = new Database(dbPath)
    try {
      createV4ActressSchema(fixture)
      ensureTagFixture(fixture)
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
      migrateFixture(db)
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

      assert.throws(() => migrateFixture(db), /FOREIGN KEY constraint failed/)

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
      migrateFixture(db)
      migrateFixture(db)

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
        'media_libraries',
        'media_library_configs',
        'media_library_roots',
        'library_video_memberships',
        'video_resources',
        'pending_local_file_deletions',
        'actresses',
        'video_actress',
        'tags',
        'video_tag',
        'video_sources',
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
        'actress_gallery_assets',
        'pending_scan_groups',
        'pending_scan_resources',
        'pending_video_scrapes',
        'pending_video_scrape_sources',
        'pending_video_scrape_candidates',
        'pending_video_scrape_resources',
        'video_links',
        'actress_links',
        'playlist_links',
        'agent_runs',
        'agent_operations',
        'agent_product_journal',
        'agent_execution_history',
        'agent_tool_ledger',
        'agent_approvals',
        'agent_artifacts',
        'agent_metadata_drafts',
        'agent_metadata_draft_resources',
        'library_scan_runs',
        'media_library_scan_state',
        'library_unrecognized_files',
        'library_root_cleanup_jobs'
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
      assert.equal(indexNames(db).includes('idx_video_resources_library_source_identity'), true)
      assert.equal(indexNames(db).includes('idx_video_resources_library_video_kind'), true)
      assert.equal(indexNames(db).includes('idx_video_tag_tag_id'), true)
      assert.equal(indexNames(db).includes('idx_videos_maker'), false)
      assert.equal(indexNames(db).includes('idx_videos_maker_organization_id'), true)
      assert.equal(indexNames(db).includes('idx_playlist_video_video_id'), true)
      assert.equal(indexNames(db).includes('idx_actress_names_one_main'), true)
      assert.equal(indexNames(db).includes('idx_actresses_scraped_status'), true)
      assert.equal(indexNames(db).includes('idx_videos_studio'), false)
      assert.equal(indexNames(db).includes('idx_videos_file_path'), false)
      assert.equal(columnNamesForTest(db, 'agent_runs').has('recovery_attempted_generation'), true)

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

      migrateFixture(db)
      migrateFixture(db)

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

  it('migrates released v1 inline video files and removes the obsolete write constraint', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE videos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT UNIQUE NOT NULL,
          title TEXT,
          summary TEXT,
          file_path TEXT NOT NULL,
          file_size INTEGER,
          cover_path TEXT,
          poster_path TEXT,
          original_title TEXT,
          rating INTEGER DEFAULT 0,
          release_date TEXT,
          maker TEXT,
          publisher TEXT,
          series TEXT,
          director TEXT,
          duration_seconds INTEGER,
          scraped_status INTEGER DEFAULT 0,
          last_scraped_at TEXT,
          updated_at TEXT,
          add_time DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX idx_videos_file_path ON videos(file_path);
        CREATE TABLE actresses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          main_name TEXT UNIQUE NOT NULL,
          last_scraped_at TEXT
        );
        INSERT INTO videos (
          id, code, title, file_path, file_size, duration_seconds, add_time
        ) VALUES (
          7, 'V1-007', 'Legacy video', '/library/V1-007.mp4', 987654321, 3600,
          '2024-01-02T03:04:05.000Z'
        );
      `)
      db.pragma('user_version = 1')

      migrateFixture(db)

      assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      assert.deepEqual(
        db
          .prepare(
            `SELECT video_id, kind, locator, resource_key, size_bytes,
                    duration_seconds, is_primary, add_time
             FROM video_resources`
          )
          .get(),
        {
          video_id: 7,
          kind: 'local',
          locator: '/library/V1-007.mp4',
          resource_key: 'local:/library/V1-007.mp4',
          size_bytes: 987654321,
          duration_seconds: 3600,
          is_primary: 1,
          add_time: '2024-01-02T03:04:05.000Z'
        }
      )
      const videoColumns = columnNamesForTest(db, 'videos')
      assert.equal(videoColumns.has('file_path'), false)
      assert.equal(videoColumns.has('file_size'), false)
      assert.doesNotThrow(() =>
        db.prepare("INSERT INTO videos (code, title) VALUES ('NEW-008', 'New video')").run()
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
      assert.throws(() => migrateFixture(db), /no longer supported/)
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
      migrateFixture(db)
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

      migrateFixture(db)

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
      migrateFixture(db)
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

      migrateFixture(db)

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

      migrateFixture(db)
      const first = db
        .prepare(
          `SELECT main_name, scraped_status, last_scraped_at
           FROM actresses
           ORDER BY id`
        )
        .all()

      migrateFixture(db)

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

      assert.throws(() => migrateFixture(db), /classification rejected/)

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
