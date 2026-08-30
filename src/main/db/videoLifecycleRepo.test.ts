import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateDatabase } from './migrations'
import { createVideoLifecycleRepo } from './videoLifecycleRepo'

const accessibleLocalFiles = { isLocalAccessible: () => true }

function fixture(): Database.Database {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  migrateDatabase(database)
  database.exec(`
    INSERT INTO media_libraries (id, name) VALUES (2, 'B');
    INSERT INTO media_library_configs (library_id) VALUES (2);
    INSERT INTO videos (id, code) VALUES (91, 'ML-091');
    INSERT INTO library_video_memberships (
      library_id, video_id, added_at, updated_at, added_via, discovery_key
    ) VALUES
      (1, 91, '2026-01-01', '2026-01-01', 'scan', 1),
      (2, 91, '2026-01-02', '2026-01-02', 'shared', 2);
    INSERT INTO video_resources (
      id, library_id, video_id, kind, locator, resource_key, source_identity, is_primary
    ) VALUES
      (911, 1, 91, 'local', '/a/ML-091.mp4', 'local:/a/ML-091.mp4', 'local:/a/ML-091.mp4', 1),
      (912, 1, 91, 'web', 'https://a.example/91', 'web:a-91', NULL, 0),
      (921, 2, 91, 'direct', 'https://b.example/91', 'direct:b-91', NULL, 1);
  `)
  return database
}

