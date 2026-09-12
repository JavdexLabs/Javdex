import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { normalizeActressName } from './actressNameNormalization'
import { migrateDatabase } from './migrations'
import { createMediaLibraryRootMigrationRepo } from './mediaLibraryRootMigrationRepo'
import { MediaLibraryRepoError } from './mediaLibraryRepo'
import { LEGACY_CLEANUP_WAITING_ERROR } from '@shared/legacyLibraryCleanup'

function createFixture(): Database.Database {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.function('normalize_actress_name', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? normalizeActressName(value) : null
  )
  migrateDatabase(database)
  database.exec(`
    INSERT INTO media_libraries (
      id, name, icon, color, position, status, is_default, revision
    ) VALUES
      (2, '源媒体库', 'folder', 'blue', 1, 'active', 0, 7),
      (3, '目标媒体库', 'hard-drive', 'green', 2, 'active', 0, 9);
    INSERT INTO media_library_configs (library_id) VALUES (2), (3);
    INSERT INTO media_library_scan_state (library_id) VALUES (2), (3);

    INSERT INTO media_library_roots (
      id, library_id, path, normalized_path, real_path, normalized_real_path,
      device_id, inode, position, state
    ) VALUES
      (11, 2, '/source/move', '/source/move', NULL, NULL, NULL, NULL, 0, 'active'),
      (12, 2, '/source/keep', '/source/keep', NULL, NULL, NULL, NULL, 1, 'active'),
      (21, 3, '/target', '/target', NULL, NULL, NULL, NULL, 0, 'active');

    INSERT INTO videos (id, code, title) VALUES
      (101, 'MOVE-101', 'shared target primary'),
      (102, 'MOVE-102', 'new target member');
    INSERT INTO library_video_memberships (
      library_id, video_id, added_at, updated_at, added_via, discovery_key
    ) VALUES
      (2, 101, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'scan', 101),
      (2, 102, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'scan', 102),
      (3, 101, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'shared', 201);

    INSERT INTO video_resources (
      id, library_id, video_id, root_id, kind, locator, resource_key,
      source_identity, is_primary, add_time
    ) VALUES
      (1001, 2, 101, 11, 'local', '/source/move/a.mp4',
       'local:/source/move/a.mp4', 'local:/source/move/a.mp4', 1,
       '2026-01-01T00:00:00.000Z'),
      (1002, 2, 101, 12, 'local', '/source/keep/a-alt.mp4',
       'local:/source/keep/a-alt.mp4', 'local:/source/keep/a-alt.mp4', 0,
       '2026-01-03T00:00:00.000Z'),
      (1003, 2, 102, 11, 'local', '/source/move/b.mp4',
       'local:/source/move/b.mp4', 'local:/source/move/b.mp4', 1,
       '2026-01-02T00:00:00.000Z'),
      (1004, 3, 101, NULL, 'web', 'https://target.test/101',
       'web:target-101', NULL, 1, '2026-02-01T00:00:00.000Z');

    INSERT INTO pending_scan_groups (
      id, library_id, normalized_code, revision, created_at, updated_at
    ) VALUES
      (201, 2, 'PENDING-X', 2, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
      (202, 3, 'PENDING-X', 4, '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z'),
      (203, 2, 'PENDING-Y', 1, '2026-03-03T00:00:00.000Z', '2026-03-03T00:00:00.000Z');
    INSERT INTO pending_scan_resources (
      id, library_id, group_id, root_id, file_path, normalized_path,
      source_kind, size_bytes
    ) VALUES
      (301, 2, 201, 11, '/source/move/pending-x.mp4',
       '/source/move/pending-x.mp4', 'local', 100),
      (302, 2, 201, 12, '/source/keep/pending-x-alt.mp4',
       '/source/keep/pending-x-alt.mp4', 'local', 200),
      (303, 2, 203, 11, '/source/move/pending-y.mp4',
       '/source/move/pending-y.mp4', 'local', 300),
      (304, 3, 202, 21, '/target/pending-x.mp4',
       '/target/pending-x.mp4', 'local', 400);

    INSERT INTO pending_resource_identities (
      id, library_id, root_id, file_path, normalized_path, source_kind,
      filename_code, nfo_code, size_bytes, file_mtime_ms, revision
    ) VALUES (
      401, 2, 11, '/source/move/identity.mp4', '/source/move/identity.mp4',
      'local', 'FILE-001', 'NFO-002', 500, 1000, 1
    );

    INSERT INTO library_scan_runs (
      id, library_id, config_revision, trigger, status, started_at, finished_at
    ) VALUES (
      'scan-source', 2, 1, 'manual', 'completed',
      '2026-04-01T00:00:00.000Z', '2026-04-01T00:01:00.000Z'
    );
    INSERT INTO library_unrecognized_files (
      library_id, root_id, file_path, normalized_path, reason, scan_run_id, last_seen_at
    ) VALUES (
      2, 11, '/source/move/unknown.mp4', '/source/move/unknown.mp4',
      'unrecognized_code', 'scan-source', '2026-04-01T00:01:00.000Z'
    );
  `)
  return database
}

