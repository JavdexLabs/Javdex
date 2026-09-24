import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath } from './database'
import { normalizeActressName } from './actressNameNormalization'
import {
  DEFAULT_MEDIA_LIBRARY_CONFIG,
  type MediaLibrarySummary
} from '@shared/mediaLibraryTypes'
import { migrateDatabase } from './migrations'
import { createScopedVideoCatalogRepo } from './scopedVideoCatalogRepo'
import { createHomeDiscoveryRepo, discoveryCursorForSeed } from './homeDiscoveryRepo'

function createFixture(verbose?: (sql: string) => void): Database.Database {
  const database = new Database(
    ':memory:',
    verbose ? { verbose: (message) => verbose(String(message)) } : undefined
  )
  database.pragma('foreign_keys = ON')
  database.function('normalize_actress_name', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? normalizeActressName(value) : null
  )
  migrateDatabase(database)
  database.exec(`
    INSERT INTO media_libraries (
      id, name, icon, color, position, status, is_default, revision
    ) VALUES (2, '第二库', 'folder', 'blue', 1, 'active', 0, 1);
    INSERT INTO media_library_configs (library_id, include_in_home_discovery)
    VALUES (2, 1);

    INSERT INTO videos (id, code, title) VALUES
      (201, 'HOME-201', 'Shared title'),
      (202, 'HOME-202', 'Library A title'),
      (203, 'HOME-203', 'Library B title'),
      (204, 'HOME-204', 'Another title');

    INSERT INTO library_video_memberships (
      library_id, video_id, added_at, updated_at, added_via, discovery_key
    ) VALUES
      (1, 201, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'scan', 10),
      (2, 201, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'shared', 20),
      (1, 202, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', 'scan', 30),
      (2, 203, '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', 'scan', 40),
      (2, 204, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', 'scan', 50);

    INSERT INTO video_resources (
      library_id, video_id, kind, locator, resource_key, source_identity, is_primary
    ) VALUES
      (1, 201, 'web', 'https://example.test/a/201', 'web:a-201', NULL, 1),
      (2, 201, 'web', 'https://example.test/b/201', 'web:b-201', NULL, 1),
      (1, 202, 'web', 'https://example.test/a/202', 'web:a-202', NULL, 1),
      (2, 203, 'web', 'https://example.test/b/203', 'web:b-203', NULL, 1),
      (2, 204, 'web', 'https://example.test/b/204', 'web:b-204', NULL, 1);
  `)
  return database
}

function seedLargeSharedCatalog(database: Database.Database, count = 1_200): void {
  const insertVideo = database.prepare(
    'INSERT INTO videos (id, code, title) VALUES (?, ?, ?)'
  )
  const insertMembership = database.prepare(
    `INSERT INTO library_video_memberships (
       library_id, video_id, added_at, updated_at, added_via, discovery_key
     ) VALUES (?, ?, ?, ?, ?, ?)`
  )
  const insertResource = database.prepare(
    `INSERT INTO video_resources (
       library_id, video_id, kind, locator, resource_key, source_identity, is_primary
     ) VALUES (?, ?, 'web', ?, ?, NULL, 1)`
  )
  database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const videoId = 1_000 + index
      const addedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      const discoveryKey = (Math.imul(index + 1, 104_729) >>> 1) % 2_147_483_647
      insertVideo.run(videoId, `GLOBAL-${String(index).padStart(4, '0')}`, `Global match ${index}`)
      insertMembership.run(1, videoId, addedAt, addedAt, 'scan', discoveryKey)
      insertResource.run(
        1,
        videoId,
        `https://a.example.test/${videoId}`,
        `web:a-${videoId}`
      )
      if (index % 2 !== 0) continue
      const sharedAt = new Date(Date.parse(addedAt) + 500).toISOString()
      insertMembership.run(2, videoId, sharedAt, sharedAt, 'shared', discoveryKey + 1)
      insertResource.run(
        2,
        videoId,
        `https://b.example.test/${videoId}`,
        `web:b-${videoId}`
      )
    }
  })()
}

function selectStatements(trace: string[]): string[] {
  return trace
    .map((statement) => statement.trim())
    // Revision reads are constant-cost bookkeeping, counted separately from catalog work.
    .filter((statement) => /^(SELECT|WITH)\b/i.test(statement) && !statement.includes('AS revision_changes'))
}