describe('video lifecycle repo', () => {
  it('removes only one library membership and replays the same operation idempotently', () => {
    const database = fixture()
    try {
      const lifecycle = createVideoLifecycleRepo(database, accessibleLocalFiles)
      const preview = lifecycle.previewRemoveFromLibrary(1, 91)
      assert.deepEqual(preview.resourceIds, [911, 912])
      assert.deepEqual(preview.remainingLibraryIds, [2])
      assert.equal(preview.removesCanonicalVideo, false)
      const input = {
        libraryId: 1,
        videoId: 91,
        operationId: 'remove-a-91',
        expectedRevision: preview.revision
      }
      const first = lifecycle.removeFromLibrary(input)
      assert.deepEqual(lifecycle.removeFromLibrary(input), first)
      assert.equal(
        (database.prepare('SELECT COUNT(*) AS count FROM videos WHERE id = 91').get() as {
          count: number
        }).count,
        1
      )
      assert.deepEqual(
        database
          .prepare('SELECT library_id, id FROM video_resources WHERE video_id = 91')
          .all(),
        [{ library_id: 2, id: 921 }]
      )
    } finally {
      database.close()
    }
  })

  it('moves one external resource and keeps each library primary isolated', () => {
    const database = fixture()
    try {
      const lifecycle = createVideoLifecycleRepo(database, accessibleLocalFiles)
      const preview = lifecycle.previewMoveResource(1, 2, 912)
      const result = lifecycle.moveResource({
        sourceLibraryId: 1,
        targetLibraryId: 2,
        resourceId: 912,
        operationId: 'move-web-91',
        expectedRevision: preview.revision
      })
      assert.equal(result.promotedResourceId, null)
      assert.deepEqual(
        database
          .prepare(
            `SELECT id, library_id, root_id, is_primary FROM video_resources
             WHERE video_id = 91 ORDER BY id`
          )
          .all(),
        [
          { id: 911, library_id: 1, root_id: null, is_primary: 1 },
          { id: 912, library_id: 2, root_id: null, is_primary: 0 },
          { id: 921, library_id: 2, root_id: null, is_primary: 1 }
        ]
      )
    } finally {
      database.close()
    }
  })

  it('promotes an available source fallback by kind and add time without crossing ownership scope', () => {
    const database = fixture()
    try {
      database.exec(`
        INSERT INTO videos (id, code) VALUES (92, 'ML-092'), (93, 'ML-093');
        INSERT INTO library_video_memberships (
          library_id, video_id, added_at, updated_at, added_via, discovery_key
        ) VALUES
          (1, 92, '2026-02-01', '2026-02-01', 'scan', 92),
          (2, 92, '2026-02-01', '2026-02-01', 'shared', 192),
          (1, 93, '2026-02-01', '2026-02-01', 'scan', 93);
        INSERT INTO video_resources (
          id, library_id, video_id, kind, locator, resource_key,
          source_identity, is_primary, add_time
        ) VALUES
          (929, 1, 92, 'direct', 'https://source.test/move', 'direct:move', NULL, 1,
           '2026-02-01T00:00:00.000Z'),
          (930, 1, 92, 'local', '/missing/ML-092.mp4', 'local:missing-92',
           'local:missing-92', 0, '2026-01-01T00:00:00.000Z'),
          (931, 1, 92, 'web', 'https://source.test/web', 'web:source-92', NULL, 0,
           '2026-01-02T00:00:00.000Z'),
          (932, 1, 92, 'ed2k', 'ed2k://source-92', 'ed2k:source-92', NULL, 0,
           '2026-01-02T00:00:00.000Z'),
          (933, 1, 92, 'magnet', 'magnet:?xt=urn:btih:later', 'magnet:later', NULL, 0,
           '2026-01-04T00:00:00.000Z'),
          (934, 1, 92, 'magnet', 'magnet:?xt=urn:btih:first', 'magnet:first', NULL, 0,
           '2026-01-03T00:00:00.000Z'),
          (935, 1, 92, 'magnet', 'magnet:?xt=urn:btih:second', 'magnet:second', NULL, 0,
           '2026-01-03T00:00:00.000Z'),
          (936, 2, 92, 'direct', 'https://target.test/92', 'direct:target-92', NULL, 1,
           '2025-01-01T00:00:00.000Z'),
          (937, 1, 93, 'direct', 'https://source.test/93', 'direct:other-video', NULL, 1,
           '2025-01-01T00:00:00.000Z');
      `)
      const lifecycle = createVideoLifecycleRepo(database, {
        isLocalAccessible: () => false
      })
      const preview = lifecycle.previewMoveResource(1, 2, 929)
      const result = lifecycle.moveResource({
        sourceLibraryId: 1,
        targetLibraryId: 2,
        resourceId: 929,
        operationId: 'move-primary-92',
        expectedRevision: preview.revision
      })

      assert.equal(result.promotedResourceId, 934)
      assert.deepEqual(
        database
          .prepare(
            `SELECT id, library_id, video_id, is_primary
               FROM video_resources
              WHERE id IN (929, 930, 931, 932, 933, 934, 935, 936, 937)
              ORDER BY id`
          )
          .all(),
        [
          { id: 929, library_id: 2, video_id: 92, is_primary: 0 },
          { id: 930, library_id: 1, video_id: 92, is_primary: 0 },
          { id: 931, library_id: 1, video_id: 92, is_primary: 0 },
          { id: 932, library_id: 1, video_id: 92, is_primary: 0 },
          { id: 933, library_id: 1, video_id: 92, is_primary: 0 },
          { id: 934, library_id: 1, video_id: 92, is_primary: 1 },
          { id: 935, library_id: 1, video_id: 92, is_primary: 0 },
          { id: 936, library_id: 2, video_id: 92, is_primary: 1 },
          { id: 937, library_id: 1, video_id: 93, is_primary: 1 }
        ]
      )
    } finally {
      database.close()
    }
  })

  it('rejects moving a local or STRM-managed source without transferring its root', () => {
    const database = fixture()
    try {
      const lifecycle = createVideoLifecycleRepo(database, accessibleLocalFiles)
      assert.throws(() => lifecycle.previewMoveResource(1, 2, 911), /根目录迁移/)
    } finally {
      database.close()
    }
  })

  it('treats archived source libraries as read-only', () => {
    const database = fixture()
    try {
      const lifecycle = createVideoLifecycleRepo(database, accessibleLocalFiles)
      database.prepare("UPDATE media_libraries SET status = 'archived' WHERE id = 1").run()

      assert.throws(() => lifecycle.previewRemoveFromLibrary(1, 91), /已归档媒体库/)
      assert.throws(() => lifecycle.previewMoveResource(1, 2, 912), /已归档媒体库/)
    } finally {
      database.close()
    }
  })

  it('rejects a stale preview and globally deletes only after a fresh explicit preview', () => {
    const database = fixture()
    try {
      const lifecycle = createVideoLifecycleRepo(database, accessibleLocalFiles)
      const stale = lifecycle.previewDeleteGlobally(91)
      database
        .prepare(
          "UPDATE library_video_memberships SET updated_at = '2026-02-01' WHERE library_id = 2 AND video_id = 91"
        )
        .run()
      assert.throws(
        () =>
          lifecycle.deleteGlobally({
            videoId: 91,
            operationId: 'delete-stale',
            expectedRevision: stale.revision
          }),
        /预览已过期/
      )
      database.exec(`
        UPDATE videos
        SET cover_path = 'covers/ML-091.jpg', poster_path = 'samples/ML-091-poster.jpg'
        WHERE id = 91;
        INSERT INTO playlists (id, name, created_at) VALUES (10, '稍后观看', '2026-01-01');
        INSERT INTO playlist_video (playlist_id, video_id, position, added_at)
        VALUES (10, 91, 2, '2026-02-02');
        INSERT INTO video_assets (
          id, video_id, type, position, remote_url, local_path, is_primary, created_at
        ) VALUES (
          71, 91, 'sample', 0, 'https://example.com/sample.jpg',
          'samples/ML-091-poster.jpg', 1, '2026-02-02'
        );
        INSERT INTO pending_video_scrapes (
          id, video_id, revision, selected_fields_json, applicable_fields_json,
          update_mode, request_json, warnings_json, created_at, updated_at
        ) VALUES (
          81, 91, 3, '[]', '[]', 'replace', '{}', '[]',
          '2026-02-02', '2026-02-02'
        );
        INSERT INTO pending_video_scrape_sources (
          id, pending_scrape_id, position, plugin_name, plugin_source,
          plugin_config_json, source_name, selected_fields_json
        ) VALUES (82, 81, 0, 'test', 'builtin', '{}', 'test', '[]');
        INSERT INTO pending_video_scrape_candidates (
          id, source_id, position, result_json
        ) VALUES (83, 82, 0, '{}');
        INSERT INTO pending_video_scrape_resources (
          id, candidate_id, field, position, staged_path
        ) VALUES (84, 83, 'cover', 0, 'video-scrape/pending/cover.jpg');
        INSERT INTO agent_metadata_drafts (
          id, entity_kind, entity_id, status, revision, requested_url, display_url,
          payload_json, warnings_json, created_at, updated_at
        ) VALUES (
          'draft-91', 'video', 91, 'ready', 4, 'https://example.com/91',
          'example.com / 91', '{}', '[]', '2026-02-02', '2026-02-02'
        );
        INSERT INTO agent_metadata_draft_resources (
          id, draft_id, field, position, staged_path, size_bytes, sha256
        ) VALUES (
          85, 'draft-91', 'samples', 0, 'video-scrape/agent/sample.jpg', 12, 'abc'
        );
      `)
      const fresh = lifecycle.previewDeleteGlobally(91)
      assert.equal(fresh.removesCanonicalVideo, true)
      assert.equal(fresh.sourceFilesPreserved, false)
      assert.deepEqual(
        fresh.libraries.map((library) => [library.libraryId, library.name, library.resourceCount]),
        [
          [1, '默认媒体库', 2],
          [2, 'B', 1]
        ]
      )
      assert.deepEqual(fresh.playlists, [{ playlistId: 10, name: '稍后观看' }])
      assert.deepEqual(
        fresh.mediaAssets.map((asset) => [asset.assetId, asset.type, asset.localPath]),
        [
          [null, 'cover', 'covers/ML-091.jpg'],
          [71, 'sample', 'samples/ML-091-poster.jpg']
        ]
      )
      assert.equal(fresh.pendingScrapeCount, 1)
      assert.equal(fresh.pendingAgentDraftCount, 1)
      assert.equal(fresh.pendingStagingAssetCount, 2)
      assert.deepEqual(fresh.sourcePaths, ['/a/ML-091.mp4'])

      const result = lifecycle.deleteGlobally({
        videoId: 91,
        operationId: 'delete-fresh',
        expectedRevision: fresh.revision
      })
      assert.deepEqual(result.obsoleteAssetPaths, [
        'covers/ML-091.jpg',
        'samples/ML-091-poster.jpg'
      ])
      assert.deepEqual(result.pendingStagingPaths, [
        'video-scrape/pending/cover.jpg',
        'video-scrape/agent/sample.jpg'
      ])
      assert.deepEqual(
        lifecycle.deleteGlobally({
          videoId: 91,
          operationId: 'delete-fresh',
          expectedRevision: fresh.revision
        }),
        result
      )
      assert.equal(database.prepare('SELECT 1 FROM videos WHERE id = 91').get(), undefined)
      assert.equal(
        database.prepare("SELECT 1 FROM agent_metadata_drafts WHERE id = 'draft-91'").get(),
        undefined
      )
    } finally {
      database.close()
    }
  })

  it('invalidates a global-delete preview when any displayed relationship changes', () => {
    const database = fixture()
    try {
      const lifecycle = createVideoLifecycleRepo(database, accessibleLocalFiles)
      database.exec(`
        INSERT INTO playlists (id, name, created_at) VALUES (10, '清单 A', '2026-01-01');
        INSERT INTO playlist_video (playlist_id, video_id, position, added_at)
        VALUES (10, 91, 0, '2026-01-01');
        INSERT INTO video_assets (id, video_id, type, position, local_path)
        VALUES (71, 91, 'sample', 0, 'samples/a.jpg');
      `)
      const initial = lifecycle.previewDeleteGlobally(91)

      database.prepare("UPDATE playlists SET name = '清单 B' WHERE id = 10").run()
      const playlistChanged = lifecycle.previewDeleteGlobally(91)
      assert.notEqual(playlistChanged.revision, initial.revision)

      database.prepare("UPDATE video_assets SET local_path = 'samples/b.jpg' WHERE id = 71").run()
      const assetChanged = lifecycle.previewDeleteGlobally(91)
      assert.notEqual(assetChanged.revision, playlistChanged.revision)

      database.prepare("UPDATE video_resources SET display_name = '新名称' WHERE id = 911").run()
      const resourceChanged = lifecycle.previewDeleteGlobally(91)
      assert.notEqual(resourceChanged.revision, assetChanged.revision)

      database.exec(`
        INSERT INTO pending_video_scrapes (
          id, video_id, revision, selected_fields_json, applicable_fields_json,
          update_mode, request_json, warnings_json, created_at, updated_at
        ) VALUES (
          81, 91, 1, '[]', '[]', 'replace', '{}', '[]',
          '2026-01-01', '2026-01-01'
        );
        INSERT INTO pending_video_scrape_sources (
          id, pending_scrape_id, position, plugin_name, plugin_source,
          plugin_config_json, source_name, selected_fields_json
        ) VALUES (82, 81, 0, 'test', 'builtin', '{}', 'test', '[]');
        INSERT INTO pending_video_scrape_candidates (id, source_id, position, result_json)
        VALUES (83, 82, 0, '{}');
        INSERT INTO pending_video_scrape_resources (
          id, candidate_id, field, position, staged_path
        ) VALUES (84, 83, 'cover', 0, 'video-scrape/pending/a.jpg');
      `)
      const pendingChanged = lifecycle.previewDeleteGlobally(91)
      assert.notEqual(pendingChanged.revision, resourceChanged.revision)

      database
        .prepare(
          "UPDATE pending_video_scrape_resources SET staged_path = 'video-scrape/pending/b.jpg' WHERE id = 84"
        )
        .run()
      const stagingChanged = lifecycle.previewDeleteGlobally(91)
      assert.notEqual(stagingChanged.revision, pendingChanged.revision)
    } finally {
      database.close()
    }
  })
})