function scalar(database: Database.Database, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { value: number }).value
}

function hasCode(code: MediaLibraryRepoError['code']): (error: unknown) => boolean {
  return (error) => error instanceof MediaLibraryRepoError && error.code === code
}

describe('media-library root migration repo', () => {
  it('previews and atomically migrates root-owned state without touching disk or global videos', () => {
    const database = createFixture()
    try {
      const repo = createMediaLibraryRootMigrationRepo(database, {
        isLocalAccessible: () => true
      })
      const preview = repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 })
      assert.deepEqual(
        {
          sourceRevision: preview.sourceRevision,
          targetRevision: preview.targetRevision,
          resourceCount: preview.resourceCount,
          videoCount: preview.videoCount,
          targetMembershipsToCreate: preview.targetMembershipsToCreate,
          sourceMembershipsBecomingResourceLess:
            preview.sourceMembershipsBecomingResourceLess,
          pendingScanGroupCount: preview.pendingScanGroupCount,
          pendingScanResourceCount: preview.pendingScanResourceCount,
          targetPendingGroupsToMerge: preview.targetPendingGroupsToMerge,
          unrecognizedFileCount: preview.unrecognizedFileCount,
          sourcePrimaryResourcesToPromote: preview.sourcePrimaryResourcesToPromote,
          sourceFilesPreserved: preview.sourceFilesPreserved
        },
        {
          sourceRevision: 7,
          targetRevision: 9,
          resourceCount: 2,
          videoCount: 2,
          targetMembershipsToCreate: 1,
          sourceMembershipsBecomingResourceLess: 1,
          pendingScanGroupCount: 3,
          pendingScanResourceCount: 3,
          targetPendingGroupsToMerge: 1,
          unrecognizedFileCount: 1,
          sourcePrimaryResourcesToPromote: 1,
          sourceFilesPreserved: true
        }
      )

      const result = repo.migrate({
        sourceLibraryId: 2,
        targetLibraryId: 3,
        rootId: 11,
        expectedSourceRevision: preview.sourceRevision,
        expectedTargetRevision: preview.targetRevision,
        expectedImpactRevision: preview.impactRevision
      })

      assert.equal(result.previousRootId, 11)
      assert.equal(result.targetRoot.libraryId, 3)
      assert.equal(result.targetRoot.path, '/source/move')
      assert.equal(result.targetRoot.state, 'active')
      assert.equal(result.movedResourceCount, 2)
      assert.equal(result.createdMembershipCount, 1)
      assert.equal(result.movedPendingScanResourceCount, 3)
      assert.deepEqual(
        database
          .prepare(
            `SELECT library_id, root_id, revision
               FROM pending_resource_identities WHERE id = 401`
          )
          .get(),
        { library_id: 3, root_id: result.targetRoot.id, revision: 2 }
      )
      assert.equal(result.movedUnrecognizedFileCount, 1)
      assert.deepEqual(result.promotedSourceResourceIds, [1002])
      assert.equal(result.sourceFilesPreserved, true)

      assert.equal(
        scalar(database, 'SELECT COUNT(*) AS value FROM media_library_roots WHERE id = 11'),
        0
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM video_resources
            WHERE library_id = 3 AND root_id = ?`,
          result.targetRoot.id
        ),
        2
      )
      assert.equal(
        scalar(
          database,
          `SELECT is_primary AS value FROM video_resources WHERE id = 1001`
        ),
        0,
        'a moved primary is demoted when the target already has one'
      )
      assert.equal(
        scalar(database, 'SELECT is_primary AS value FROM video_resources WHERE id = 1003'),
        1,
        'a moved primary remains primary when the target has none'
      )
      assert.equal(
        scalar(database, 'SELECT is_primary AS value FROM video_resources WHERE id = 1002'),
        1,
        'the source promotes its deterministic remaining resource'
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM library_video_memberships
            WHERE library_id = 3 AND video_id = 102`
        ),
        1
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM library_video_memberships
            WHERE library_id = 2 AND video_id = 102`
        ),
        1,
        'root migration preserves explicit source membership even when it becomes resource-less'
      )

      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value
             FROM pending_scan_resources resource
             JOIN pending_scan_groups scan_group
               ON scan_group.id = resource.group_id
              AND scan_group.library_id = resource.library_id
            WHERE resource.library_id = 3
              AND scan_group.normalized_code = 'PENDING-X'`
        ),
        2,
        'same-code pending resources merge into the target group'
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM pending_scan_groups
            WHERE library_id = 2 AND normalized_code = 'PENDING-Y'`
        ),
        0,
        'an emptied source pending group is removed'
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM pending_scan_groups
            WHERE library_id = 3 AND normalized_code = 'PENDING-Y'`
        ),
        1,
        'a target pending group is created when no merge target exists'
      )
      const unrecognized = database
        .prepare(
          `SELECT file.library_id, file.root_id, run.library_id AS run_library_id
             FROM library_unrecognized_files file
             JOIN library_scan_runs run ON run.id = file.scan_run_id
            WHERE file.normalized_path = '/source/move/unknown.mp4'`
        )
        .get() as { library_id: number; root_id: number; run_library_id: number }
      assert.deepEqual(unrecognized, {
        library_id: 3,
        root_id: result.targetRoot.id,
        run_library_id: 3
      })
      assert.deepEqual(
        database
          .prepare('SELECT id, revision FROM media_libraries WHERE id IN (2, 3) ORDER BY id')
          .all(),
        [
          { id: 2, revision: 8 },
          { id: 3, revision: 10 }
        ]
      )
      assert.equal(scalar(database, 'SELECT COUNT(*) AS value FROM videos'), 2)
    } finally {
      database.close()
    }
  })

  it('uses the shared availability-aware promotion rule within the source library and video', () => {
    const database = createFixture()
    try {
      database.exec(`
        INSERT INTO videos (id, code, title) VALUES (103, 'KEEP-103', 'scope guard');
        INSERT INTO library_video_memberships (
          library_id, video_id, added_at, updated_at, added_via, discovery_key
        ) VALUES (2, 103, '2026-01-01', '2026-01-01', 'scan', 103);
        INSERT INTO video_resources (
          id, library_id, video_id, root_id, kind, locator, resource_key,
          source_identity, is_primary, add_time
        ) VALUES
          (1005, 2, 101, NULL, 'web', 'https://source.test/101',
           'web:source-101', NULL, 0, '2026-01-02T00:00:00.000Z'),
          (1006, 2, 101, NULL, 'ed2k', 'ed2k://source-101',
           'ed2k:source-101', NULL, 0, '2026-01-02T00:00:00.000Z'),
          (1007, 2, 101, NULL, 'magnet', 'magnet:?xt=urn:btih:later',
           'magnet:source-later', NULL, 0, '2026-01-04T00:00:00.000Z'),
          (1008, 2, 101, NULL, 'magnet', 'magnet:?xt=urn:btih:first',
           'magnet:source-first', NULL, 0, '2026-01-03T00:00:00.000Z'),
          (1009, 2, 101, NULL, 'magnet', 'magnet:?xt=urn:btih:second',
           'magnet:source-second', NULL, 0, '2026-01-03T00:00:00.000Z'),
          (1010, 2, 103, NULL, 'direct', 'https://source.test/103',
           'direct:other-video', NULL, 1, '2025-01-01T00:00:00.000Z');
      `)
      const repo = createMediaLibraryRootMigrationRepo(database, {
        isLocalAccessible: () => false
      })
      const preview = repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 })
      const result = repo.migrate({
        sourceLibraryId: 2,
        targetLibraryId: 3,
        rootId: 11,
        expectedSourceRevision: preview.sourceRevision,
        expectedTargetRevision: preview.targetRevision,
        expectedImpactRevision: preview.impactRevision
      })

      assert.deepEqual(result.promotedSourceResourceIds, [1008])
      assert.deepEqual(
        database
          .prepare(
            `SELECT id, library_id, video_id, is_primary
               FROM video_resources
              WHERE id IN (1002, 1004, 1005, 1006, 1007, 1008, 1009, 1010)
              ORDER BY id`
          )
          .all(),
        [
          { id: 1002, library_id: 2, video_id: 101, is_primary: 0 },
          { id: 1004, library_id: 3, video_id: 101, is_primary: 1 },
          { id: 1005, library_id: 2, video_id: 101, is_primary: 0 },
          { id: 1006, library_id: 2, video_id: 101, is_primary: 0 },
          { id: 1007, library_id: 2, video_id: 101, is_primary: 0 },
          { id: 1008, library_id: 2, video_id: 101, is_primary: 1 },
          { id: 1009, library_id: 2, video_id: 101, is_primary: 0 },
          { id: 1010, library_id: 2, video_id: 103, is_primary: 1 }
        ]
      )
    } finally {
      database.close()
    }
  })

  it('rejects stale previews and rolls the entire migration back', () => {
    const database = createFixture()
    try {
      const repo = createMediaLibraryRootMigrationRepo(database, {
        isLocalAccessible: () => true
      })
      const preview = repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 })
      assert.throws(
        () =>
          repo.migrate({
            sourceLibraryId: 2,
            targetLibraryId: 3,
            rootId: 11,
            expectedSourceRevision: 6,
            expectedTargetRevision: 9,
            expectedImpactRevision: preview.impactRevision
          }),
        /preview|revision|预览已过期/i
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM media_library_roots
            WHERE id = 11 AND library_id = 2 AND state = 'active'`
        ),
        1
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM video_resources
            WHERE library_id = 2 AND root_id = 11`
        ),
        2
      )
      assert.deepEqual(
        database
          .prepare('SELECT id, revision FROM media_libraries WHERE id IN (2, 3) ORDER BY id')
          .all(),
        [
          { id: 2, revision: 7 },
          { id: 3, revision: 9 }
        ]
      )

      assert.throws(
        () =>
          repo.migrate({
            sourceLibraryId: 2,
            targetLibraryId: 3,
            rootId: 11,
            expectedSourceRevision: 7,
            expectedTargetRevision: 8,
            expectedImpactRevision: preview.impactRevision
          }),
        /preview|revision|预览已过期/i
      )
      assert.deepEqual(
        database
          .prepare('SELECT id, revision FROM media_libraries WHERE id IN (2, 3) ORDER BY id')
          .all(),
        [
          { id: 2, revision: 7 },
          { id: 3, revision: 9 }
        ]
      )
    } finally {
      database.close()
    }
  })

  it('rejects resource or pending changes made after preview even when library revisions are unchanged', () => {
    const database = createFixture()
    try {
      const repo = createMediaLibraryRootMigrationRepo(database, {
        isLocalAccessible: () => true
      })
      const preview = repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 })
      database.exec(`
        INSERT INTO pending_scan_groups (id, library_id, normalized_code)
        VALUES (2999, 2, 'LATE-001');
        INSERT INTO pending_scan_resources (
          id, library_id, group_id, root_id, file_path, normalized_path
        ) VALUES (3999, 2, 2999, 11, '/source/move/LATE-001.mp4', '/source/move/LATE-001.mp4');
      `)

      assert.throws(
        () =>
          repo.migrate({
            sourceLibraryId: 2,
            targetLibraryId: 3,
            rootId: 11,
            expectedSourceRevision: preview.sourceRevision,
            expectedTargetRevision: preview.targetRevision,
            expectedImpactRevision: preview.impactRevision
          }),
        /preview|revision|预览已过期/i
      )
      assert.equal(
        scalar(
          database,
          `SELECT
             (SELECT COUNT(*) FROM pending_scan_resources
               WHERE library_id = 2 AND root_id = 11) +
             (SELECT COUNT(*) FROM pending_resource_identities
               WHERE library_id = 2 AND root_id = 11) AS value`
        ),
        preview.pendingScanResourceCount + 1
      )
      assert.equal(
        scalar(database, 'SELECT COUNT(*) AS value FROM media_library_roots WHERE id = 11'),
        1
      )
    } finally {
      database.close()
    }
  })

  it('moves terminal cleanup history to the replacement root during preview-confirmed migration', () => {
    const database = createFixture()
    try {
      database.exec(`
        INSERT INTO library_root_cleanup_jobs (
          id, library_id, root_id, state, requested_at, completed_at,
          last_error, root_path, normalized_root_path, config_revision
        ) VALUES
          ('cleanup-completed', 2, 11, 'completed',
           '2026-05-01T00:00:00.000Z', '2026-05-01T00:01:00.000Z', NULL,
           '/source/move', '/source/move', 1),
          ('cleanup-failed', 2, 11, 'failed',
           '2026-05-02T00:00:00.000Z', '2026-05-02T00:01:00.000Z', 'old failure',
           '/source/move', '/source/move', 1),
          ('cleanup-cancelled', 2, 11, 'cancelled',
           '2026-05-03T00:00:00.000Z', '2026-05-03T00:01:00.000Z', NULL,
           '/source/move', '/source/move', 1);
      `)
      const repo = createMediaLibraryRootMigrationRepo(database, {
        isLocalAccessible: () => true
      })
      const preview = repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 })
      const result = repo.migrate({
        sourceLibraryId: 2,
        targetLibraryId: 3,
        rootId: 11,
        expectedSourceRevision: preview.sourceRevision,
        expectedTargetRevision: preview.targetRevision,
        expectedImpactRevision: preview.impactRevision
      })

      assert.deepEqual(
        database
          .prepare(
            `SELECT id, library_id, root_id, state
               FROM library_root_cleanup_jobs
              ORDER BY id`
          )
          .all(),
        [
          {
            id: 'cleanup-cancelled',
            library_id: 3,
            root_id: result.targetRoot.id,
            state: 'cancelled'
          },
          {
            id: 'cleanup-completed',
            library_id: 3,
            root_id: result.targetRoot.id,
            state: 'completed'
          },
          {
            id: 'cleanup-failed',
            library_id: 3,
            root_id: result.targetRoot.id,
            state: 'failed'
          }
        ]
      )
    } finally {
      database.close()
    }
  })

  it('rejects a stale migration preview when terminal cleanup history changes', () => {
    const database = createFixture()
    try {
      database.exec(`
        INSERT INTO library_root_cleanup_jobs (
          id, library_id, root_id, state, requested_at, completed_at,
          root_path, normalized_root_path, config_revision
        ) VALUES (
          'cleanup-history', 2, 11, 'completed',
          '2026-05-01T00:00:00.000Z', '2026-05-01T00:01:00.000Z',
          '/source/move', '/source/move', 1
        );
      `)
      const repo = createMediaLibraryRootMigrationRepo(database, {
        isLocalAccessible: () => true
      })
      const preview = repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 })
      database
        .prepare(
          `UPDATE library_root_cleanup_jobs
              SET state = 'failed', last_error = 'late failure'
            WHERE id = 'cleanup-history'`
        )
        .run()

      assert.throws(
        () =>
          repo.migrate({
            sourceLibraryId: 2,
            targetLibraryId: 3,
            rootId: 11,
            expectedSourceRevision: preview.sourceRevision,
            expectedTargetRevision: preview.targetRevision,
            expectedImpactRevision: preview.impactRevision
          }),
        hasCode('REVISION_CONFLICT')
      )
      assert.equal(
        scalar(database, 'SELECT COUNT(*) AS value FROM media_library_roots WHERE id = 11'),
        1
      )
    } finally {
      database.close()
    }
  })

  it('rolls back every dataset when a late migration write fails', () => {
    const database = createFixture()
    try {
      database.exec(`
        CREATE TRIGGER fail_root_migration_unrecognized
        BEFORE UPDATE OF library_id ON library_unrecognized_files
        WHEN OLD.library_id = 2 AND OLD.root_id = 11
        BEGIN
          SELECT RAISE(ABORT, 'forced late migration failure');
        END;
      `)
      const repo = createMediaLibraryRootMigrationRepo(database, {
        isLocalAccessible: () => true
      })
      const preview = repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 })
      assert.throws(
        () =>
          repo.migrate({
            sourceLibraryId: 2,
            targetLibraryId: 3,
            rootId: 11,
            expectedSourceRevision: preview.sourceRevision,
            expectedTargetRevision: preview.targetRevision,
            expectedImpactRevision: preview.impactRevision
          }),
        /forced late migration failure/
      )

      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM media_library_roots
            WHERE id = 11 AND library_id = 2 AND state = 'active'`
        ),
        1,
        'the temporarily disabled source root is restored'
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM media_library_roots
            WHERE library_id = 3 AND normalized_path = '/source/move'`
        ),
        0,
        'the target root insert is rolled back'
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM video_resources
            WHERE library_id = 2 AND root_id = 11`
        ),
        2
      )
      assert.equal(
        scalar(database, 'SELECT is_primary AS value FROM video_resources WHERE id = 1001'),
        1,
        'primary-resource changes are rolled back'
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM library_video_memberships
            WHERE library_id = 3 AND video_id = 102`
        ),
        0,
        'new target memberships are rolled back'
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM pending_scan_resources
            WHERE library_id = 2 AND root_id = 11`
        ),
        2,
        'pending resources moved before the failure are rolled back'
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM library_scan_runs
            WHERE id LIKE 'root-migration:%'`
        ),
        0,
        'the synthetic ownership run is rolled back'
      )
      assert.deepEqual(
        database
          .prepare('SELECT id, revision FROM media_libraries WHERE id IN (2, 3) ORDER BY id')
          .all(),
        [
          { id: 2, revision: 7 },
          { id: 3, revision: 9 }
        ]
      )
    } finally {
      database.close()
    }
  })

  it('fails closed while either library has an active scan or cleanup job', () => {
    const database = createFixture()
    try {
      database
        .prepare(
          `INSERT INTO library_scan_runs (
             id, library_id, config_revision, trigger, status, started_at
           ) VALUES ('target-running', 3, 1, 'manual', 'running', CURRENT_TIMESTAMP)`
        )
        .run()
      const repo = createMediaLibraryRootMigrationRepo(database, {
        isLocalAccessible: () => true
      })
      assert.throws(
        () => repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 }),
        /扫描.*清理|任务/
      )
      database.prepare("UPDATE library_scan_runs SET status = 'cancelled' WHERE id = 'target-running'").run()
      database
        .prepare(
          `INSERT INTO library_root_cleanup_jobs (
             id, library_id, root_id, state, requested_at, root_path,
             normalized_root_path, config_revision
           ) VALUES ('cleanup-source', 2, 12, 'pending', CURRENT_TIMESTAMP,
                     '/source/keep', '/source/keep', 1)`
        )
        .run()
      assert.throws(
        () => repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 }),
        /扫描.*清理|任务/
      )
    } finally {
      database.close()
    }
  })

  it('treats a failed legacy cleanup waiting marker as active work in preview and commit', () => {
    const database = createFixture()
    try {
      database.prepare("UPDATE media_library_roots SET state = 'disabled' WHERE id = 11").run()
      const repo = createMediaLibraryRootMigrationRepo(database, {
        isLocalAccessible: () => true
      })
      const preview = repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 })
      database
        .prepare(
          `INSERT INTO library_root_cleanup_jobs (
             id, library_id, root_id, state, requested_at, last_error,
             root_path, normalized_root_path, config_revision
           ) VALUES (
             'legacy-settings-cleanup:2:11', 2, 11, 'failed', CURRENT_TIMESTAMP, ?,
             '/source/move', '/source/move', 1
           )`
        )
        .run(LEGACY_CLEANUP_WAITING_ERROR)

      assert.throws(
        () => repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 }),
        hasCode('LIBRARY_BUSY')
      )
      assert.throws(
        () =>
          repo.migrate({
            sourceLibraryId: 2,
            targetLibraryId: 3,
            rootId: 11,
            expectedSourceRevision: preview.sourceRevision,
            expectedTargetRevision: preview.targetRevision,
            expectedImpactRevision: preview.impactRevision
          }),
        hasCode('LIBRARY_BUSY')
      )
      assert.deepEqual(
        database
          .prepare(
            `SELECT library_id, root_id, state, last_error
               FROM library_root_cleanup_jobs
              WHERE id = 'legacy-settings-cleanup:2:11'`
          )
          .get(),
        {
          library_id: 2,
          root_id: 11,
          state: 'failed',
          last_error: LEGACY_CLEANUP_WAITING_ERROR
        }
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM video_resources
            WHERE library_id = 2 AND root_id = 11`
        ),
        2
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM media_library_roots
            WHERE library_id = 3 AND normalized_path = '/source/move'`
        ),
        0
      )
    } finally {
      database.close()
    }
  })

  it('rejects target resource conflicts before mutation', () => {
    const database = createFixture()
    try {
      database.exec(`
        INSERT INTO library_video_memberships (
          library_id, video_id, added_at, updated_at, added_via, discovery_key
        ) VALUES (3, 102, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'shared', 202);
        INSERT INTO video_resources (
          library_id, video_id, root_id, kind, locator, resource_key,
          source_identity, is_primary
        ) VALUES (
          3, 102, 21, 'local', '/source/move/b.mp4',
          'local:/source/move/b.mp4', 'local:/source/move/b.mp4', 1
        );
      `)
      const repo = createMediaLibraryRootMigrationRepo(database, {
        isLocalAccessible: () => true
      })
      assert.throws(
        () => repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 }),
        /等价.*资源|已存在/
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM media_library_roots
            WHERE id = 11 AND library_id = 2`
        ),
        1
      )
    } finally {
      database.close()
    }
  })

  it('rejects target unrecognized-file conflicts before mutation', () => {
    const database = createFixture()
    try {
      database.exec(`
        INSERT INTO library_scan_runs (
          id, library_id, config_revision, trigger, status, started_at, finished_at
        ) VALUES (
          'scan-target', 3, 1, 'manual', 'completed',
          '2026-04-02T00:00:00.000Z', '2026-04-02T00:01:00.000Z'
        );
        INSERT INTO library_unrecognized_files (
          library_id, root_id, file_path, normalized_path, reason, scan_run_id, last_seen_at
        ) VALUES (
          3, 21, '/source/move/unknown.mp4', '/source/move/unknown.mp4',
          'unrecognized_code', 'scan-target', '2026-04-02T00:01:00.000Z'
        );
      `)
      const repo = createMediaLibraryRootMigrationRepo(database, {
        isLocalAccessible: () => true
      })
      assert.throws(
        () => repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 }),
        /未识别文件|已存在/
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM media_library_roots
            WHERE id = 11 AND library_id = 2`
        ),
        1
      )
    } finally {
      database.close()
    }
  })

  it('rejects target pending-scan path conflicts during preview', () => {
    const database = createFixture()
    try {
      database.exec(`
        INSERT INTO pending_scan_resources (
          id, library_id, group_id, root_id, file_path, normalized_path,
          source_kind, size_bytes
        ) VALUES (
          305, 3, 202, 21, '/target/duplicate-pending-x.mp4',
          '/source/move/pending-x.mp4', 'local', 500
        );
      `)
      const repo = createMediaLibraryRootMigrationRepo(database, {
        isLocalAccessible: () => true
      })

      assert.throws(
        () => repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 }),
        hasCode('VALIDATION_FAILED')
      )
      assert.equal(
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM media_library_roots
            WHERE id = 11 AND library_id = 2`
        ),
        1
      )
    } finally {
      database.close()
    }
  })

  it('moves a disabled root without enabling it in the target library', () => {
    const database = createFixture()
    try {
      database.prepare("UPDATE media_library_roots SET state = 'disabled' WHERE id = 11").run()
      const repo = createMediaLibraryRootMigrationRepo(database, {
        isLocalAccessible: () => true
      })
      const preview = repo.preview({ sourceLibraryId: 2, targetLibraryId: 3, rootId: 11 })
      assert.equal(preview.rootState, 'disabled')
      const result = repo.migrate({
        sourceLibraryId: 2,
        targetLibraryId: 3,
        rootId: 11,
        expectedSourceRevision: 7,
        expectedTargetRevision: 9,
        expectedImpactRevision: preview.impactRevision
      })
      assert.equal(result.targetRoot.state, 'disabled')
    } finally {
      database.close()
    }
  })
})
