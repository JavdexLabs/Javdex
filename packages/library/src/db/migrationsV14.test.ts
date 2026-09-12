import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'
import { normalizeLocalPathIdentity } from '@library/localPathIdentity'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'

const V13_SCHEMA_VERSION = 13

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

function rowCount(database: Database.Database, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count
}

/** Released V13 tables whose rows and constraints are affected by the V14 migration. */
function createV13ReleaseFixture(database: Database.Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    -- Minimal unaffected relationship/index required by the combined V16 migration.
    CREATE TABLE video_tag (video_id INTEGER NOT NULL, tag_id INTEGER NOT NULL,
      origin TEXT NOT NULL DEFAULT 'manual', PRIMARY KEY(video_id,tag_id));
    CREATE INDEX idx_video_tag_tag_id ON video_tag(tag_id);

    CREATE TABLE videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL DEFAULT '',
      title TEXT,
      add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );

    CREATE TABLE video_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('local', 'direct', 'web', 'magnet', 'ed2k')),
      locator TEXT NOT NULL,
      resource_key TEXT NOT NULL UNIQUE,
      strm_source_path TEXT,
      size_bytes INTEGER,
      duration_seconds INTEGER,
      file_mtime_ms INTEGER,
      display_name TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      add_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE TABLE video_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
      UNIQUE (video_id, normalized_url)
    );

    CREATE TABLE pending_scan_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      normalized_code TEXT NOT NULL UNIQUE CHECK(length(normalized_code) > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE pending_scan_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      normalized_path TEXT NOT NULL UNIQUE,
      scan_root TEXT NOT NULL,
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
      FOREIGN KEY (group_id) REFERENCES pending_scan_groups(id) ON DELETE CASCADE
    );

    INSERT INTO videos (id, code, title, add_time, updated_at) VALUES
      (7, 'ABC-001', 'Legacy local and link', '2024-01-02T03:04:05.000Z', NULL),
      (8, 'XYZ-002', 'Legacy STRM', '2024-02-03T04:05:06.000Z',
       '2024-03-04T05:06:07.000Z');

    INSERT INTO video_resources (
      id, video_id, kind, locator, resource_key, strm_source_path,
      size_bytes, duration_seconds, file_mtime_ms, display_name, is_primary, add_time
    ) VALUES
      (11, 7, 'local', '/legacy/ABC-001.mp4', 'local:/legacy/ABC-001.mp4', NULL,
       1000, 3600, 1710000000000, 'Local', 1, '2024-01-02T03:04:05.000Z'),
      (12, 7, 'direct', 'https://cdn.example/ABC-001.mp4',
       'http:https://cdn.example/ABC-001.mp4', NULL,
       NULL, NULL, NULL, 'Direct', 0, '2024-01-03T03:04:05.000Z'),
      (13, 8, 'web', 'https://stream.example/XYZ-002',
       'strm:/legacy/XYZ-002.strm', '/legacy/XYZ-002.strm',
       NULL, NULL, NULL, 'STRM', 1, '2024-02-03T04:05:06.000Z');

    INSERT INTO video_links (video_id, label, url, normalized_url, position) VALUES
      (7, 'www', 'https://www.example.test/video/7#detail',
       'https://www.example.test/video/7', 0),
      (7, 'apex', 'https://example.test/video/7',
       'https://example.test/video/7', 1),
      (7, 'credential', 'https://legacy:secret@secure.example.test/video/7#detail',
       'https://legacy:secret@secure.example.test/video/7', 2);

    INSERT INTO pending_scan_groups (
      id, normalized_code, created_at, updated_at
    ) VALUES (
      31, 'PEN-003', '2024-04-05T06:07:08.000Z', '2024-04-06T07:08:09.000Z'
    );
    INSERT INTO pending_scan_resources (
      id, group_id, file_path, normalized_path, scan_root, source_kind,
      target_kind, target_locator, target_key, size_bytes, duration_seconds,
      file_mtime_ms, display_name, created_at, updated_at
    ) VALUES (
      41, 31, '/legacy/PEN-003.mp4', '/legacy/PEN-003.mp4', '/legacy', 'local',
      NULL, NULL, NULL, 3000, 5400, 1720000000000, 'Pending',
      '2024-04-05T06:07:08.000Z', '2024-04-06T07:08:09.000Z'
    );

  `)
  database.pragma(`user_version = ${V13_SCHEMA_VERSION}`)
}

describe('V14 unreleased feature consolidation migration', () => {
  it('creates a fresh database with one active default media library', () => {
    const database = new Database(':memory:')
    try {
      database.pragma('foreign_keys = ON')

      migrateDatabase(database)

      assert.equal(CURRENT_SCHEMA_VERSION, 16)
      assert.equal(database.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      for (const table of [
        'media_libraries',
        'media_library_configs',
        'media_library_roots',
        'library_video_memberships',
        'library_scan_runs',
        'media_library_scan_state',
        'library_unrecognized_files',
        'library_root_cleanup_jobs',
        'agent_runs',
        'agent_metadata_drafts'
      ]) {
        assert.equal(tableExists(database, table), true, `${table} should exist`)
      }
      for (const table of [
        'playlist_import_jobs',
        'playlist_import_pages',
        'playlist_import_scroll_batches',
        'playlist_import_frontier',
        'playlist_import_items',
        'playlist_import_page_items',
        'playlist_import_decisions'
      ]) {
        assert.equal(tableExists(database, table), false, `${table} must remain session-only`)
      }

      const defaultLibraries = database
        .prepare(
          `SELECT id, name, icon, color, status, is_default, revision
           FROM media_libraries
           ORDER BY id`
        )
        .all() as Array<{
        id: number
        name: string
        icon: string
        color: string
        status: string
        is_default: number
        revision: number
      }>
      assert.equal(defaultLibraries.length, 1)
      assert.equal(defaultLibraries[0].name.trim().length > 0, true)
      assert.deepEqual(
        {
          icon: defaultLibraries[0].icon,
          color: defaultLibraries[0].color,
          status: defaultLibraries[0].status,
          isDefault: defaultLibraries[0].is_default,
          revision: defaultLibraries[0].revision
        },
        { icon: 'library', color: 'slate', status: 'active', isDefault: 1, revision: 1 }
      )
      assert.equal(
        rowCount(database, 'media_library_configs'),
        1,
        'the default library must have independent typed configuration'
      )
      assert.deepEqual(database.pragma('foreign_key_check'), [])
    } finally {
      database.close()
    }
  })

  it('upgrades released V13 data while keeping playlist import sessions out of the schema', () => {
    const database = new Database(':memory:')
    try {
      createV13ReleaseFixture(database)

      migrateDatabase(database)

      assert.equal(database.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      assert.deepEqual(
        {
          videos: rowCount(database, 'videos'),
          resources: rowCount(database, 'video_resources'),
          pendingGroups: rowCount(database, 'pending_scan_groups'),
          pendingResources: rowCount(database, 'pending_scan_resources'),
          agentRuns: rowCount(database, 'agent_runs'),
          agentDrafts: rowCount(database, 'agent_metadata_drafts')
        },
        {
          videos: 2,
          resources: 3,
          pendingGroups: 1,
          pendingResources: 1,
          agentRuns: 0,
          agentDrafts: 0
        }
      )
      assert.equal(columnNames(database, 'media_library_configs').has('default_cover_mode'), false)
      assert.deepEqual(
        database.prepare(
          'SELECT label, url, normalized_url, position FROM video_links WHERE video_id = 7 ORDER BY position, id'
        ).all(),
        [
          {
            label: 'www',
            url: 'https://www.example.test/video/7#detail',
            normalized_url: 'https://example.test/video/7',
            position: 0
          },
          {
            label: 'credential',
            url: 'https://secure.example.test/video/7#detail',
            normalized_url: 'https://secure.example.test/video/7',
            position: 2
          }
        ]
      )
      assert.equal(tableExists(database, 'playlist_import_jobs'), false)

      const defaultLibrary = database
        .prepare('SELECT id FROM media_libraries WHERE is_default = 1')
        .get() as { id: number }
      assert.deepEqual(
        database
          .prepare(
            `SELECT library_id, video_id, added_at, updated_at
             FROM library_video_memberships
             ORDER BY video_id`
          )
          .all(),
        [
          {
            library_id: defaultLibrary.id,
            video_id: 7,
            added_at: '2024-01-02T03:04:05.000Z',
            updated_at: '2024-01-02T03:04:05.000Z'
          },
          {
            library_id: defaultLibrary.id,
            video_id: 8,
            added_at: '2024-02-03T04:05:06.000Z',
            updated_at: '2024-03-04T05:06:07.000Z'
          }
        ]
      )

      const resources = database
        .prepare(
          `SELECT id, library_id, video_id, root_id, source_identity, is_primary
           FROM video_resources ORDER BY id`
        )
        .all() as Array<{
        id: number
        library_id: number
        video_id: number
        root_id: number | null
        source_identity: string | null
        is_primary: number
      }>
      assert.deepEqual(
        resources.map(({ id, library_id, video_id, source_identity, is_primary }) => ({
          id,
          library_id,
          video_id,
          source_identity,
          is_primary
        })),
        [
          {
            id: 11,
            library_id: defaultLibrary.id,
            video_id: 7,
            source_identity: `local:${normalizeLocalPathIdentity('/legacy/ABC-001.mp4')}`,
            is_primary: 1
          },
          {
            id: 12,
            library_id: defaultLibrary.id,
            video_id: 7,
            source_identity: null,
            is_primary: 0
          },
          {
            id: 13,
            library_id: defaultLibrary.id,
            video_id: 8,
            source_identity: `strm:${normalizeLocalPathIdentity('/legacy/XYZ-002.strm')}`,
            is_primary: 1
          }
        ]
      )
      assert.equal(
        (
          database
            .prepare(
              `SELECT COUNT(*) AS count
               FROM video_resources resource
               LEFT JOIN library_video_memberships membership
                 ON membership.library_id = resource.library_id
                AND membership.video_id = resource.video_id
               WHERE membership.video_id IS NULL`
            )
            .get() as { count: number }
        ).count,
        0
      )

      const pending = database
        .prepare(
          `SELECT pending_group.library_id, pending_resource.root_id,
                  root.library_id AS root_library_id, root.state AS root_state
           FROM pending_scan_groups pending_group
           JOIN pending_scan_resources pending_resource
             ON pending_resource.group_id = pending_group.id
           JOIN media_library_roots root ON root.id = pending_resource.root_id
           WHERE pending_group.id = 31 AND pending_resource.id = 41`
        )
        .get() as {
        library_id: number
        root_id: number
        root_library_id: number
        root_state: string
      }
      assert.equal(pending.library_id, defaultLibrary.id)
      assert.equal(pending.root_library_id, defaultLibrary.id)
      assert.equal(
        pending.root_state,
        'disabled',
        'a root inferred only from pending rows must not become an active scan root'
      )
      assert.equal(Number.isInteger(pending.root_id), true)
      assert.equal(columnNames(database, 'pending_scan_resources').has('scan_root'), false)

      assert.deepEqual(database.pragma('foreign_key_check'), [])
    } finally {
      database.close()
    }
  })

  it('scopes pending path identity to each library in the final V14 schema', () => {
    const database = new Database(':memory:')
    try {
      database.pragma('foreign_keys = ON')
      migrateDatabase(database)
      database.exec(`
        INSERT INTO media_libraries (id, name) VALUES (2, 'Second library');
        INSERT INTO media_library_roots (id, library_id, path, normalized_path)
        VALUES (101, 1, '/library-one', '/library-one'),
               (102, 2, '/library-two', '/library-two');
        INSERT INTO pending_scan_groups (id, library_id, normalized_code)
        VALUES (201, 1, 'SAME-001'), (202, 2, 'SAME-001');
        INSERT INTO pending_scan_resources (
          id, library_id, group_id, root_id, file_path, normalized_path
        ) VALUES
          (301, 1, 201, 101, '/library-one/SAME-001.mp4', '/shared/SAME-001.mp4'),
          (302, 2, 202, 102, '/library-two/SAME-001.mp4', '/shared/SAME-001.mp4');
      `)

      assert.equal(rowCount(database, 'pending_scan_resources'), 2)
      assert.throws(() =>
        database.prepare(`
          INSERT INTO pending_scan_resources (
            library_id, group_id, root_id, file_path, normalized_path
          ) VALUES (1, 201, 101, '/library-one/duplicate.mp4', '/shared/SAME-001.mp4')
        `).run()
      )
      assert.deepEqual(database.pragma('foreign_key_check'), [])
    } finally {
      database.close()
    }
  })

  it('enforces one primary per membership while archived sources can be adopted by another library', () => {
    const database = new Database(':memory:')
    try {
      database.pragma('foreign_keys = ON')
      migrateDatabase(database)
      const firstLibraryId = (
        database.prepare('SELECT id FROM media_libraries WHERE is_default = 1').get() as {
          id: number
        }
      ).id
      const secondLibraryId = Number(
        database
          .prepare("INSERT INTO media_libraries (name) VALUES ('Second library')")
          .run().lastInsertRowid
      )
      const videoId = Number(
        database.prepare("INSERT INTO videos (code) VALUES ('PRIMARY-001')").run().lastInsertRowid
      )
      const insertMembership = database.prepare(
        `INSERT INTO library_video_memberships (
           library_id, video_id, added_at, updated_at, added_via,
           is_pinned, is_hidden, discovery_key
         ) VALUES (?, ?, ?, ?, 'manual', 0, 0, ?)`
      )
      insertMembership.run(
        firstLibraryId,
        videoId,
        '2026-08-29T00:00:00.000Z',
        '2026-08-29T00:00:00.000Z',
        101
      )
      insertMembership.run(
        secondLibraryId,
        videoId,
        '2026-08-29T00:00:01.000Z',
        '2026-08-29T00:00:01.000Z',
        102
      )

      const insertResource = database.prepare(
        `INSERT INTO video_resources (
           library_id, video_id, kind, locator, resource_key,
           source_identity, is_primary, add_time
         ) VALUES (?, ?, 'direct', ?, ?, NULL, 1, ?)`
      )
      insertResource.run(
        firstLibraryId,
        videoId,
        'https://one.example/PRIMARY-001.mp4',
        'http:https://one.example/PRIMARY-001.mp4',
        '2026-08-29T00:00:00.000Z'
      )
      assert.throws(() =>
        insertResource.run(
          firstLibraryId,
          videoId,
          'https://two.example/PRIMARY-001.mp4',
          'http:https://two.example/PRIMARY-001.mp4',
          '2026-08-29T00:00:01.000Z'
        )
      )
      assert.doesNotThrow(() =>
        insertResource.run(
          secondLibraryId,
          videoId,
          'https://one.example/PRIMARY-001.mp4',
          'http:https://one.example/PRIMARY-001.mp4',
          '2026-08-29T00:00:02.000Z'
        )
      )
      const sourceIdentity = `local:${normalizeLocalPathIdentity('/archive/PRIMARY-001.mp4')}`
      const insertLocalSource = database.prepare(
        `INSERT INTO video_resources (
           library_id, video_id, kind, locator, resource_key,
           source_identity, is_primary, add_time
         ) VALUES (?, ?, 'local', ?, ?, ?, 0, CURRENT_TIMESTAMP)`
      )
      insertLocalSource.run(
        firstLibraryId,
        videoId,
        '/archive/PRIMARY-001.mp4',
        sourceIdentity,
        sourceIdentity
      )
      database
        .prepare("UPDATE media_libraries SET status = 'archived' WHERE id = ?")
        .run(firstLibraryId)
      assert.doesNotThrow(() =>
        insertLocalSource.run(
          secondLibraryId,
          videoId,
          '/archive/PRIMARY-001.mp4',
          sourceIdentity,
          sourceIdentity
        )
      )
      assert.throws(() =>
        database
          .prepare(
            `INSERT INTO video_resources (
               library_id, video_id, kind, locator, resource_key,
               source_identity, is_primary, add_time
             ) VALUES (?, ?, 'direct', 'https://orphan.example',
                       'http:https://orphan.example', NULL, 0, CURRENT_TIMESTAMP)`
          )
          .run(secondLibraryId, videoId + 999)
      )
      assert.deepEqual(database.pragma('foreign_key_check'), [])
    } finally {
      database.close()
    }
  })

  it('rolls back V14 when released source paths normalize to the same identity', () => {
    const database = new Database(':memory:')
    try {
      createV13ReleaseFixture(database)
      const aliasedPath = path.join('/legacy', 'nested', '..', 'ABC-001.mp4')
      assert.equal(
        normalizeLocalPathIdentity(aliasedPath),
        normalizeLocalPathIdentity('/legacy/ABC-001.mp4')
      )
      database
        .prepare(
          `INSERT INTO video_resources (
             id, video_id, kind, locator, resource_key, is_primary, add_time
           ) VALUES (14, 8, 'local', ?, 'local:/legacy/nested/../ABC-001.mp4', 0,
                     '2024-06-07T08:09:10.000Z')`
        )
        .run(aliasedPath)

      assert.throws(
        () => migrateDatabase(database),
        /(source[_ ]identity|源文件|源身份|重复.*路径)/i
      )

      assert.equal(database.pragma('user_version', { simple: true }), V13_SCHEMA_VERSION)
      assert.equal(tableExists(database, 'media_libraries'), false)
      assert.equal(rowCount(database, 'videos'), 2)
      assert.equal(rowCount(database, 'video_resources'), 4)
      assert.equal(columnNames(database, 'video_resources').has('library_id'), false)
      assert.deepEqual(database.pragma('foreign_key_check'), [])
    } finally {
      database.close()
    }
  })
})