function explainPlan(database: Database.Database, statement: string): string[] {
  return (
    database.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as Array<{ detail: string }>
  ).map((row) => row.detail)
}

function librarySummary(id: number, name: string): MediaLibrarySummary {
  return {
    id,
    name,
    icon: id === 1 ? 'library' : 'folder',
    color: id === 1 ? 'slate' : 'blue',
    position: id - 1,
    status: 'active',
    isDefault: id === 1,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    config: {
      libraryId: id,
      ...DEFAULT_MEDIA_LIBRARY_CONFIG,
      revision: 1
    },
    rootCount: 1,
    activeRootCount: 1,
    pendingRemovalRootCount: 0,
    pendingCleanupJobCount: 0,
    pendingScanGroupCount: 0,
    disabledRootCount: 0,
    archivedRootCount: 0
  }
}

describe('home discovery repo', () => {
  it('returns one bounded status summary for every visible media library', () => {
    const trace: string[] = []
    const database = createFixture((sql) => trace.push(sql))
    try {
      database.exec(`
        INSERT INTO media_library_roots (
          id, library_id, path, normalized_path, position, state
        ) VALUES
          (11, 1, '/media/default', '/media/default', 0, 'active'),
          (13, 1, '/media/default-offline', '/media/default-offline', 1, 'active'),
          (12, 2, '/media/second', '/media/second', 0, 'active');

        INSERT INTO pending_scan_groups (
          id, library_id, normalized_code, revision, created_at, updated_at
        ) VALUES
          (21, 1, 'PENDING-A', 1, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
          (22, 2, 'PENDING-B', 1, '2026-06-02T00:00:00.000Z', '2026-06-02T00:00:00.000Z');

        INSERT INTO pending_scan_resources (
          library_id, group_id, root_id, file_path, normalized_path
        ) VALUES
          (1, 21, 11, '/media/default/a.mp4', '/media/default/a.mp4'),
          (2, 22, 12, '/media/second/b.mp4', '/media/second/b.mp4'),
          (2, 22, 12, '/media/second/c.mp4', '/media/second/c.mp4');

        INSERT INTO library_scan_runs (
          id, library_id, config_revision, trigger, status, started_at, finished_at
        ) VALUES (
          'home-run-1', 1, 1, 'manual', 'completed',
          '2026-06-03T10:00:00.000Z', '2026-06-03T10:04:00.000Z'
        );
        UPDATE media_library_scan_state
           SET last_status = 'completed',
               last_started_at = '2026-06-03T10:00:00.000Z',
               last_finished_at = '2026-06-03T10:04:00.000Z',
               last_successful_at = '2026-06-03T10:04:00.000Z',
               last_summary_json = '{
                 "libraryId": 1,
                 "offlineFolders": ["/media/default-offline"]
               }'
         WHERE library_id = 1;

        INSERT INTO library_unrecognized_files (
          library_id, root_id, file_path, normalized_path, reason, scan_run_id, last_seen_at
        ) VALUES (
          1, 11, '/media/default/unknown.mp4', '/media/default/unknown.mp4',
          'unrecognized_code', 'home-run-1', '2026-06-03T10:04:00.000Z'
        );
      `)
      trace.length = 0

      const catalog = createScopedVideoCatalogRepo(database)
      const repo = createHomeDiscoveryRepo({
        database,
        catalog,
        listLibraries: () => [
          { ...librarySummary(1, '默认媒体库'), rootCount: 2, activeRootCount: 2 },
          librarySummary(2, '第二库')
        ]
      })
      const snapshot = repo.load({ seed: 'library-status', recentLimit: 1, discoveryLimit: 1 })

      assert.deepEqual(
        snapshot.libraries.map((library) => ({
          id: library.id,
          membershipCount: library.membershipCount,
          resourceCount: library.resourceCount,
          pendingScanGroupCount: library.pendingScanGroupCount,
          pendingScanResourceCount: library.pendingScanResourceCount,
          unrecognizedFileCount: library.unrecognizedFileCount,
          lastScanStatus: library.lastScanStatus,
          lastScanStartedAt: library.lastScanStartedAt,
          lastScanFinishedAt: library.lastScanFinishedAt,
          lastSuccessfulScanAt: library.lastSuccessfulScanAt,
          lastScanOfflineRootCount: library.lastScanOfflineRootCount,
          activeRootCount: library.activeRootCount,
          rootCount: library.rootCount
        })),
        [
          {
            id: 1,
            membershipCount: 2,
            resourceCount: 2,
            pendingScanGroupCount: 1,
            pendingScanResourceCount: 1,
            unrecognizedFileCount: 1,
            lastScanStatus: 'completed',
            lastScanStartedAt: '2026-06-03T10:00:00.000Z',
            lastScanFinishedAt: '2026-06-03T10:04:00.000Z',
            lastSuccessfulScanAt: '2026-06-03T10:04:00.000Z',
            lastScanOfflineRootCount: 1,
            activeRootCount: 2,
            rootCount: 2
          },
          {
            id: 2,
            membershipCount: 3,
            resourceCount: 3,
            pendingScanGroupCount: 1,
            pendingScanResourceCount: 2,
            unrecognizedFileCount: 0,
            lastScanStatus: null,
            lastScanStartedAt: null,
            lastScanFinishedAt: null,
            lastSuccessfulScanAt: null,
            lastScanOfflineRootCount: null,
            activeRootCount: 1,
            rootCount: 1
          }
        ]
      )

      const summaryStatements = selectStatements(trace).filter((statement) =>
        statement.includes('membership_count')
      )
      assert.equal(summaryStatements.length, 1)
    } finally {
      database.close()
    }
  })

  it('uses membership time for recent additions and deduplicates shared videos', () => {
    const database = createFixture()
    try {
      const catalog = createScopedVideoCatalogRepo(database)
      const repo = createHomeDiscoveryRepo({ database, catalog, listLibraries: () => [] })
      const snapshot = repo.load({ seed: 'stable', recentLimit: 3, discoveryLimit: 2 })
      assert.deepEqual(snapshot.recent.map((video) => video.id), [204, 203, 202])
      assert.equal(new Set(snapshot.recent.map((video) => video.id)).size, 3)
    } finally {
      database.close()
    }
  })

  it('keeps a discovery batch stable until the seed changes', () => {
    const database = createFixture()
    try {
      const catalog = createScopedVideoCatalogRepo(database)
      const repo = createHomeDiscoveryRepo({ database, catalog, listLibraries: () => [] })
      const first = repo.load({ seed: 'batch-a', discoveryLimit: 3 }).discovery.map((v) => v.id)
      const repeated = repo
        .load({ seed: 'batch-a', discoveryLimit: 3 })
        .discovery.map((v) => v.id)
      assert.deepEqual(repeated, first)
      assert.notEqual(discoveryCursorForSeed('batch-a'), discoveryCursorForSeed('batch-b'))
    } finally {
      database.close()
    }
  })

  it('does not recommend a membership that has no playable resource in an eligible library', () => {
    const database = createFixture()
    try {
      database
        .prepare('DELETE FROM video_resources WHERE library_id = 2 AND video_id = 204')
        .run()
      const catalog = createScopedVideoCatalogRepo(database)
      const repo = createHomeDiscoveryRepo({ database, catalog, listLibraries: () => [] })
      assert.equal(
        repo.load({ seed: 'bounded', discoveryLimit: 10 }).discovery.some((video) => video.id === 204),
        false
      )
    } finally {
      database.close()
    }
  })

  it('does not recommend a local-only membership whose media-library root is disabled', () => {
    const database = createFixture()
    try {
      database.exec(`
        INSERT INTO media_library_roots (
          id, library_id, path, normalized_path, position, state
        ) VALUES (
          31, 1, '/media/disabled-home-root', '/media/disabled-home-root', 0, 'disabled'
        );

        INSERT INTO videos (id, code, title)
        VALUES (205, 'HOME-205', 'Disabled root only');

        INSERT INTO library_video_memberships (
          library_id, video_id, added_at, updated_at, added_via, discovery_key
        ) VALUES (
          1, 205, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 'scan', 60
        );

        INSERT INTO video_resources (
          library_id, video_id, root_id, kind, locator, resource_key,
          source_identity, is_primary
        ) VALUES (
          1, 205, 31, 'local', '/media/disabled-home-root/HOME-205.mp4',
          'local:/media/disabled-home-root/HOME-205.mp4',
          'local:/media/disabled-home-root/HOME-205.mp4', 1
        );
      `)
      const catalog = createScopedVideoCatalogRepo(database)
      const repo = createHomeDiscoveryRepo({ database, catalog, listLibraries: () => [] })

      assert.equal(
        repo
          .load({ seed: 'disabled-root-only', discoveryLimit: 10 })
          .discovery.some((video) => video.id === 205),
        false
      )
    } finally {
      database.close()
    }
  })

  it('excludes managed resources owned by pending-removal or archived roots', () => {
    const database = createFixture()
    try {
      database.exec(`
        INSERT INTO media_library_roots (
          id, library_id, path, normalized_path, position, state
        ) VALUES
          (32, 1, '/media/pending-home-root', '/media/pending-home-root', 0, 'pending_removal'),
          (33, 1, '/media/archived-home-root', '/media/archived-home-root', 1, 'archived');

        INSERT INTO videos (id, code, title) VALUES
          (206, 'HOME-206', 'Pending root only'),
          (207, 'HOME-207', 'Archived root only');

        INSERT INTO library_video_memberships (
          library_id, video_id, added_at, updated_at, added_via, discovery_key
        ) VALUES
          (1, 206, '2026-06-02T00:00:00.000Z', '2026-06-02T00:00:00.000Z', 'scan', 61),
          (1, 207, '2026-06-03T00:00:00.000Z', '2026-06-03T00:00:00.000Z', 'scan', 62);

        INSERT INTO video_resources (
          library_id, video_id, root_id, kind, locator, resource_key,
          source_identity, is_primary
        ) VALUES
          (1, 206, 32, 'local', '/media/pending-home-root/HOME-206.mp4',
           'local:/media/pending-home-root/HOME-206.mp4',
           'local:/media/pending-home-root/HOME-206.mp4', 1),
          (1, 207, 33, 'local', '/media/archived-home-root/HOME-207.mp4',
           'local:/media/archived-home-root/HOME-207.mp4',
           'local:/media/archived-home-root/HOME-207.mp4', 1);
      `)
      const catalog = createScopedVideoCatalogRepo(database)
      const repo = createHomeDiscoveryRepo({ database, catalog, listLibraries: () => [] })
      const discoveredIds = repo
        .load({ seed: 'inactive-managed-roots', discoveryLimit: 20 })
        .discovery.map((video) => video.id)

      assert.equal(discoveredIds.includes(206), false)
      assert.equal(discoveredIds.includes(207), false)
    } finally {
      database.close()
    }
  })

  it('keeps rootless external links and active-root local or STRM resources eligible', () => {
    const database = createFixture()
    try {
      database.exec(`
        INSERT INTO media_library_roots (
          id, library_id, path, normalized_path, position, state
        ) VALUES (
          34, 1, '/media/active-home-root', '/media/active-home-root', 0, 'active'
        );

        INSERT INTO videos (id, code, title) VALUES
          (208, 'HOME-208', 'Active local'),
          (209, 'HOME-209', 'Active STRM');

        INSERT INTO library_video_memberships (
          library_id, video_id, added_at, updated_at, added_via, discovery_key
        ) VALUES
          (1, 208, '2026-06-04T00:00:00.000Z', '2026-06-04T00:00:00.000Z', 'scan', 63),
          (1, 209, '2026-06-05T00:00:00.000Z', '2026-06-05T00:00:00.000Z', 'scan', 64);

        INSERT INTO video_resources (
          library_id, video_id, root_id, kind, locator, resource_key,
          source_identity, strm_source_path, is_primary
        ) VALUES
          (1, 208, 34, 'local', '/media/active-home-root/HOME-208.mp4',
           'local:/media/active-home-root/HOME-208.mp4',
           'local:/media/active-home-root/HOME-208.mp4', NULL, 1),
          (1, 209, 34, 'web', 'https://example.test/HOME-209',
           'strm:/media/active-home-root/HOME-209.strm',
           'strm-source:/media/active-home-root/HOME-209.strm',
           '/media/active-home-root/HOME-209.strm', 1);
      `)
      const catalog = createScopedVideoCatalogRepo(database)
      const repo = createHomeDiscoveryRepo({ database, catalog, listLibraries: () => [] })
      const discoveredIds = repo
        .load({ seed: 'eligible-resource-kinds', discoveryLimit: 20 })
        .discovery.map((video) => video.id)

      assert.equal(discoveredIds.includes(202), true, 'rootless external link remains eligible')
      assert.equal(discoveredIds.includes(208), true, 'active-root local resource remains eligible')
      assert.equal(discoveredIds.includes(209), true, 'active-root STRM resource remains eligible')
    } finally {
      database.close()
    }
  })

  it('does not accept a managed resource whose root belongs to another library', () => {
    const database = createFixture()
    try {
      database.pragma('foreign_keys = OFF')
      database.exec(`
        INSERT INTO media_library_roots (
          id, library_id, path, normalized_path, position, state
        ) VALUES (
          35, 2, '/media/other-library-root', '/media/other-library-root', 0, 'active'
        );

        INSERT INTO videos (id, code, title)
        VALUES (210, 'HOME-210', 'Cross-library root mismatch');

        INSERT INTO library_video_memberships (
          library_id, video_id, added_at, updated_at, added_via, discovery_key
        ) VALUES (
          1, 210, '2026-06-06T00:00:00.000Z', '2026-06-06T00:00:00.000Z', 'scan', 65
        );

        INSERT INTO video_resources (
          library_id, video_id, root_id, kind, locator, resource_key,
          source_identity, is_primary
        ) VALUES (
          1, 210, 35, 'local', '/media/other-library-root/HOME-210.mp4',
          'local:/media/other-library-root/HOME-210.mp4',
          'local:/media/other-library-root/HOME-210.mp4', 1
        );
      `)
      database.pragma('foreign_keys = ON')
      const catalog = createScopedVideoCatalogRepo(database)
      const repo = createHomeDiscoveryRepo({ database, catalog, listLibraries: () => [] })

      assert.equal(
        repo
          .load({ seed: 'cross-library-root', discoveryLimit: 20 })
          .discovery.some((video) => video.id === 210),
        false
      )
    } finally {
      database.close()
    }
  })

  it('binds a shared recommendation to the source membership that has its playable resource', () => {
    const database = createFixture()
    try {
      database
        .prepare('DELETE FROM video_resources WHERE library_id = 2 AND video_id = 201')
        .run()
      const catalog = createScopedVideoCatalogRepo(database)
      const repo = createHomeDiscoveryRepo({ database, catalog, listLibraries: () => [] })

      const shared = repo
        .load({ seed: 'shared-source', discoveryLimit: 10 })
        .discovery.find((video) => video.id === 201)

      assert.ok(shared)
      assert.equal(shared.preferredLibraryId, 1)
      assert.equal(shared.resource_count, 1)
      assert.deepEqual(shared.resource_kinds, ['web'])
    } finally {
      database.close()
    }
  })

  it('searches globally without duplicates and honors an explicit library filter', () => {
    const database = createFixture()
    try {
      const catalog = createScopedVideoCatalogRepo(database)
      const repo = createHomeDiscoveryRepo({ database, catalog, listLibraries: () => [] })
      assert.deepEqual(
        repo.search({ search: 'title', sortBy: 'code', sortDir: 'asc' }).items.map((v) => v.id),
        [201, 202, 203, 204]
      )
      assert.deepEqual(
        repo
          .search({ search: 'title', libraryIds: [1], sortBy: 'code', sortDir: 'asc' })
          .items.map((v) => v.id),
        [201, 202]
      )
    } finally {
      database.close()
    }
  })

  it('excludes libraries disabled for home discovery', () => {
    const database = createFixture()
    try {
      database
        .prepare('UPDATE media_library_configs SET include_in_home_discovery = 0 WHERE library_id = 2')
        .run()
      const catalog = createScopedVideoCatalogRepo(database)
      const repo = createHomeDiscoveryRepo({ database, catalog, listLibraries: () => [] })
      const snapshot = repo.load({ seed: 'only-a', recentLimit: 10, discoveryLimit: 10 })
      assert.deepEqual(snapshot.recent.map((video) => video.id), [202, 201])
      assert.deepEqual(new Set(snapshot.discovery.map((video) => video.id)), new Set([201, 202]))
    } finally {
      database.close()
    }
  })

  it('matches global ranking across cursor wrap, equal keys and hidden shared memberships', () => {
    const database = createFixture()
    try {
      seedLargeSharedCatalog(database, 180)
      database.exec(`
        UPDATE library_video_memberships SET discovery_key = 100 WHERE video_id % 3 = 0;
        UPDATE library_video_memberships SET discovery_key = 50 WHERE library_id = 2 AND video_id % 5 = 0;
        UPDATE library_video_memberships SET is_hidden = 1 WHERE library_id = 1 AND video_id % 7 = 0;
        DELETE FROM video_resources WHERE library_id = 2 AND video_id % 11 = 0;
      `)
      // Exercise compound-query chunking and canonical selection across chunk boundaries.
      database.transaction(() => {
        for (let id = 3; id <= 70; id++) {
          database.prepare('INSERT INTO media_libraries (id, name) VALUES (?, ?)').run(id, `Library ${id}`)
          database.prepare('INSERT INTO media_library_configs (library_id) VALUES (?)').run(id)
          database.prepare('INSERT INTO library_video_memberships (library_id, video_id, discovery_key) VALUES (?, 201, ?)').run(id, 71 - id)
          database.prepare(`INSERT INTO video_resources (library_id, video_id, kind, locator, resource_key)
            VALUES (?, 201, 'web', 'https://example.test/shared', 'web:shared')`).run(id)
        }
      })()
      const repo = createHomeDiscoveryRepo({ database, listLibraries: () => [] })
      for (const selected of [[1], [2], [1, 2], Array.from({ length: 70 }, (_, id) => id + 1)]) {
        const ranked = database.prepare(`
          SELECT video_id, library_id, discovery_key FROM (
            SELECT membership.video_id, membership.library_id, membership.discovery_key,
              ROW_NUMBER() OVER (PARTITION BY membership.video_id
                ORDER BY membership.discovery_key, membership.library_id) AS rank
            FROM library_video_memberships membership
            JOIN media_libraries library ON library.id = membership.library_id
            JOIN media_library_configs config ON config.library_id = library.id
            WHERE membership.library_id IN (${selected.join(',')})
              AND membership.is_hidden = 0 AND library.status = 'active'
              AND config.include_in_home_discovery = 1
              AND EXISTS (SELECT 1 FROM video_resources r
                WHERE r.video_id = membership.video_id AND r.library_id = membership.library_id)
          ) WHERE rank = 1 ORDER BY discovery_key, video_id
        `).all() as Array<{ video_id: number; library_id: number; discovery_key: number }>
        for (let index = 0; index < 20; index++) {
          const seed = `ranking-parity-${index}`
          const cursor = discoveryCursorForSeed(seed)
          const expected = [...ranked.filter(row => row.discovery_key >= cursor),
            ...ranked.filter(row => row.discovery_key < cursor)].slice(0, 16)
          assert.deepEqual(
            repo.load({ seed, libraryIds: selected, discoveryLimit: 16 }).discovery
              .map(video => [video.id, video.preferredLibraryId]),
            expected.map(row => [row.video_id, row.library_id])
          )
        }
      }
    } finally {
      database.close()
    }
  })

  it('keeps large recent and discovery loads bounded and index-backed', () => {
    const trace: string[] = []
    const database = createFixture((sql) => trace.push(sql))
    try {
      seedLargeSharedCatalog(database)
      trace.length = 0
      const catalog = createScopedVideoCatalogRepo(database)
      const repo = createHomeDiscoveryRepo({ database, catalog, listLibraries: () => [] })

      const snapshot = repo.load({ seed: 'large-plan', recentLimit: 60, discoveryLimit: 60 })
      assert.equal(snapshot.recent.length, 60)
      assert.equal(snapshot.discovery.length, 60)
      assert.equal(new Set(snapshot.recent.map((video) => video.id)).size, 60)
      assert.equal(new Set(snapshot.discovery.map((video) => video.id)).size, 60)

      const statements = selectStatements(trace)
      assert.ok(statements.length <= 6, `expected bounded queries, received ${statements.length}`)
      assert.equal(statements.some((statement) => /ORDER\s+BY\s+RANDOM\s*\(/i.test(statement)), false)

      const recent = statements.find(
        (statement) =>
          statement.includes('WITH page AS MATERIALIZED') &&
          statement.includes('scope_m.membership_added_at DESC')
      )
      const discovery = statements.find((statement) => statement.startsWith('WITH candidate AS'))
      assert.ok(recent)
      assert.ok(discovery)
      const recentPlan = explainPlan(database, recent).join('\n')
      const discoveryPlan = explainPlan(database, discovery).join('\n')
      assert.match(
        recentPlan,
        /idx_library_video_memberships_(library_added|recent|visible_video_added)/
      )
      assert.match(recentPlan, /idx_video_resources_library_video_kind/)
      assert.match(discoveryPlan, /idx_library_video_memberships_discovery/)
      assert.match(discoveryPlan, /idx_video_resources_library_video/)
    } finally {
      database.close()
    }
  })

  it('paginates a large global search without duplicates or per-row queries', () => {
    const trace: string[] = []
    const database = createFixture((sql) => trace.push(sql))
    try {
      seedLargeSharedCatalog(database)
      const catalog = createScopedVideoCatalogRepo(database)
      const repo = createHomeDiscoveryRepo({ database, catalog, listLibraries: () => [] })

      trace.length = 0
      const first = repo.search({
        search: 'Global match',
        sortBy: 'code',
        sortDir: 'asc',
        limit: 100,
        offset: 0
      })
      const firstStatements = selectStatements(trace)
      trace.length = 0
      const second = repo.search({
        search: 'Global match',
        sortBy: 'code',
        sortDir: 'asc',
        limit: 100,
        offset: 100
      })

      assert.equal(first.total, 1_200)
      assert.equal(second.total, 1_200)
      assert.equal(first.items.length, 100)
      assert.equal(second.items.length, 100)
      const combinedIds = [...first.items, ...second.items].map((video) => video.id)
      assert.equal(new Set(combinedIds).size, 200)
      assert.equal(firstStatements.length, 3)
      assert.equal(selectStatements(trace).length, 2)
      assert.equal(selectStatements(trace).some(statement => /^SELECT COUNT\(\*\) AS count FROM videos/.test(statement)), false)
      assert.equal(
        [...firstStatements, ...selectStatements(trace)].some((statement) =>
          /ORDER\s+BY\s+RANDOM\s*\(/i.test(statement)
        ),
        false
      )

      const pageStatement = firstStatements.find((statement) =>
        statement.includes('WITH page AS MATERIALIZED')
      )
      assert.ok(pageStatement)
      const plan = explainPlan(database, pageStatement).join('\n')
      assert.match(plan, /idx_library_video_memberships_(recent|visible_video_added|video)/)
    } finally {
      database.close()
    }
  })
})

it('uses only the supplied native connection and reuses home/status work across repeated seeds', () => {
  const trace: string[] = [], database = createFixture(sql => trace.push(sql))
  try {
    // No global getDb initialization and no injected listLibraries fallback.
    const repo = createHomeDiscoveryRepo({ database })
    trace.length = 0
    const first = repo.load({ seed: 'native' })
    const expected = structuredClone(first)
    first.libraries[0].name = 'caller mutation'
    first.recent.length = 0
    assert.deepEqual(repo.load({ seed: 'native' }), expected)
    repo.load({ seed: 'different seed' })
    assert.equal(trace.filter(sql => /^\s*WITH membership_counts AS/.test(sql)).length, 1)
    assert.equal(createHomeDiscoveryRepo({ database }), repo)
    database.exec("UPDATE media_libraries SET name='Changed' WHERE id=1")
    assert.equal(repo.load({ seed: 'native' }).libraries.find(library => library.id === 1)?.name, 'Changed')
    assert.throws(() => database.transaction(() => {
      database.exec("UPDATE media_libraries SET name='Uncommitted' WHERE id=1")
      assert.equal(repo.load({ seed: 'native' }).libraries.find(library => library.id === 1)?.name, 'Uncommitted')
      throw new Error('rollback')
    })(), /rollback/)
    assert.equal(repo.load({ seed: 'native' }).libraries.find(library => library.id === 1)?.name, 'Changed')
  } finally { database.close() }
})


it('keeps a retained default home reader bound to its original connection after a database switch', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-home-switch-'))
  try {
    const first = initDatabaseAtPath(path.join(directory, 'first.db'))
    first.prepare("UPDATE media_libraries SET name='First' WHERE id=1").run()
    const retained = createHomeDiscoveryRepo()
    assert.equal(retained.load({ seed: 'same' }).libraries[0].name, 'First')
    closeDatabase()
    const second = initDatabaseAtPath(path.join(directory, 'second.db'))
    second.prepare("UPDATE media_libraries SET name='Second' WHERE id=1").run()
    assert.equal(createHomeDiscoveryRepo().load({ seed: 'same' }).libraries[0].name, 'Second')
    assert.throws(() => retained.search({}), /not open|closed/)
  } finally { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) }
})
