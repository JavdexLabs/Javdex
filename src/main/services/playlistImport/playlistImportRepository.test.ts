import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../../db/migrations'
import { ensureVideoMembership } from '../../db/libraryMembershipRepo'
import {
  normalizePlaylistImportUrl,
  PLAYLIST_IMPORT_DISCOVERY_LIMITS,
  PlaylistImportRepository,
  type PlaylistImportPageCheckpointInput,
  type PlaylistImportVirtualBatchCheckpointInput
} from './playlistImportRepository'

function setup(): { database: Database.Database; repository: PlaylistImportRepository } {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  migrateDatabase(database)
  return { database, repository: new PlaylistImportRepository(database) }
}

function createAgentRun(database: Database.Database, runId: string): void {
  database.prepare(
    `INSERT INTO agent_runs (
      id, use_case, status, config_revision, config_snapshot_json,
      runtime_id, product_state_json, created_at, updated_at
    ) VALUES (?, 'playlist-importer', 'running', '1', '{}', 'pi', '{}', ?, ?)`
  ).run(runId, '2026-01-01', '2026-01-01')
}

describe('PlaylistImportRepository', () => {
  it('rejects credential-bearing source and detail URLs before staging them', () => {
    assert.throws(
      () => normalizePlaylistImportUrl('https://example.test/list?access_token=secret'),
      /PLAYLIST_IMPORT_URL_CREDENTIALS/
    )
    assert.throws(
      () => normalizePlaylistImportUrl('https://example.test/video/1?x-amz-signature=secret'),
      /PLAYLIST_IMPORT_URL_CREDENTIALS/
    )
    assert.equal(
      normalizePlaylistImportUrl('https://example.test/video/1?id=public#cast'),
      'https://example.test/video/1?id=public'
    )
  })

  it('removes sensitive detail URL credentials and requires explicit user identity handling', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-sensitive-detail')
      repository.createJob({
        runId: 'run-sensitive-detail',
        idempotencyKey: 'sensitive-detail',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const waiting = repository.checkpointStaticPage({
        runId: 'run-sensitive-detail',
        pageKey: 'page-0',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/page-0.json',
        items: [{
          code: 'SAFE-1',
          detailUrl: 'https://legacy:secret@example.test/video/safe-1?id=public&x-amz-signature=private#cast'
        }],
        nextPageUrls: [],
        terminal: true
      })

      assert.equal(waiting.phase, 'waiting_user')
      assert.equal(waiting.attention?.kind, 'identity-review')
      const review = waiting.attention?.kind === 'identity-review'
        ? waiting.attention.items[0]
        : null
      assert.equal(review?.conflict?.kind, 'sensitive-detail-url')
      assert.equal(review?.detailUrl, 'https://example.test/video/safe-1?id=public')
      const stored = database.prepare(
        `SELECT detail_url, normalized_detail_url, error_code
         FROM playlist_import_items WHERE run_id = 'run-sensitive-detail'`
      ).get() as {
        detail_url: string
        normalized_detail_url: string
        error_code: string | null
      }
      assert.deepEqual(stored, {
        detail_url: 'https://example.test/video/safe-1?id=public',
        normalized_detail_url: 'https://example.test/video/safe-1?id=public',
        error_code: 'SENSITIVE_DETAIL_URL'
      })
      assert.doesNotMatch(JSON.stringify(stored), /secret|private/iu)

      const ready = repository.resolveIdentityDecisions({
        runId: 'run-sensitive-detail',
        expectedRevision: waiting.revision,
        idempotencyKey: 'approve-sanitized-detail',
        decisions: [{ itemId: review!.itemId, choice: { kind: 'create' } }]
      })
      assert.equal(ready.phase, 'ready-to-apply')
      const outcome = repository.apply('run-sensitive-detail', 'apply-sensitive-detail')
      assert.equal(outcome.createdVideos, 1)
      assert.deepEqual(
        database.prepare('SELECT url, normalized_url FROM video_links').all(),
        [{
          url: 'https://example.test/video/safe-1?id=public',
          normalized_url: 'https://example.test/video/safe-1?id=public'
        }]
      )
    } finally {
      database.close()
    }
  })

  it('accepts a checkpoint after a source redirects between www and apex host variants', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-www-redirect')
      repository.createJob({
        runId: 'run-www-redirect',
        idempotencyKey: 'www-redirect',
        sourceUrl: 'https://www.example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const ready = repository.checkpointStaticPage({
        runId: 'run-www-redirect',
        pageKey: 'page-0',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/page-0.json',
        items: [{ code: 'WWW-1', detailUrl: 'https://www.example.test/video/1' }],
        nextPageUrls: [],
        terminal: true
      })
      assert.equal(ready.phase, 'ready-to-apply')
      assert.equal(ready.frozenInput.sourceHost, 'example.test')
    } finally {
      database.close()
    }
  })

  it('fails an empty external list without creating an empty playlist', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-empty-list')
      repository.createJob({
        runId: 'run-empty-list',
        idempotencyKey: 'empty-list',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })

      const failed = repository.checkpointStaticPage({
        runId: 'run-empty-list',
        pageKey: 'page-0',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/page-0.json',
        items: [],
        nextPageUrls: [],
        terminal: true
      })

      assert.equal(failed.phase, 'failed')
      assert.equal(failed.error?.code, 'NO_ITEMS_FOUND')
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM playlists').get() as { n: number }).n, 0)
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM videos').get() as { n: number }).n, 0)
    } finally {
      database.close()
    }
  })

  it('fails discovery when the frozen run exceeds its wall-clock safety budget', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-duration-limit')
      repository.createJob({
        runId: 'run-duration-limit',
        idempotencyKey: 'duration-limit',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      database.prepare(
        'UPDATE playlist_import_jobs SET created_at = ? WHERE run_id = ?'
      ).run('2000-01-01T00:00:00.000Z', 'run-duration-limit')

      const failed = repository.checkpointStaticPage({
        runId: 'run-duration-limit',
        pageKey: 'page-0',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/page-0.json',
        items: [{ code: 'LATE-1', detailUrl: 'https://example.test/video/late-1' }],
        nextPageUrls: [],
        terminal: true
      })

      assert.equal(failed.phase, 'failed')
      assert.equal(failed.error?.code, 'LIMIT_REACHED')
      assert.match(failed.error?.message ?? '', /RUN_DURATION/)
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM playlist_import_pages').get() as { n: number }).n, 0)
    } finally {
      database.close()
    }
  })

  it('checkpoints every page before atomically creating/reusing videos and a new playlist', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-create')
      database.exec(`
        INSERT INTO media_libraries (id, name, status) VALUES (2, 'Other', 'active');
        INSERT INTO media_library_configs (library_id) VALUES (2);
        INSERT INTO videos (id, code, title) VALUES (20, 'AAA-1', 'Existing');
      `)
      ensureVideoMembership({ libraryId: 2, videoId: 20, addedVia: 'manual' }, database)

      const started = repository.createJob({
        runId: 'run-create',
        idempotencyKey: 'start-create',
        sourceUrl: 'https://example.test/list#top',
        targetLibraryId: 1,
        destination: { kind: 'create', requestedName: 'Imported' },
        saveSourcePlaylistLink: true
      })
      assert.equal(started.phase, 'discovering-list')
      assert.equal(started.frozenInput.autoCreateUnmatchedVideos, true)
      assert.equal(started.frozenInput.saveDetailLinks, true)
      assert.equal(started.frozenInput.saveSourcePlaylistLink, true)
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM playlists').get() as { n: number }).n, 0)
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM videos').get() as { n: number }).n, 1)

      const first = repository.checkpointStaticPage({
        runId: 'run-create',
        pageKey: 'page-1',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/page-1.json',
        suggestedPlaylistName: 'Agent page name',
        items: [
          { code: 'aaa-1', title: 'Existing external', detailUrl: 'https://example.test/video/a' },
          { code: 'new-1', title: 'New external', detailUrl: 'https://example.test/video/new' }
        ],
        nextPageUrls: ['https://example.test/list?page=2'],
        terminal: false,
        declaredTotalPages: 2
      })
      assert.equal(first.phase, 'discovering-list')
      assert.equal(first.progress.pagesRead, 1)
      assert.equal(first.progress.sourceItems, 2)

      const ready = repository.checkpointStaticPage({
        runId: 'run-create',
        pageKey: 'page-2',
        pageOrder: 1,
        pageUrl: 'https://example.test/list?page=2',
        documentRevision: '1:2',
        viewRevision: '1:2:0',
        evidenceRef: '.javdex/browser/page-2.json',
        items: [
          { code: 'AAA-1', title: 'Repeated occurrence', detailUrl: 'https://example.test/video/a#cast' }
        ],
        nextPageUrls: [],
        terminal: true,
        declaredTotalPages: 2
      })
      assert.equal(ready.phase, 'ready-to-apply')
      assert.equal(ready.progress.pagesRead, 2)
      assert.equal(ready.progress.sourceItems, 3)
      assert.equal(ready.progress.uniqueItems, 2)
      assert.equal(ready.progress.directReuses, 1)
      assert.equal(ready.progress.plannedCreates, 1)
      assert.equal(ready.preview?.totalItems, 2)
      assert.equal(ready.preview?.truncated, false)
      assert.deepEqual(
        ready.preview?.items.map((item) => ({ code: item.code, state: item.state })),
        [
          { code: 'AAA-1', state: 'planned-reuse' },
          { code: 'NEW-1', state: 'planned-create' }
        ]
      )
      assert.equal(ready.preview?.items[0]?.resolvedVideo?.code, 'AAA-1')
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM playlists').get() as { n: number }).n, 0)

      const outcome = repository.apply('run-create', 'apply-create')
      const replay = repository.apply('run-create', 'apply-create')
      assert.deepEqual(replay, outcome)
      assert.throws(
        () => repository.apply('run-create', 'different-apply-command'),
        /APPLY_IDEMPOTENCY_KEY_REUSED/
      )
      assert.deepEqual(outcome, {
        playlistId: 1,
        playlistName: 'Imported',
        targetLibraryId: 1,
        targetLibraryName: '默认媒体库',
        pagesRead: 2,
        sourceItems: 3,
        uniqueDetailUrls: 2,
        totalItems: 2,
        reusedVideos: 1,
        directReuses: 1,
        detailReuses: 0,
        userSelectedReuses: 0,
        crossLibraryReuses: 1,
        createdVideos: 1,
        targetLibraryMembersCreated: 1,
        skippedVideos: 0,
        addedToPlaylist: 2,
        alreadyInPlaylist: 0,
        relatedLinksAdded: 2,
        playlistRelatedLinksAdded: 1,
        externalDuplicateItems: 1,
        convergedExternalItems: 0,
        reuseLibraryDistribution: [{
          libraryId: 2,
          libraryName: 'Other',
          reusedVideos: 1
        }]
      })
      assert.equal(
        (database.prepare('SELECT COUNT(*) AS n FROM library_video_memberships WHERE library_id = 1 AND video_id = 20').get() as { n: number }).n,
        0
      )
      const newVideo = database.prepare("SELECT id, scraped_status FROM videos WHERE code = 'NEW-1'")
        .get() as { id: number; scraped_status: number }
      assert.equal(newVideo.scraped_status, 0)
      assert.equal(
        (database.prepare('SELECT COUNT(*) AS n FROM library_video_memberships WHERE library_id = 1 AND video_id = ?').get(newVideo.id) as { n: number }).n,
        1
      )
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM video_resources').get() as { n: number }).n, 0)
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM video_links').get() as { n: number }).n, 2)
      assert.deepEqual(
        database.prepare(
          'SELECT label, url, position FROM playlist_links WHERE playlist_id = ?'
        ).all(outcome.playlistId),
        [{ label: 'example.test', url: 'https://example.test/list', position: 0 }]
      )
      assert.equal(
        (database.prepare('SELECT name FROM playlists WHERE id = ?').get(outcome.playlistId) as { name: string }).name,
        'Imported'
      )
      const completed = repository.snapshot('run-create')!
      assert.equal(completed.preview?.items.every((item) => item.state === 'applied'), true)
      assert.equal(completed.preview?.items[1]?.resolvedVideo?.code, 'NEW-1')
    } finally {
      database.close()
    }
  })

  it('assigns stable unique page order when numbered pagination rediscoveries overlap', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-numbered')
      repository.createJob({
        runId: 'run-numbered',
        idempotencyKey: 'numbered',
        sourceUrl: 'https://example.test/list?page=1',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-numbered',
        pageKey: 'page-1',
        pageOrder: 0,
        pageUrl: 'https://example.test/list?page=1',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/page-1.json',
        items: [{ code: 'P-1', detailUrl: 'https://example.test/video/1' }],
        nextPageUrls: [
          'https://example.test/list?page=2',
          'https://example.test/list?page=3'
        ],
        terminal: false
      })
      repository.checkpointStaticPage({
        runId: 'run-numbered',
        pageKey: 'page-2',
        pageOrder: 1,
        pageUrl: 'https://example.test/list?page=2',
        documentRevision: '1:2',
        viewRevision: '1:2:0',
        evidenceRef: '.javdex/browser/page-2.json',
        items: [{ code: 'P-2', detailUrl: 'https://example.test/video/2' }],
        nextPageUrls: [
          'https://example.test/list?page=1',
          'https://example.test/list?page=2',
          'https://example.test/list?page=3'
        ],
        terminal: false
      })

      assert.deepEqual(
        database.prepare(
          `SELECT canonical_key, order_hint FROM playlist_import_frontier
           WHERE run_id = 'run-numbered' ORDER BY order_hint`
        ).all(),
        [
          { canonical_key: 'url:https://example.test/list?page=1', order_hint: 0 },
          { canonical_key: 'url:https://example.test/list?page=2', order_hint: 1 },
          { canonical_key: 'url:https://example.test/list?page=3', order_hint: 2 }
        ]
      )
      assert.deepEqual(repository.nextBrowserWork('run-numbered'), {
        kind: 'list',
        pageOrder: 2,
        url: 'https://example.test/list?page=3'
      })
    } finally {
      database.close()
    }
  })

  it('fails self-referential and A-to-B-to-A static pagination as PAGINATION_LOOP', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-self-loop')
      repository.createJob({
        runId: 'run-self-loop',
        idempotencyKey: 'self-loop',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const selfLoop = repository.checkpointStaticPage({
        runId: 'run-self-loop',
        pageKey: 'page-a',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/page-a.json',
        items: [{ code: 'A-1', detailUrl: 'https://example.test/video/a' }],
        nextPageUrls: ['https://example.test/list'],
        terminal: false
      })
      assert.equal(selfLoop.phase, 'failed')
      assert.equal(selfLoop.error?.code, 'PAGINATION_LOOP')

      createAgentRun(database, 'run-two-page-loop')
      repository.createJob({
        runId: 'run-two-page-loop',
        idempotencyKey: 'two-page-loop',
        sourceUrl: 'https://example.test/list-a',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-two-page-loop',
        pageKey: 'page-a',
        pageOrder: 0,
        pageUrl: 'https://example.test/list-a',
        documentRevision: '2:1',
        viewRevision: '2:1:0',
        evidenceRef: '.javdex/browser/page-a.json',
        items: [{ code: 'A-2', detailUrl: 'https://example.test/video/a-2' }],
        nextPageUrls: ['https://example.test/list-b'],
        terminal: false
      })
      const loop = repository.checkpointStaticPage({
        runId: 'run-two-page-loop',
        pageKey: 'page-b',
        pageOrder: 1,
        pageUrl: 'https://example.test/list-b',
        documentRevision: '2:2',
        viewRevision: '2:2:0',
        evidenceRef: '.javdex/browser/page-b.json',
        items: [{ code: 'B-2', detailUrl: 'https://example.test/video/b-2' }],
        nextPageUrls: ['https://example.test/list-a'],
        terminal: false
      })
      assert.equal(loop.phase, 'failed')
      assert.equal(loop.error?.code, 'PAGINATION_LOOP')
    } finally {
      database.close()
    }
  })

  it('keeps legal duplicate pages when their concrete pagination frontiers differ', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-content-loop')
      repository.createJob({
        runId: 'run-content-loop',
        idempotencyKey: 'content-loop',
        sourceUrl: 'https://example.test/list?cursor=one',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-content-loop',
        pageKey: 'cursor-one',
        pageOrder: 0,
        pageUrl: 'https://example.test/list?cursor=one',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/cursor-one.json',
        items: [{ code: 'LOOP-1', detailUrl: 'https://example.test/video/loop-1' }],
        nextPageUrls: ['https://example.test/list?cursor=two'],
        terminal: false
      })
      const second = repository.checkpointStaticPage({
        runId: 'run-content-loop',
        pageKey: 'cursor-two',
        pageOrder: 1,
        pageUrl: 'https://example.test/list?cursor=two',
        documentRevision: '1:2',
        viewRevision: '1:2:0',
        evidenceRef: '.javdex/browser/cursor-two.json',
        items: [{ code: 'LOOP-1', detailUrl: 'https://example.test/video/loop-1' }],
        nextPageUrls: ['https://example.test/list?cursor=three'],
        terminal: false
      })

      assert.equal(second.phase, 'discovering-list')
      assert.deepEqual(repository.nextBrowserWork('run-content-loop'), {
        kind: 'list',
        pageOrder: 2,
        url: 'https://example.test/list?cursor=three'
      })

      const ready = repository.checkpointStaticPage({
        runId: 'run-content-loop',
        pageKey: 'cursor-three',
        pageOrder: 2,
        pageUrl: 'https://example.test/list?cursor=three',
        documentRevision: '1:3',
        viewRevision: '1:3:0',
        evidenceRef: '.javdex/browser/cursor-three.json',
        items: [{ code: 'LOOP-1', detailUrl: 'https://example.test/video/loop-1' }],
        nextPageUrls: [],
        terminal: true
      })

      assert.equal(ready.phase, 'ready-to-apply')
      assert.equal(ready.progress.pagesRead, 3)
      assert.equal(ready.progress.sourceItems, 3)
      assert.equal(ready.progress.uniqueItems, 1)
    } finally {
      database.close()
    }
  })

  it('fails a sealed dynamic page whose next URL only loops to an existing frontier', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-dynamic-loop')
      repository.createJob({
        runId: 'run-dynamic-loop',
        idempotencyKey: 'dynamic-loop',
        sourceUrl: 'https://example.test/dynamic',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })

      const failed = repository.checkpointVirtualBatch({
        runId: 'run-dynamic-loop',
        pageKey: 'dynamic-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/dynamic',
        documentRevision: '1:1',
        initialViewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/dynamic.json',
        operationKey: 'dynamic-start-and-seal',
        batchOrder: 0,
        viewRevision: '1:1:0',
        enumerationKind: 'load-more',
        positionMode: 'overlap',
        containerFingerprint: 'dynamic-list',
        scrollState: {
          scrollTop: 100,
          scrollHeight: 200,
          clientHeight: 100,
          atStart: true,
          atEnd: true,
          moved: false,
          settled: true
        },
        items: [{
          occurrenceKey: '0:https://example.test/video/dynamic',
          absolutePosition: 0,
          code: 'DYNAMIC-1',
          detailUrl: 'https://example.test/video/dynamic'
        }],
        accumulatedSequenceDigest: 'digest-dynamic',
        terminalProbeCount: 0,
        seal: true,
        nextPageUrls: ['https://example.test/dynamic']
      })

      assert.equal(failed.phase, 'failed')
      assert.equal(failed.error?.code, 'PAGINATION_LOOP')
      assert.equal((database.prepare(
        'SELECT COUNT(*) AS value FROM playlist_import_pages WHERE run_id = ?'
      ).get('run-dynamic-loop') as { value: number }).value, 0)
    } finally {
      database.close()
    }
  })

  it('keeps a declared page-total mismatch retryable and accepts a corrected checkpoint', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-declared-mismatch')
      repository.createJob({
        runId: 'run-declared-mismatch',
        idempotencyKey: 'declared-mismatch',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const mismatch = repository.checkpointStaticPage({
        runId: 'run-declared-mismatch',
        pageKey: 'page-1',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/page-1.json',
        items: [{ code: 'P-1', detailUrl: 'https://example.test/video/1' }],
        nextPageUrls: [],
        terminal: true,
        declaredTotalPages: 2,
        declaredTotalItems: 3
      })
      assert.equal(mismatch.phase, 'discovering-list')
      assert.equal(mismatch.error?.code, 'TOTAL_MISMATCH')
      assert.equal(mismatch.error?.retryable, true)
      assert.equal(
        (database.prepare('SELECT COUNT(*) AS count FROM playlist_import_pages').get() as {
          count: number
        }).count,
        0
      )
      const corrected = repository.checkpointStaticPage({
        runId: 'run-declared-mismatch',
        pageKey: 'page-1',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/page-1.json',
        items: [{ code: 'P-1', detailUrl: 'https://example.test/video/1' }],
        nextPageUrls: [],
        terminal: true,
        declaredTotalPages: 1,
        declaredTotalItems: 1
      })
      assert.equal(corrected.error, undefined)
      assert.equal(corrected.phase, 'ready-to-apply')
    } finally {
      database.close()
    }
  })

  it('rejects a conflicting nonterminal page before sealing it and completes after correction', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-declared-conflict')
      repository.createJob({
        runId: 'run-declared-conflict',
        idempotencyKey: 'declared-conflict',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-declared-conflict',
        pageKey: 'page-1',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/page-1.json',
        items: [{ code: 'C-1', detailUrl: 'https://example.test/video/1' }],
        nextPageUrls: ['https://example.test/list?page=2'],
        terminal: false,
        declaredTotalPages: 3,
        declaredTotalItems: 3
      })
      const conflict = repository.checkpointStaticPage({
        runId: 'run-declared-conflict',
        pageKey: 'page-2',
        pageOrder: 1,
        pageUrl: 'https://example.test/list?page=2',
        documentRevision: '1:2',
        viewRevision: '1:2:0',
        evidenceRef: '.javdex/browser/page-2.json',
        items: [{ code: 'C-2', detailUrl: 'https://example.test/video/2' }],
        nextPageUrls: ['https://example.test/list?page=3'],
        terminal: false,
        declaredTotalPages: 4,
        declaredTotalItems: 4
      })
      assert.equal(conflict.error?.code, 'TOTAL_MISMATCH')
      assert.equal((database.prepare(
        `SELECT status FROM playlist_import_frontier
         WHERE run_id = ? AND canonical_key = ?`
      ).get('run-declared-conflict', 'url:https://example.test/list?page=2') as {
        status: string
      }).status, 'pending')
      assert.equal((database.prepare(
        `SELECT COUNT(*) AS value FROM playlist_import_pages
         WHERE run_id = ? AND page_order = 1`
      ).get('run-declared-conflict') as { value: number }).value, 0)

      const correctedSecond = repository.checkpointStaticPage({
        runId: 'run-declared-conflict',
        pageKey: 'page-2',
        pageOrder: 1,
        pageUrl: 'https://example.test/list?page=2',
        documentRevision: '1:2',
        viewRevision: '1:2:0',
        evidenceRef: '.javdex/browser/page-2.json',
        items: [{ code: 'C-2', detailUrl: 'https://example.test/video/2' }],
        nextPageUrls: ['https://example.test/list?page=3'],
        terminal: false,
        declaredTotalPages: 3,
        declaredTotalItems: 3
      })
      assert.equal(correctedSecond.error, undefined)
      assert.equal(correctedSecond.phase, 'discovering-list')
      const completed = repository.checkpointStaticPage({
        runId: 'run-declared-conflict',
        pageKey: 'page-3',
        pageOrder: 2,
        pageUrl: 'https://example.test/list?page=3',
        documentRevision: '1:3',
        viewRevision: '1:3:0',
        evidenceRef: '.javdex/browser/page-3.json',
        items: [{ code: 'C-3', detailUrl: 'https://example.test/video/3' }],
        nextPageUrls: [],
        terminal: true,
        declaredTotalPages: 3,
        declaredTotalItems: 3
      })
      assert.equal(completed.error, undefined)
      assert.equal(completed.phase, 'ready-to-apply')
    } finally {
      database.close()
    }
  })

  it('restarts from the source when only the terminal page proves earlier totals wrong', () => {
    const { database, repository } = setup()
    try {
      for (const scenario of [
        { suffix: 'pages', itemsPerPage: 1, wrongPages: 2, wrongItems: 3 },
        { suffix: 'items', itemsPerPage: 2, wrongPages: 3, wrongItems: 5 }
      ]) {
        const runId = `run-terminal-total-${scenario.suffix}`
        const sourceUrl = `https://example.test/${scenario.suffix}`
        createAgentRun(database, runId)
        repository.createJob({
          runId,
          idempotencyKey: `terminal-total-${scenario.suffix}`,
          sourceUrl,
          targetLibraryId: 1,
          destination: { kind: 'create' }
        })
        const checkpoint = (
          page: number,
          declaredTotalPages?: number,
          declaredTotalItems?: number
        ) => repository.checkpointStaticPage({
          runId,
          pageKey: `page-${page}`,
          pageOrder: page - 1,
          pageUrl: page === 1 ? sourceUrl : `${sourceUrl}?page=${page}`,
          documentRevision: `1:${page}`,
          viewRevision: `1:${page}:0`,
          evidenceRef: `.javdex/browser/${scenario.suffix}-${page}.json`,
          items: Array.from({ length: scenario.itemsPerPage }, (_, index) => ({
            code: `${scenario.suffix}-${page}-${index}`,
            detailUrl: `${sourceUrl}/video/${page}-${index}`
          })),
          nextPageUrls: page < 3 ? [`${sourceUrl}?page=${page + 1}`] : [],
          terminal: page === 3,
          ...(declaredTotalPages != null ? { declaredTotalPages } : {}),
          ...(declaredTotalItems != null ? { declaredTotalItems } : {})
        })

        checkpoint(1, scenario.wrongPages, scenario.wrongItems)
        checkpoint(2, scenario.wrongPages, scenario.wrongItems)
        const mismatch = checkpoint(3)
        assert.equal(mismatch.error?.code, 'TOTAL_MISMATCH')

        const reset = repository.resetDiscoveryForTotalMismatch(runId)
        assert.equal(reset.error, undefined)
        assert.equal(reset.phase, 'discovering-list')
        assert.equal(repository.nextBrowserWork(runId)?.url, sourceUrl)
        assert.equal((database.prepare(
          'SELECT COUNT(*) AS value FROM playlist_import_pages WHERE run_id = ?'
        ).get(runId) as { value: number }).value, 0)

        const correctItems = scenario.itemsPerPage * 3
        checkpoint(1, 3, correctItems)
        checkpoint(2, 3, correctItems)
        const completed = checkpoint(3, 3, correctItems)
        assert.equal(completed.error, undefined)
        assert.equal(completed.phase, 'ready-to-apply')
      }
    } finally {
      database.close()
    }
  })

  it('uses the first-page Agent suggestion when the user leaves the new playlist name empty', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-agent-name')
      repository.createJob({
        runId: 'run-agent-name',
        idempotencyKey: 'start-agent-name',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-agent-name',
        pageKey: 'only-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        suggestedPlaylistName: '  Ear   Slap Series  ',
        items: [{ code: 'NAME-1', detailUrl: 'https://example.test/video/name-1' }],
        nextPageUrls: [],
        terminal: true
      })

      const outcome = new PlaylistImportRepository(database).apply('run-agent-name', 'apply-agent-name')
      assert.equal(
        (database.prepare('SELECT name FROM playlists WHERE id = ?').get(outcome.playlistId) as { name: string }).name,
        'Ear Slap Series'
      )
      assert.equal(
        (database.prepare(
          "SELECT agent_suggested_playlist_name FROM playlist_import_jobs WHERE run_id = 'run-agent-name'"
        ).get() as { agent_suggested_playlist_name: string }).agent_suggested_playlist_name,
        'Ear Slap Series'
      )
    } finally {
      database.close()
    }
  })

  it('keeps existing playlist links and deduplicates the source playlist URL when enabled', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-append-source-link')
      database.exec(`
        INSERT INTO playlists (id, name, created_at, updated_at)
        VALUES (8, 'Existing list', '2026-01-01', '2026-01-01');
        INSERT INTO videos (id, code, title) VALUES (20, 'LINK-1', 'Existing');
        INSERT INTO playlist_links (playlist_id, label, url, normalized_url, position)
        VALUES (8, 'Original label', 'https://example.test/list#saved',
                'https://example.test/list', 0);
      `)
      repository.createJob({
        runId: 'run-append-source-link',
        idempotencyKey: 'start-append-source-link',
        sourceUrl: 'https://example.test/list#latest',
        targetLibraryId: 1,
        destination: { kind: 'append', playlistId: 8 },
        saveSourcePlaylistLink: true
      })
      repository.checkpointStaticPage({
        runId: 'run-append-source-link',
        pageKey: 'only-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'LINK-1', detailUrl: 'https://example.test/video/link-1' }],
        nextPageUrls: [],
        terminal: true
      })

      repository.apply('run-append-source-link', 'apply-append-source-link')

      assert.deepEqual(
        database.prepare(
          'SELECT label, url, normalized_url, position FROM playlist_links WHERE playlist_id = 8'
        ).all(),
        [{
          label: 'Original label',
          url: 'https://example.test/list#saved',
          normalized_url: 'https://example.test/list',
          position: 0
        }]
      )
    } finally {
      database.close()
    }
  })

  it('falls back to the existing host-and-date name when the Agent returns no name', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-fallback-name')
      repository.createJob({
        runId: 'run-fallback-name',
        idempotencyKey: 'start-fallback-name',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-fallback-name',
        pageKey: 'only-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        suggestedPlaylistName: '   ',
        items: [{ code: 'FALLBACK-1', detailUrl: 'https://example.test/video/fallback-1' }],
        nextPageUrls: [],
        terminal: true
      })

      const expectedName = `example.test · ${new Date().toISOString().slice(0, 10)}`
      const outcome = repository.apply('run-fallback-name', 'apply-fallback-name')
      assert.equal(
        (database.prepare('SELECT name FROM playlists WHERE id = ?').get(outcome.playlistId) as { name: string }).name,
        expectedName
      )
    } finally {
      database.close()
    }
  })

  it('does not let an Agent suggestion rename an append target', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-append-name')
      database.prepare(
        "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (8, 'Existing list', '2026-01-01', '2026-01-01')"
      ).run()
      repository.createJob({
        runId: 'run-append-name',
        idempotencyKey: 'start-append-name',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'append', playlistId: 8 }
      })
      repository.checkpointStaticPage({
        runId: 'run-append-name',
        pageKey: 'only-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        suggestedPlaylistName: 'Ignored Agent name',
        items: [{ code: 'APPEND-1', detailUrl: 'https://example.test/video/append-1' }],
        nextPageUrls: [],
        terminal: true
      })

      repository.apply('run-append-name', 'apply-append-name')
      assert.equal(
        (database.prepare('SELECT name FROM playlists WHERE id = 8').get() as { name: string }).name,
        'Existing list'
      )
      assert.equal(
        (database.prepare(
          "SELECT agent_suggested_playlist_name FROM playlist_import_jobs WHERE run_id = 'run-append-name'"
        ).get() as { agent_suggested_playlist_name: string | null }).agent_suggested_playlist_name,
        null
      )
    } finally {
      database.close()
    }
  })

  it('skips unmatched items and omits detail links when both write options are disabled', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-options-disabled')
      database.prepare("INSERT INTO videos (id, code, title) VALUES (20, 'KEEP-1', 'Existing')").run()
      const started = repository.createJob({
        runId: 'run-options-disabled',
        idempotencyKey: 'start-options-disabled',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create', requestedName: 'Configured import' },
        autoCreateUnmatchedVideos: false,
        saveDetailLinks: false
      })
      assert.equal(started.frozenInput.autoCreateUnmatchedVideos, false)
      assert.equal(started.frozenInput.saveDetailLinks, false)
      assert.equal(started.frozenInput.saveSourcePlaylistLink, false)

      const ready = repository.checkpointStaticPage({
        runId: 'run-options-disabled',
        pageKey: 'only-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [
          { code: 'KEEP-1', detailUrl: 'https://example.test/video/existing' },
          { code: 'SKIP-2', detailUrl: 'https://example.test/video/unmatched' }
        ],
        nextPageUrls: [],
        terminal: true
      })

      assert.equal(ready.phase, 'ready-to-apply')
      assert.equal(ready.progress.plannedCreates, 0)
      assert.equal(ready.progress.skippedItems, 1)
      assert.equal(ready.preview?.items[1]?.errorCode, 'AUTO_CREATE_DISABLED')

      const outcome = repository.apply('run-options-disabled', 'apply-options-disabled')
      assert.deepEqual(outcome, {
        playlistId: 1,
        playlistName: 'Configured import',
        targetLibraryId: 1,
        targetLibraryName: '默认媒体库',
        pagesRead: 1,
        sourceItems: 2,
        uniqueDetailUrls: 2,
        totalItems: 2,
        reusedVideos: 1,
        directReuses: 1,
        detailReuses: 0,
        userSelectedReuses: 0,
        crossLibraryReuses: 0,
        createdVideos: 0,
        targetLibraryMembersCreated: 0,
        skippedVideos: 1,
        addedToPlaylist: 1,
        alreadyInPlaylist: 0,
        relatedLinksAdded: 0,
        playlistRelatedLinksAdded: 0,
        externalDuplicateItems: 0,
        convergedExternalItems: 0,
        reuseLibraryDistribution: [{
          libraryId: 0,
          libraryName: '未归属媒体库',
          reusedVideos: 1
        }]
      })
      assert.equal(
        (database.prepare("SELECT COUNT(*) AS n FROM videos WHERE code = 'SKIP-2'").get() as { n: number }).n,
        0
      )
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM video_links').get() as { n: number }).n, 0)
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM playlist_links').get() as { n: number }).n, 0)
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM playlist_video').get() as { n: number }).n, 1)
    } finally {
      database.close()
    }
  })

  it('reuses a unique code match created after an auto-create-disabled preview', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-disabled-concurrent-match')
      repository.createJob({
        runId: 'run-disabled-concurrent-match',
        idempotencyKey: 'start-disabled-concurrent-match',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create', requestedName: 'Concurrent match' },
        autoCreateUnmatchedVideos: false
      })
      const ready = repository.checkpointStaticPage({
        runId: 'run-disabled-concurrent-match',
        pageKey: 'only-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'LATE-1', detailUrl: 'https://example.test/video/late-1' }],
        nextPageUrls: [],
        terminal: true
      })
      assert.equal(ready.preview?.items[0]?.errorCode, 'AUTO_CREATE_DISABLED')

      database.prepare("INSERT INTO videos (id, code, title) VALUES (21, 'LATE-1', 'Added later')").run()
      assert.throws(
        () => repository.apply('run-disabled-concurrent-match', 'apply-disabled-concurrent-match'),
        /IMPORT_PREVIEW_STALE/
      )
      const refreshed = repository.snapshot('run-disabled-concurrent-match')!
      assert.equal(refreshed.phase, 'ready-to-apply')
      assert.equal(refreshed.preview?.items[0]?.state, 'planned-reuse')
      assert.equal(refreshed.preview?.items[0]?.resolvedVideo?.id, 21)

      const outcome = repository.apply(
        'run-disabled-concurrent-match',
        'apply-disabled-concurrent-match-retry'
      )
      assert.equal(outcome.reusedVideos, 1)
      assert.equal(outcome.skippedVideos, 0)
      assert.equal(
        (database.prepare('SELECT video_id FROM playlist_video WHERE playlist_id = ?')
          .get(outcome.playlistId) as { video_id: number }).video_id,
        21
      )
    } finally {
      database.close()
    }
  })

  it('persists target-library and target-playlist failures instead of leaving apply retry loops', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-archived-library')
      repository.createJob({
        runId: 'run-archived-library',
        idempotencyKey: 'archived-library',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-archived-library',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'NEW-ARCHIVE-1', detailUrl: 'https://example.test/video/archive' }],
        nextPageUrls: [],
        terminal: true
      })
      database.prepare("UPDATE media_libraries SET status = 'archived' WHERE id = 1").run()
      assert.throws(
        () => repository.apply('run-archived-library', 'apply-archived-library'),
        /TARGET_LIBRARY_ARCHIVED/
      )
      assert.equal(repository.snapshot('run-archived-library')?.phase, 'ready-to-apply')
      assert.equal(repository.snapshot('run-archived-library')?.error?.code, 'TARGET_LIBRARY_ARCHIVED')
      assert.equal(repository.snapshot('run-archived-library')?.error?.retryable, true)

      database.prepare("UPDATE media_libraries SET status = 'active' WHERE id = 1").run()
      const recovered = repository.apply('run-archived-library', 'apply-archived-library-retry')
      assert.equal(recovered.createdVideos, 1)
      database.exec(`
        INSERT INTO media_libraries (id, name, status) VALUES (2, 'Temporary', 'active');
        INSERT INTO media_library_configs (library_id) VALUES (2);
      `)
      createAgentRun(database, 'run-missing-library')
      repository.createJob({
        runId: 'run-missing-library',
        idempotencyKey: 'missing-library',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 2,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-missing-library',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'NEW-MISSING-1', detailUrl: 'https://example.test/video/missing' }],
        nextPageUrls: [],
        terminal: true
      })
      database.prepare('DELETE FROM media_libraries WHERE id = 2').run()
      assert.throws(
        () => repository.apply('run-missing-library', 'apply-missing-library'),
        /TARGET_LIBRARY_NOT_FOUND/
      )
      assert.equal(repository.snapshot('run-missing-library')?.phase, 'failed')
      assert.equal(repository.snapshot('run-missing-library')?.error?.code, 'TARGET_LIBRARY_NOT_FOUND')

      database.prepare(
        "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (9, 'Append target', ?, ?)"
      ).run(new Date().toISOString(), new Date().toISOString())
      createAgentRun(database, 'run-missing-playlist')
      repository.createJob({
        runId: 'run-missing-playlist',
        idempotencyKey: 'missing-playlist',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'append', playlistId: 9 }
      })
      repository.checkpointStaticPage({
        runId: 'run-missing-playlist',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'NEW-PLAYLIST-1', detailUrl: 'https://example.test/video/playlist' }],
        nextPageUrls: [],
        terminal: true
      })
      database.prepare('DELETE FROM playlists WHERE id = 9').run()
      assert.throws(
        () => repository.apply('run-missing-playlist', 'apply-missing-playlist'),
        /TARGET_PLAYLIST_NOT_FOUND/
      )
      assert.equal(repository.snapshot('run-missing-playlist')?.phase, 'failed')
      assert.equal(repository.snapshot('run-missing-playlist')?.error?.code, 'TARGET_PLAYLIST_NOT_FOUND')
      assert.equal((database.prepare(
        "SELECT COUNT(*) AS value FROM videos WHERE code IN ('NEW-MISSING-1', 'NEW-PLAYLIST-1')"
      ).get() as { value: number }).value, 0)
    } finally {
      database.close()
    }
  })

  it('counts external convergence separately from videos already present before apply', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-converged-items')
      database.exec(`
        INSERT INTO videos (id, code, title) VALUES (90, 'SAME-1', 'Shared owner');
        INSERT INTO video_links (video_id, label, url, normalized_url, position) VALUES
          (90, 'first', 'https://example.test/video/first', 'https://example.test/video/first', 0),
          (90, 'second', 'https://example.test/video/second', 'https://example.test/video/second', 1);
      `)
      repository.createJob({
        runId: 'run-converged-items',
        idempotencyKey: 'converged-items',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create', requestedName: 'Converged' }
      })
      repository.checkpointStaticPage({
        runId: 'run-converged-items',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [
          { detailUrl: 'https://example.test/video/first' },
          { detailUrl: 'https://example.test/video/second' }
        ],
        nextPageUrls: [],
        terminal: true
      })
      for (let index = 0; index < 2; index += 1) {
        const work = repository.nextBrowserWork('run-converged-items')
        assert.equal(work?.kind, 'detail')
        repository.checkpointDetailIdentity({
          runId: 'run-converged-items',
          itemId: work!.kind === 'detail' ? work.itemId : 0,
          expectedItemRevision: work!.kind === 'detail' ? work.itemRevision : 0,
          identity: {},
          evidenceRef: `.javdex/browser/detail-${index}.json`
        })
      }

      const outcome = repository.apply('run-converged-items', 'apply-converged-items')
      assert.equal(outcome.addedToPlaylist, 1)
      assert.equal(outcome.alreadyInPlaylist, 0)
      assert.equal(outcome.convergedExternalItems, 1)
      assert.equal(outcome.detailReuses, 2)
      assert.equal(outcome.crossLibraryReuses, 0)
    } finally {
      database.close()
    }
  })

  it('keeps multiple global code matches in the detail phase even when one is in the target library', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-ambiguous')
      database.exec(`
        INSERT INTO videos (id, code) VALUES (31, 'DUP-1'), (32, 'DUP-1');
      `)
      ensureVideoMembership({ libraryId: 1, videoId: 31, addedVia: 'manual' }, database)
      repository.createJob({
        runId: 'run-ambiguous',
        idempotencyKey: 'start-ambiguous',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const result = repository.checkpointStaticPage({
        runId: 'run-ambiguous',
        pageKey: 'only-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'dup-1', detailUrl: 'https://example.test/video/dup' }],
        nextPageUrls: [],
        terminal: true
      })

      assert.equal(result.phase, 'resolving-identities')
      assert.equal(result.progress.detailPending, 1)
      assert.throws(() => repository.apply('run-ambiguous', 'apply'), /PLAYLIST_IMPORT_NOT_READY/)
    } finally {
      database.close()
    }
  })

  it('reuses a unique exact code discovered only on the detail page', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-detail-code-only')
      database.prepare(
        "INSERT INTO videos (id, code, title) VALUES (36, 'DETAIL-ONLY-1', 'Existing')"
      ).run()
      repository.createJob({
        runId: 'run-detail-code-only',
        idempotencyKey: 'start-detail-code-only',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const resolving = repository.checkpointStaticPage({
        runId: 'run-detail-code-only',
        pageKey: 'only-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ title: 'No list code', detailUrl: 'https://example.test/video/detail-only' }],
        nextPageUrls: [],
        terminal: true
      })
      assert.equal(resolving.phase, 'resolving-identities')
      const work = repository.nextBrowserWork('run-detail-code-only')
      assert.equal(work?.kind, 'detail')

      const ready = repository.checkpointDetailIdentity({
        runId: 'run-detail-code-only',
        itemId: work!.kind === 'detail' ? work.itemId : 0,
        expectedItemRevision: work!.kind === 'detail' ? work.itemRevision : 0,
        detailCode: 'detail-only-1',
        identity: {},
        evidenceRef: '.javdex/browser/detail.json'
      })

      assert.equal(ready.phase, 'ready-to-apply')
      assert.equal(ready.preview?.items[0].resolvedVideo?.id, 36)
      assert.equal(ready.preview?.items[0].resolutionKind, 'direct-code')
      const outcome = repository.apply('run-detail-code-only', 'apply-detail-code-only')
      assert.equal(outcome.reusedVideos, 1)
    } finally {
      database.close()
    }
  })

  it('sends conflicting list and detail codes to user review without discarding list candidates', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-code-conflict')
      database.exec(`
        INSERT INTO videos (id, code, title) VALUES
          (33, 'LIST-1', 'First list candidate'),
          (34, 'LIST-1', 'Second list candidate'),
          (35, 'DETAIL-2', 'Detail-page candidate');
      `)
      repository.createJob({
        runId: 'run-code-conflict',
        idempotencyKey: 'start-code-conflict',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-code-conflict',
        pageKey: 'only-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'LIST-1', detailUrl: 'https://example.test/video/conflict' }],
        nextPageUrls: [],
        terminal: true
      })
      const item = database.prepare(
        "SELECT id, revision FROM playlist_import_items WHERE run_id = 'run-code-conflict'"
      ).get() as { id: number; revision: number }

      const waiting = repository.checkpointDetailIdentity({
        runId: 'run-code-conflict',
        itemId: item.id,
        expectedItemRevision: item.revision,
        detailCode: 'DETAIL-2',
        identity: {},
        evidenceRef: '.javdex/browser/detail.json'
      })

      assert.equal(waiting.phase, 'waiting_user')
      assert.deepEqual(
        waiting.attention?.kind === 'identity-review'
          ? waiting.attention.items[0].candidates.map((candidate) => candidate.videoId)
          : [],
        [33, 34, 35]
      )
      assert.deepEqual(
        waiting.attention?.kind === 'identity-review'
          ? waiting.attention.items[0].conflict
          : undefined,
        { kind: 'code-mismatch', listCode: 'LIST-1', detailCode: 'DETAIL-2' }
      )
      assert.equal(waiting.preview?.items[0].code, 'LIST-1')

      const ready = repository.resolveIdentityDecisions({
        runId: 'run-code-conflict',
        expectedRevision: waiting.revision,
        idempotencyKey: 'choose-detail-code-candidate',
        decisions: [{ itemId: item.id, choice: { kind: 'existing', videoId: 35 } }]
      })
      assert.equal(ready.phase, 'ready-to-apply')
      const outcome = repository.apply('run-code-conflict', 'apply-code-conflict')
      assert.equal(outcome.reusedVideos, 1)
      assert.equal(repository.snapshot('run-code-conflict')?.phase, 'completed')
    } finally {
      database.close()
    }
  })

  it('rejects a stale direct-code decision when a duplicate appears before apply', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-stale-direct')
      database.prepare("INSERT INTO videos (id, code) VALUES (61, 'STALE-1')").run()
      repository.createJob({
        runId: 'run-stale-direct',
        idempotencyKey: 'start-stale-direct',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const ready = repository.checkpointStaticPage({
        runId: 'run-stale-direct',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'STALE-1', detailUrl: 'https://example.test/video/stale' }],
        nextPageUrls: [],
        terminal: true
      })
      assert.equal(ready.phase, 'ready-to-apply')

      database.prepare("INSERT INTO videos (id, code) VALUES (62, 'STALE-1')").run()
      assert.throws(
        () => repository.apply('run-stale-direct', 'apply-stale-direct'),
        /IMPORT_PREVIEW_STALE/
      )
      assert.equal(repository.snapshot('run-stale-direct')?.phase, 'resolving-identities')
      assert.equal(
        (database.prepare('SELECT COUNT(*) AS n FROM playlists').get() as { n: number }).n,
        0
      )
    } finally {
      database.close()
    }
  })

  it('reopens identity resolution when another video claims the detail URL before apply', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-detail-owner-stale')
      database.exec(`
        INSERT INTO videos (id, code, title) VALUES
          (63, 'OWNER-1', 'Number candidate'),
          (64, 'OTHER-2', 'Detail URL owner');
      `)
      repository.createJob({
        runId: 'run-detail-owner-stale',
        idempotencyKey: 'detail-owner-stale',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const ready = repository.checkpointStaticPage({
        runId: 'run-detail-owner-stale',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'OWNER-1', detailUrl: 'https://example.test/video/owner-1' }],
        nextPageUrls: [],
        terminal: true
      })
      assert.equal(ready.phase, 'ready-to-apply')

      database.prepare(
        `INSERT INTO video_links (video_id, label, url, normalized_url, position)
         VALUES (64, 'example.test', ?, ?, 0)`
      ).run('https://example.test/video/owner-1', 'https://example.test/video/owner-1')

      assert.throws(
        () => repository.apply('run-detail-owner-stale', 'apply-stale-owner'),
        /IMPORT_PREVIEW_STALE/
      )
      const resolving = repository.snapshot('run-detail-owner-stale')!
      assert.equal(resolving.phase, 'resolving-identities')
      const work = repository.nextBrowserWork('run-detail-owner-stale')
      assert.equal(work?.kind, 'detail')
      assert.deepEqual(
        work?.kind === 'detail' ? work.candidates.map((candidate) => candidate.videoId) : [],
        [63, 64]
      )

      const reconciled = repository.checkpointDetailIdentity({
        runId: 'run-detail-owner-stale',
        itemId: work!.kind === 'detail' ? work.itemId : 0,
        expectedItemRevision: work!.kind === 'detail' ? work.itemRevision : 0,
        detailCode: 'OWNER-1',
        identity: {},
        evidenceRef: '.javdex/browser/detail.json'
      })
      assert.equal(reconciled.phase, 'waiting_user')
      assert.deepEqual(
        reconciled.attention?.kind === 'identity-review'
          ? reconciled.attention.items[0].candidates.map((candidate) => candidate.videoId)
          : [],
        [63, 64]
      )
      const confirmed = repository.resolveIdentityDecisions({
        runId: 'run-detail-owner-stale',
        expectedRevision: reconciled.revision,
        idempotencyKey: 'choose-number-consistent-owner',
        decisions: [{
          itemId: work!.kind === 'detail' ? work.itemId : 0,
          choice: { kind: 'existing', videoId: 63 }
        }]
      })
      assert.equal(confirmed.phase, 'ready-to-apply')
      const outcome = repository.apply('run-detail-owner-stale', 'apply-reconciled-owner')
      assert.equal(outcome.reusedVideos, 1)
      assert.equal(
        (database.prepare(
          "SELECT resolved_video_id FROM playlist_import_items WHERE run_id = 'run-detail-owner-stale'"
        ).get() as { resolved_video_id: number }).resolved_video_id,
        63
      )
    } finally {
      database.close()
    }
  })

  it('returns target-library tiebreaks to identity review when memberships become stale', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-stale-tiebreak')
      database.exec(`
        INSERT INTO videos (id, code) VALUES (71, 'STALE-2'), (72, 'STALE-2');
      `)
      ensureVideoMembership({ libraryId: 1, videoId: 71, addedVia: 'manual' }, database)
      repository.createJob({
        runId: 'run-stale-tiebreak',
        idempotencyKey: 'start-stale-tiebreak',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-stale-tiebreak',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'STALE-2', detailUrl: 'https://example.test/video/stale-2' }],
        nextPageUrls: [],
        terminal: true
      })
      const item = database.prepare(
        "SELECT id, revision FROM playlist_import_items WHERE run_id = 'run-stale-tiebreak'"
      ).get() as { id: number; revision: number }
      const ready = repository.checkpointDetailIdentity({
        runId: 'run-stale-tiebreak',
        itemId: item.id,
        expectedItemRevision: item.revision,
        detailCode: 'STALE-2',
        identity: {},
        evidenceRef: '.javdex/browser/detail.json'
      })
      assert.equal(ready.phase, 'ready-to-apply')

      ensureVideoMembership({ libraryId: 1, videoId: 72, addedVia: 'manual' }, database)
      assert.throws(
        () => repository.apply('run-stale-tiebreak', 'apply-stale-tiebreak'),
        /IMPORT_PREVIEW_STALE/
      )
      const stale = repository.snapshot('run-stale-tiebreak')!
      assert.equal(stale.phase, 'waiting_user')
      assert.equal(stale.attention?.kind, 'identity-review')
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM playlists').get() as { n: number }).n, 0)
    } finally {
      database.close()
    }
  })

  it('persists an unexpected transactional apply failure and retries it atomically', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-apply-retry')
      repository.createJob({
        runId: 'run-apply-retry',
        idempotencyKey: 'apply-retry',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create', requestedName: 'Retry apply' }
      })
      repository.checkpointStaticPage({
        runId: 'run-apply-retry',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'RETRY-1', detailUrl: 'https://example.test/video/retry-1' }],
        nextPageUrls: [],
        terminal: true
      })
      database.exec(`
        CREATE TRIGGER fail_playlist_import_once
        BEFORE INSERT ON playlists
        BEGIN
          SELECT RAISE(ABORT, 'transient apply failure');
        END;
      `)

      assert.throws(() => repository.apply('run-apply-retry', 'apply-retry-1'), /APPLY_FAILED/)
      const failed = repository.snapshot('run-apply-retry')!
      assert.equal(failed.phase, 'ready-to-apply')
      assert.equal(failed.error?.code, 'APPLY_FAILED')
      assert.equal(failed.error?.retryable, true)
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM playlists').get() as { n: number }).n, 0)
      assert.equal((database.prepare("SELECT COUNT(*) AS n FROM videos WHERE code = 'RETRY-1'").get() as { n: number }).n, 0)

      database.exec('DROP TRIGGER fail_playlist_import_once')
      const outcome = repository.apply('run-apply-retry', 'apply-retry-2')
      assert.equal(outcome.createdVideos, 1)
      assert.equal(repository.snapshot('run-apply-retry')?.phase, 'completed')
      assert.equal(repository.snapshot('run-apply-retry')?.error, undefined)
    } finally {
      database.close()
    }
  })

  it('lets a unique strong detail match override the target library preference', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-strong-match')
      database.exec(`
        INSERT INTO media_libraries (id, name, status) VALUES (2, 'Other', 'active');
        INSERT INTO media_library_configs (library_id) VALUES (2);
        INSERT INTO videos (id, code) VALUES (41, 'DUP-2'), (42, 'DUP-2');
      `)
      ensureVideoMembership({ libraryId: 1, videoId: 41, addedVia: 'manual' }, database)
      ensureVideoMembership({ libraryId: 2, videoId: 42, addedVia: 'manual' }, database)
      database.prepare(
        `INSERT INTO video_links (video_id, label, url, normalized_url, position)
         VALUES (42, 'example.test', ?, ?, 0)`
      ).run('https://example.test/video/dup-2', 'https://example.test/video/dup-2')
      repository.createJob({
        runId: 'run-strong-match',
        idempotencyKey: 'strong-match',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const resolving = repository.checkpointStaticPage({
        runId: 'run-strong-match',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'DUP-2', detailUrl: 'https://example.test/video/dup-2' }],
        nextPageUrls: [],
        terminal: true
      })
      const item = database.prepare(
        "SELECT id, revision FROM playlist_import_items WHERE run_id = 'run-strong-match'"
      ).get() as { id: number; revision: number }

      const ready = repository.checkpointDetailIdentity({
        runId: 'run-strong-match',
        itemId: item.id,
        expectedItemRevision: item.revision,
        detailCode: 'DUP-2',
        identity: {},
        evidenceRef: '.javdex/browser/detail.json'
      })

      assert.equal(resolving.phase, 'resolving-identities')
      assert.equal(ready.phase, 'ready-to-apply')
      assert.equal(
        (database.prepare('SELECT resolved_video_id FROM playlist_import_items WHERE id = ?').get(item.id) as {
          resolved_video_id: number
        }).resolved_video_id,
        42
      )
    } finally {
      database.close()
    }
  })

  it('uses a canonical www detail link as a strong owner signal without duplicating it', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-www-detail-owner')
      database.exec(`
        INSERT INTO videos (id, code, title) VALUES
          (90, 'URL-1', 'URL owner'),
          (91, 'URL-1', 'Other duplicate');
        INSERT INTO video_links (video_id, label, url, normalized_url, position)
        VALUES (
          90, 'example.test',
          'https://www.example.test/video/url-1#details',
          'https://example.test/video/url-1', 0
        );
      `)
      repository.createJob({
        runId: 'run-www-detail-owner',
        idempotencyKey: 'www-detail-owner',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const resolving = repository.checkpointStaticPage({
        runId: 'run-www-detail-owner',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'URL-1', detailUrl: 'https://www.example.test/video/url-1' }],
        nextPageUrls: [],
        terminal: true
      })
      assert.equal(resolving.phase, 'resolving-identities')
      const item = database.prepare(
        "SELECT id, revision FROM playlist_import_items WHERE run_id = 'run-www-detail-owner'"
      ).get() as { id: number; revision: number }
      const ready = repository.checkpointDetailIdentity({
        runId: 'run-www-detail-owner',
        itemId: item.id,
        expectedItemRevision: item.revision,
        detailCode: 'URL-1',
        identity: {},
        evidenceRef: '.javdex/browser/detail.json'
      })
      assert.equal(ready.phase, 'ready-to-apply')
      assert.equal(ready.preview?.items[0]?.resolvedVideo?.id, 90)

      const outcome = repository.apply('run-www-detail-owner', 'apply-www-detail-owner')
      assert.equal(outcome.reusedVideos, 1)
      assert.equal(outcome.relatedLinksAdded, 0)
      assert.equal(
        (database.prepare('SELECT COUNT(*) AS n FROM video_links WHERE video_id = 90')
          .get() as { n: number }).n,
        1
      )
    } finally {
      database.close()
    }
  })

  it('requires user review when independent strong detail signals conflict', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-strong-conflict')
      database.exec(`
        INSERT INTO videos (id, code, title) VALUES
          (43, 'DUP-4', 'Detail URL match'),
          (44, 'DUP-4', 'Source identity match');
        INSERT INTO video_links (video_id, label, url, normalized_url, position)
        VALUES (
          43, 'example.test',
          'https://example.test/video/dup-4',
          'https://example.test/video/dup-4', 0
        );
        INSERT INTO video_sources (video_id, source, external_code, url)
        VALUES (44, 'catalog', 'DUP-4', 'https://catalog.test/item/dup-4#metadata');
      `)
      ensureVideoMembership({ libraryId: 1, videoId: 43, addedVia: 'manual' }, database)
      repository.createJob({
        runId: 'run-strong-conflict',
        idempotencyKey: 'strong-conflict',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-strong-conflict',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'DUP-4', detailUrl: 'https://example.test/video/dup-4' }],
        nextPageUrls: [],
        terminal: true
      })
      const item = database.prepare(
        "SELECT id, revision FROM playlist_import_items WHERE run_id = 'run-strong-conflict'"
      ).get() as { id: number; revision: number }

      const waiting = repository.checkpointDetailIdentity({
        runId: 'run-strong-conflict',
        itemId: item.id,
        expectedItemRevision: item.revision,
        detailCode: 'DUP-4',
        identity: {
          source: 'catalog',
          externalCode: 'DUP-4',
          sourceUrl: 'https://catalog.test/item/dup-4'
        },
        evidenceRef: '.javdex/browser/detail.json'
      })

      assert.equal(waiting.phase, 'waiting_user')
      assert.equal(waiting.attention?.kind, 'identity-review')
      assert.deepEqual(
        waiting.attention?.kind === 'identity-review'
          ? waiting.attention.items[0].candidates.map((candidate) => candidate.videoId)
          : [],
        [43, 44]
      )
    } finally {
      database.close()
    }
  })

  it('keeps a source owner outside the code candidates and blocks target-library tiebreaking', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-source-owner-outside-code')
      database.exec(`
        INSERT INTO videos (id, code, title) VALUES
          (92, 'DUP-7', 'Target-library code match'),
          (93, 'OTHER-7', 'Strong source owner'),
          (96, 'DUP-7', 'Other code match');
        INSERT INTO video_sources (video_id, source, external_code, url)
        VALUES (93, 'catalog', 'OWNER-93', 'https://catalog.test/item/owner-93');
      `)
      ensureVideoMembership({ libraryId: 1, videoId: 92, addedVia: 'manual' }, database)
      repository.createJob({
        runId: 'run-source-owner-outside-code',
        idempotencyKey: 'source-owner-outside-code',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-source-owner-outside-code',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'DUP-7', detailUrl: 'https://example.test/video/dup-7' }],
        nextPageUrls: [],
        terminal: true
      })
      const item = database.prepare(
        "SELECT id, revision FROM playlist_import_items WHERE run_id = 'run-source-owner-outside-code'"
      ).get() as { id: number; revision: number }

      const waiting = repository.checkpointDetailIdentity({
        runId: 'run-source-owner-outside-code',
        itemId: item.id,
        expectedItemRevision: item.revision,
        detailCode: 'DUP-7',
        identity: {
          source: 'catalog',
          externalCode: 'OWNER-93',
          sourceUrl: 'https://catalog.test/item/owner-93'
        },
        evidenceRef: '.javdex/browser/detail.json'
      })

      assert.equal(waiting.phase, 'waiting_user')
      assert.deepEqual(
        waiting.attention?.kind === 'identity-review'
          ? waiting.attention.items[0].candidates.map((candidate) => candidate.videoId)
          : [],
        [92, 93, 96]
      )
    } finally {
      database.close()
    }
  })

  it('invalidates the preview when a new source owner appears before apply', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-source-owner-stale')
      database.exec(`
        INSERT INTO videos (id, code, title) VALUES
          (94, 'DUP-8', 'Initial target match'),
          (96, 'DUP-8', 'Initial other match');
      `)
      ensureVideoMembership({ libraryId: 1, videoId: 94, addedVia: 'manual' }, database)
      repository.createJob({
        runId: 'run-source-owner-stale',
        idempotencyKey: 'source-owner-stale',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-source-owner-stale',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'DUP-8', detailUrl: 'https://example.test/video/dup-8' }],
        nextPageUrls: [],
        terminal: true
      })
      const item = database.prepare(
        "SELECT id, revision FROM playlist_import_items WHERE run_id = 'run-source-owner-stale'"
      ).get() as { id: number; revision: number }
      const ready = repository.checkpointDetailIdentity({
        runId: 'run-source-owner-stale',
        itemId: item.id,
        expectedItemRevision: item.revision,
        detailCode: 'DUP-8',
        identity: { source: 'catalog', externalCode: 'FUTURE-OWNER' },
        evidenceRef: '.javdex/browser/detail.json'
      })
      assert.equal(ready.phase, 'ready-to-apply')
      assert.equal(ready.preview?.items[0]?.resolvedVideo?.id, 94)

      database.exec(`
        INSERT INTO videos (id, code, title) VALUES (95, 'OTHER-8', 'Late source owner');
        INSERT INTO video_sources (video_id, source, external_code, url)
        VALUES (95, 'catalog', 'FUTURE-OWNER', 'https://catalog.test/item/future-owner');
      `)

      assert.throws(
        () => repository.apply('run-source-owner-stale', 'apply-source-owner-stale'),
        /IMPORT_PREVIEW_STALE/
      )
      const stale = repository.snapshot('run-source-owner-stale')!
      assert.equal(stale.phase, 'waiting_user')
      assert.deepEqual(
        stale.attention?.kind === 'identity-review'
          ? stale.attention.items[0].candidates.map((candidate) => candidate.videoId)
          : [],
        [94, 95, 96]
      )
    } finally {
      database.close()
    }
  })

  it('treats source external-code and source-URL evidence as independent signals', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-source-signal-conflict')
      database.exec(`
        INSERT INTO videos (id, code, title) VALUES
          (81, 'DUP-6', 'External-code match'),
          (82, 'DUP-6', 'Source-URL match');
        INSERT INTO video_sources (video_id, source, external_code, url) VALUES
          (81, 'catalog', 'EXT-81', 'https://catalog.test/item/81'),
          (82, 'catalog', 'EXT-82', 'https://catalog.test/item/82');
      `)
      ensureVideoMembership({ libraryId: 1, videoId: 81, addedVia: 'manual' }, database)
      repository.createJob({
        runId: 'run-source-signal-conflict',
        idempotencyKey: 'source-signal-conflict',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-source-signal-conflict',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'DUP-6', detailUrl: 'https://example.test/video/dup-6' }],
        nextPageUrls: [],
        terminal: true
      })
      const item = database.prepare(
        "SELECT id, revision FROM playlist_import_items WHERE run_id = 'run-source-signal-conflict'"
      ).get() as { id: number; revision: number }

      const waiting = repository.checkpointDetailIdentity({
        runId: 'run-source-signal-conflict',
        itemId: item.id,
        expectedItemRevision: item.revision,
        detailCode: 'DUP-6',
        identity: {
          source: 'catalog',
          externalCode: 'EXT-81',
          sourceUrl: 'https://catalog.test/item/82'
        },
        evidenceRef: '.javdex/browser/detail.json'
      })

      assert.equal(waiting.phase, 'waiting_user')
      assert.deepEqual(
        waiting.attention?.kind === 'identity-review'
          ? waiting.attention.items[0].candidates.map((candidate) => candidate.videoId)
          : [],
        [81, 82]
      )
    } finally {
      database.close()
    }
  })

  it('does not use the target library when complete business identity contradicts known candidates', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-business-mismatch')
      database.exec(`
        INSERT INTO organizations (id, main_name) VALUES
          (11, 'Known Publisher'),
          (12, 'Page Publisher');
        INSERT INTO organization_names (
          organization_id, name, normalized_name, type
        ) VALUES
          (11, 'Known Publisher', 'known publisher', 'main'),
          (12, 'Page Publisher', 'page publisher', 'main');
        INSERT INTO organization_name_ownership (normalized_name, organization_id) VALUES
          ('known publisher', 11),
          ('page publisher', 12);
        INSERT INTO videos (
          id, code, title, publisher_organization_id, release_date
        ) VALUES
          (45, 'DUP-5', 'Target candidate', 11, '2020-01-01'),
          (46, 'DUP-5', 'Cross-library candidate', 11, '2021-01-01');
      `)
      ensureVideoMembership({ libraryId: 1, videoId: 45, addedVia: 'manual' }, database)
      repository.createJob({
        runId: 'run-business-mismatch',
        idempotencyKey: 'business-mismatch',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-business-mismatch',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'DUP-5', detailUrl: 'https://example.test/video/dup-5' }],
        nextPageUrls: [],
        terminal: true
      })
      const item = database.prepare(
        "SELECT id, revision FROM playlist_import_items WHERE run_id = 'run-business-mismatch'"
      ).get() as { id: number; revision: number }

      const waiting = repository.checkpointDetailIdentity({
        runId: 'run-business-mismatch',
        itemId: item.id,
        expectedItemRevision: item.revision,
        detailCode: 'DUP-5',
        identity: { publisher: 'Page Publisher', releaseDate: '2024-01-01' },
        evidenceRef: '.javdex/browser/detail.json'
      })

      assert.equal(waiting.phase, 'waiting_user')
      assert.equal(waiting.attention?.kind, 'identity-review')
    } finally {
      database.close()
    }
  })

  it('waits for the user when detail signals leave multiple cross-library candidates', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-user-choice')
      database.exec(`
        INSERT INTO media_libraries (id, name, status) VALUES (2, 'Other', 'active');
        INSERT INTO media_library_configs (library_id) VALUES (2);
        INSERT INTO videos (id, code, title) VALUES
          (51, 'DUP-3', 'First'), (52, 'DUP-3', 'Second');
      `)
      ensureVideoMembership({ libraryId: 2, videoId: 51, addedVia: 'manual' }, database)
      ensureVideoMembership({ libraryId: 2, videoId: 52, addedVia: 'manual' }, database)
      repository.createJob({
        runId: 'run-user-choice',
        idempotencyKey: 'user-choice',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-user-choice',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'DUP-3', detailUrl: 'https://example.test/video/dup-3' }],
        nextPageUrls: [],
        terminal: true
      })
      const item = database.prepare(
        "SELECT id, revision FROM playlist_import_items WHERE run_id = 'run-user-choice'"
      ).get() as { id: number; revision: number }
      const waiting = repository.checkpointDetailIdentity({
        runId: 'run-user-choice',
        itemId: item.id,
        expectedItemRevision: item.revision,
        identity: { code: 'DUP-3' },
        evidenceRef: '.javdex/browser/detail.json'
      })

      assert.equal(waiting.phase, 'waiting_user')
      assert.deepEqual(
        waiting.attention?.kind === 'identity-review'
          ? waiting.attention.items[0].candidates.map((candidate) => candidate.videoId)
          : [],
        [51, 52]
      )
      const ready = repository.resolveIdentityDecisions({
        runId: 'run-user-choice',
        expectedRevision: waiting.revision,
        idempotencyKey: 'choose-52',
        decisions: [{ itemId: item.id, choice: { kind: 'existing', videoId: 52 } }]
      })
      const replay = repository.resolveIdentityDecisions({
        runId: 'run-user-choice',
        expectedRevision: waiting.revision,
        idempotencyKey: 'choose-52',
        decisions: [{ itemId: item.id, choice: { kind: 'existing', videoId: 52 } }]
      })
      assert.equal(ready.phase, 'ready-to-apply')
      assert.equal(replay.phase, 'ready-to-apply')
      assert.throws(
        () => repository.resolveIdentityDecisions({
          runId: 'run-user-choice',
          expectedRevision: waiting.revision,
          idempotencyKey: 'choose-again',
          decisions: [{ itemId: item.id, choice: { kind: 'existing', videoId: 51 } }]
        }),
        /PLAYLIST_IMPORT_PHASE_INVALID|RUN_REVISION_STALE/
      )
      const outcome = repository.apply('run-user-choice', 'apply-user-choice')
      assert.equal(outcome.userSelectedReuses, 1)
      assert.equal(outcome.crossLibraryReuses, 1)
      assert.deepEqual(outcome.reuseLibraryDistribution, [{
        libraryId: 2,
        libraryName: 'Other',
        reusedVideos: 1
      }])
    } finally {
      database.close()
    }
  })

  it('replays an identical page checkpoint and makes changed content recoverable', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-replay')
      repository.createJob({
        runId: 'run-replay',
        idempotencyKey: 'start-replay',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const checkpoint: PlaylistImportPageCheckpointInput = {
        runId: 'run-replay',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'ONE-1', detailUrl: 'https://example.test/video/1' }],
        nextPageUrls: ['https://example.test/list?page=2'],
        terminal: false
      }
      repository.checkpointStaticPage(checkpoint)
      repository.checkpointStaticPage(checkpoint)
      assert.equal(
        (database.prepare('SELECT COUNT(*) AS n FROM playlist_import_page_items').get() as { n: number }).n,
        1
      )
      const changed = repository.checkpointStaticPage({
          ...checkpoint,
          items: [{ code: 'TWO-2', detailUrl: 'https://example.test/video/2' }]
      })
      assert.equal(changed.phase, 'discovering-list')
      assert.equal(changed.error?.code, 'PAGE_CHANGED')
      assert.equal(changed.error?.retryable, true)
      assert.equal(
        (database.prepare('SELECT COUNT(*) AS n FROM playlist_import_page_items').get() as { n: number }).n,
        1
      )
      const replayed = repository.checkpointStaticPage({
        ...checkpoint,
        items: [{ code: 'TWO-2', detailUrl: 'https://example.test/video/2' }]
      })
      assert.equal(replayed.error, undefined)
      assert.deepEqual(
        (database.prepare(
          `SELECT item.normalized_code FROM playlist_import_page_items occurrence
           JOIN playlist_import_items item ON item.id = occurrence.item_id`
        ).all() as Array<{ normalized_code: string }>).map((row) => row.normalized_code),
        ['TWO-2']
      )
    } finally {
      database.close()
    }
  })

  it('makes a changed replay of a dynamic operation recoverable without duplicating the batch', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-dynamic-replay')
      repository.createJob({
        runId: 'run-dynamic-replay',
        idempotencyKey: 'dynamic-replay',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const checkpoint: PlaylistImportVirtualBatchCheckpointInput = {
        runId: 'run-dynamic-replay',
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        initialViewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        enumerationKind: 'load-more',
        operationKey: 'load-more:start',
        batchOrder: 0,
        viewRevision: '1:1:0',
        positionMode: 'overlap',
        containerFingerprint: 'list',
        scrollState: {
          scrollTop: 0,
          scrollHeight: 500,
          clientHeight: 500,
          atStart: true,
          atEnd: false,
          moved: false,
          settled: true
        },
        items: [{
          occurrenceKey: '0:https://example.test/video/1',
          absolutePosition: 0,
          code: 'ONE-1',
          detailUrl: 'https://example.test/video/1'
        }],
        accumulatedSequenceDigest: 'one',
        terminalProbeCount: 0,
        seal: false,
        nextPageUrls: []
      }
      repository.checkpointVirtualBatch(checkpoint)

      const changed = repository.checkpointVirtualBatch({
        ...checkpoint,
        items: [{
          occurrenceKey: '0:https://example.test/video/2',
          absolutePosition: 0,
          code: 'TWO-2',
          detailUrl: 'https://example.test/video/2'
        }],
        accumulatedSequenceDigest: 'two'
      })
      assert.equal(changed.phase, 'discovering-list')
      assert.equal(changed.error?.code, 'PAGE_CHANGED')
      assert.equal(changed.error?.retryable, true)
      assert.equal((database.prepare(
        `SELECT COUNT(*) AS n FROM playlist_import_scroll_batches batch
         JOIN playlist_import_pages page ON page.id = batch.page_id
         WHERE page.run_id = 'run-dynamic-replay'`
      ).get() as { n: number }).n, 1)

      const replayed = repository.checkpointVirtualBatch({
        ...checkpoint,
        items: [{
          occurrenceKey: '0:https://example.test/video/2',
          absolutePosition: 0,
          code: 'TWO-2',
          detailUrl: 'https://example.test/video/2'
        }],
        accumulatedSequenceDigest: 'two'
      })
      assert.equal(replayed.error, undefined)
      assert.deepEqual(
        (database.prepare(
          `SELECT item.normalized_code FROM playlist_import_page_items occurrence
           JOIN playlist_import_items item ON item.id = occurrence.item_id`
        ).all() as Array<{ normalized_code: string }>).map((row) => row.normalized_code),
        ['TWO-2']
      )
    } finally {
      database.close()
    }
  })

  it('rolls a changed sealed dynamic page back with downstream frontiers and orphan items', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-dynamic-downstream-replay')
      repository.createJob({
        runId: 'run-dynamic-downstream-replay',
        idempotencyKey: 'dynamic-downstream-replay',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const first = {
        runId: 'run-dynamic-downstream-replay',
        pageKey: 'dynamic-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        initialViewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        enumerationKind: 'load-more' as const,
        operationKey: 'load-more:start',
        batchOrder: 0,
        viewRevision: '1:1:0',
        positionMode: 'overlap' as const,
        containerFingerprint: 'list',
        scrollState: {
          scrollTop: 0,
          scrollHeight: 500,
          clientHeight: 500,
          atStart: true,
          atEnd: true,
          moved: false,
          settled: true
        },
        items: [{
          occurrenceKey: '0:https://example.test/video/shared',
          absolutePosition: 0,
          code: 'SHARED-OLD',
          detailUrl: 'https://example.test/video/shared'
        }],
        accumulatedSequenceDigest: 'old',
        terminalProbeCount: 0,
        seal: true,
        nextPageUrls: ['https://example.test/list?page=2']
      }
      repository.checkpointVirtualBatch(first)
      repository.checkpointStaticPage({
        runId: first.runId,
        pageKey: 'page-2',
        pageOrder: 1,
        pageUrl: 'https://example.test/list?page=2',
        documentRevision: '1:2',
        viewRevision: '1:2:0',
        evidenceRef: '.javdex/browser/page-2.json',
        items: [{ code: 'SHARED-OLD', detailUrl: 'https://example.test/video/shared' }],
        nextPageUrls: ['https://example.test/list?page=3'],
        terminal: false
      })
      const changed = repository.checkpointVirtualBatch({
        ...first,
        items: [{
          occurrenceKey: '0:https://example.test/video/new',
          absolutePosition: 0,
          code: 'NEW-1',
          detailUrl: 'https://example.test/video/new'
        }],
        accumulatedSequenceDigest: 'new'
      })
      assert.equal(changed.error?.code, 'PAGE_CHANGED')
      const replayed = repository.checkpointVirtualBatch({
        ...first,
        items: [{
          occurrenceKey: '0:https://example.test/video/new',
          absolutePosition: 0,
          code: 'NEW-1',
          detailUrl: 'https://example.test/video/new'
        }],
        accumulatedSequenceDigest: 'new'
      })
      assert.equal(replayed.error, undefined)
      assert.deepEqual(
        (database.prepare(
          'SELECT normalized_code FROM playlist_import_items WHERE run_id = ? ORDER BY id'
        ).all(first.runId) as Array<{ normalized_code: string }>).map((row) => row.normalized_code),
        ['NEW-1']
      )
      assert.equal((database.prepare(
        'SELECT COUNT(*) AS value FROM playlist_import_pages WHERE run_id = ? AND page_order > 0'
      ).get(first.runId) as { value: number }).value, 0)
      assert.equal((database.prepare(
        `SELECT status FROM playlist_import_frontier
         WHERE run_id = ? AND canonical_key = ?`
      ).get(first.runId, 'url:https://example.test/list?page=2') as { status: string }).status, 'pending')
      assert.equal((database.prepare(
        `SELECT COUNT(*) AS value FROM playlist_import_frontier
         WHERE run_id = ? AND canonical_key = ?`
      ).get(first.runId, 'url:https://example.test/list?page=3') as { value: number }).value, 0)
    } finally {
      database.close()
    }
  })

  it('rejects a playlist name submitted after the first logical page', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-late-name')
      repository.createJob({
        runId: 'run-late-name',
        idempotencyKey: 'start-late-name',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.checkpointStaticPage({
        runId: 'run-late-name',
        pageKey: 'page-1',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/page-1.json',
        suggestedPlaylistName: 'First name',
        items: [{ code: 'LATE-1', detailUrl: 'https://example.test/video/1' }],
        nextPageUrls: ['https://example.test/list?page=2'],
        terminal: false
      })

      assert.throws(() => repository.checkpointStaticPage({
        runId: 'run-late-name',
        pageKey: 'page-2',
        pageOrder: 1,
        pageUrl: 'https://example.test/list?page=2',
        documentRevision: '1:2',
        viewRevision: '1:2:0',
        evidenceRef: '.javdex/browser/page-2.json',
        suggestedPlaylistName: 'Second name',
        items: [{ code: 'LATE-2', detailUrl: 'https://example.test/video/2' }],
        nextPageUrls: [],
        terminal: true
      }), /PLAYLIST_IMPORT_NAME_ONLY_FIRST_PAGE/)
    } finally {
      database.close()
    }
  })

  it('persists and resumes a browser handoff without losing the current list frontier', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-handoff')
      repository.createJob({
        runId: 'run-handoff',
        idempotencyKey: 'start-handoff',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const waiting = repository.setBrowserHandoff({
        runId: 'run-handoff',
        requestId: 'handoff-1',
        reason: 'human_verification',
        prompt: '请完成人机验证'
      })
      assert.equal(waiting.phase, 'waiting_user')
      assert.deepEqual(waiting.attention, {
        kind: 'browser-handoff',
        requestId: 'handoff-1',
        reason: 'human_verification',
        prompt: '请完成人机验证'
      })

      const resumed = repository.resumeBrowser('run-handoff', 'handoff-1', 'resume-1')
      const replay = repository.resumeBrowser('run-handoff', 'handoff-1', 'resume-1')
      assert.equal(resumed.phase, 'discovering-list')
      assert.equal(replay.phase, 'discovering-list')
      assert.equal(resumed.attention, undefined)
      assert.equal(repository.nextBrowserWork('run-handoff')?.url, 'https://example.test/list')

      const retryWaiting = repository.setBrowserHandoff({
        runId: 'run-handoff',
        requestId: 'handoff-2',
        reason: 'human_verification',
        prompt: '首次恢复失败，请重试'
      })
      assert.equal(retryWaiting.attention?.kind, 'browser-handoff')
      assert.equal(
        retryWaiting.attention?.kind === 'browser-handoff'
          ? retryWaiting.attention.requestId
          : undefined,
        'handoff-2'
      )
      const retried = repository.resumeBrowser('run-handoff', 'handoff-2', 'resume-2')
      assert.equal(retried.phase, 'discovering-list')
      assert.equal(retried.attention, undefined)
    } finally {
      database.close()
    }
  })

  it('fails an expired browser handoff before persisting a resume checkpoint', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-expired-handoff')
      repository.createJob({
        runId: 'run-expired-handoff',
        idempotencyKey: 'start-expired-handoff',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      repository.setBrowserHandoff({
        runId: 'run-expired-handoff',
        requestId: 'handoff-expired',
        reason: 'login',
        prompt: '请登录'
      })
      database.prepare(
        'UPDATE playlist_import_jobs SET created_at = ? WHERE run_id = ?'
      ).run('2000-01-01T00:00:00.000Z', 'run-expired-handoff')

      const failed = repository.resumeBrowser(
        'run-expired-handoff',
        'handoff-expired',
        'resume-expired'
      )

      assert.equal(failed.phase, 'failed')
      assert.equal(failed.error?.code, 'LIMIT_REACHED')
      assert.equal((database.prepare(
        `SELECT COUNT(*) AS value FROM agent_product_journal
         WHERE run_id = ? AND event_type = 'playlist-import.browser-resumed'`
      ).get('run-expired-handoff') as { value: number }).value, 0)
    } finally {
      database.close()
    }
  })

  it('durably checkpoints overlapping virtual windows before sealing a continuous list', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-virtual')
      repository.createJob({
        runId: 'run-virtual',
        idempotencyKey: 'virtual',
        sourceUrl: 'https://example.test/virtual',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const base = {
        runId: 'run-virtual',
        pageKey: 'virtual-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/virtual',
        documentRevision: '2:1',
        initialViewRevision: '2:1:0',
        positionMode: 'attribute' as const,
        containerFingerprint: 'list-1',
        nextPageUrls: [],
        declaredTotalItems: 6,
        declaredTotalPages: 1
      }
      const first = repository.checkpointVirtualBatch({
        ...base,
        evidenceRef: '.javdex/browser/window-0.json',
        suggestedPlaylistName: 'Virtual collection',
        operationKey: 'window-0',
        batchOrder: 0,
        viewRevision: '2:1:0',
        scrollState: {
          scrollTop: 0,
          scrollHeight: 1_200,
          clientHeight: 300,
          atStart: true,
          atEnd: false,
          moved: false,
          settled: true
        },
        items: [0, 1, 2].map((position) => ({
          occurrenceKey: `pos:${position}`,
          absolutePosition: position,
          code: `V-${position}`,
          detailUrl: `https://example.test/video/${position}`
        })),
        accumulatedSequenceDigest: 'digest-0-2',
        terminalProbeCount: 0,
        seal: false
      })
      assert.equal(first.progress.pagesRead, 0)
      assert.equal(first.progress.scrollWindowsRead, 1)
      assert.equal(
        (database.prepare(
          "SELECT agent_suggested_playlist_name FROM playlist_import_jobs WHERE run_id = 'run-virtual'"
        ).get() as { agent_suggested_playlist_name: string }).agent_suggested_playlist_name,
        'Virtual collection'
      )
      repository.checkpointVirtualBatch({
        ...base,
        evidenceRef: '.javdex/browser/window-1.json',
        operationKey: 'window-1',
        batchOrder: 1,
        viewRevision: '2:1:1',
        scrollState: {
          scrollTop: 300,
          scrollHeight: 1_200,
          clientHeight: 300,
          atStart: false,
          atEnd: false,
          moved: true,
          settled: true
        },
        items: [2, 3].map((position) => ({
          occurrenceKey: `pos:${position}`,
          absolutePosition: position,
          code: `V-${position}`,
          detailUrl: `https://example.test/video/${position}`
        })),
        accumulatedSequenceDigest: 'digest-0-3',
        terminalProbeCount: 0,
        seal: false
      })
      assert.throws(() => repository.checkpointVirtualBatch({
        ...base,
        evidenceRef: '.javdex/browser/window-changed-container.json',
        operationKey: 'window-changed-container',
        batchOrder: 2,
        viewRevision: '2:1:changed',
        containerFingerprint: 'list-2',
        scrollState: {
          scrollTop: 600,
          scrollHeight: 1_200,
          clientHeight: 300,
          atStart: false,
          atEnd: false,
          moved: true,
          settled: true
        },
        items: [3, 4].map((position) => ({
          occurrenceKey: `pos:${position}`,
          absolutePosition: position,
          code: `V-${position}`,
          detailUrl: `https://example.test/video/${position}`
        })),
        accumulatedSequenceDigest: 'changed-container',
        terminalProbeCount: 0,
        seal: false
      }), /DYNAMIC_LIST_CONTAINER_CHANGED/)
      repository.checkpointVirtualBatch({
        ...base,
        evidenceRef: '.javdex/browser/window-2.json',
        operationKey: 'window-2',
        batchOrder: 2,
        viewRevision: '2:1:2',
        scrollState: {
          scrollTop: 900,
          scrollHeight: 1_200,
          clientHeight: 300,
          atStart: false,
          atEnd: true,
          moved: false,
          settled: true
        },
        items: [3, 4, 5].map((position) => ({
          occurrenceKey: `pos:${position}`,
          absolutePosition: position,
          code: position === 5 ? 'V-0' : `V-${position}`,
          detailUrl: position === 5
            ? 'https://example.test/video/0'
            : `https://example.test/video/${position}`
        })),
        accumulatedSequenceDigest: 'digest-0-5',
        terminalProbeCount: 1,
        seal: false
      })
      const sealed = repository.checkpointVirtualBatch({
        ...base,
        evidenceRef: '.javdex/browser/window-3.json',
        operationKey: 'window-3',
        batchOrder: 3,
        viewRevision: '2:1:3',
        scrollState: {
          scrollTop: 900,
          scrollHeight: 1_200,
          clientHeight: 300,
          atStart: false,
          atEnd: true,
          moved: false,
          settled: true
        },
        items: [3, 4, 5].map((position) => ({
          occurrenceKey: `pos:${position}`,
          absolutePosition: position,
          code: position === 5 ? 'V-0' : `V-${position}`,
          detailUrl: position === 5
            ? 'https://example.test/video/0'
            : `https://example.test/video/${position}`
        })),
        accumulatedSequenceDigest: 'digest-0-5',
        terminalProbeCount: 2,
        seal: true
      })

      assert.equal(sealed.phase, 'ready-to-apply')
      assert.equal(sealed.progress.pagesRead, 1)
      assert.equal(sealed.progress.scrollWindowsRead, 4)
      assert.equal(sealed.progress.sourceItems, 6)
      assert.equal(sealed.progress.uniqueItems, 5)
      assert.equal(sealed.progress.plannedCreates, 5)
      assert.equal(
        (database.prepare('SELECT COUNT(*) AS n FROM playlist_import_page_items').get() as { n: number }).n,
        6
      )
    } finally {
      database.close()
    }
  })

  it('persists host-owned load-more batches and seals only after the control disappears', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-load-more')
      repository.createJob({
        runId: 'run-load-more',
        idempotencyKey: 'load-more',
        sourceUrl: 'https://example.test/incremental',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const base = {
        runId: 'run-load-more',
        pageKey: 'load-more-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/incremental',
        documentRevision: '3:1',
        initialViewRevision: '3:1:0',
        enumerationKind: 'load-more' as const,
        positionMode: 'overlap' as const,
        containerFingerprint: 'incremental-list',
        terminalProbeCount: 0,
        declaredTotalItems: 4,
        declaredTotalPages: 1
      }
      const item = (position: number) => ({
        occurrenceKey: `${position}:https://example.test/video/${position}`,
        absolutePosition: position,
        code: `L-${position}`,
        detailUrl: `https://example.test/video/${position}`
      })
      repository.checkpointVirtualBatch({
        ...base,
        evidenceRef: '.javdex/browser/load-more-0.json',
        operationKey: 'load-more-0',
        batchOrder: 0,
        viewRevision: '3:1:0',
        scrollState: {
          scrollTop: 0,
          scrollHeight: 500,
          clientHeight: 500,
          atStart: true,
          atEnd: false,
          moved: false,
          settled: true
        },
        items: [item(0), item(1)],
        accumulatedSequenceDigest: 'load-more-0',
        seal: false,
        nextPageUrls: [],
        containerContract: {
          plan: { candidateSelector: '.item', detailLinkSelector: 'a' },
          advance: {
            kind: 'load-more',
            selector: '.load-more',
            afterExhausted: { kind: 'terminal', reason: 'load-more-control-exhausted' }
          }
        }
      })
      const open = repository.openDynamicPage('run-load-more')
      assert.equal(open?.enumerationKind, 'load-more')
      assert.equal(open?.nextBatchOrder, 1)
      assert.deepEqual(open?.batches[0].occurrenceKeys, [item(0).occurrenceKey, item(1).occurrenceKey])

      const sealed = repository.checkpointVirtualBatch({
        ...base,
        evidenceRef: '.javdex/browser/load-more-1.json',
        operationKey: 'load-more-1',
        batchOrder: 1,
        viewRevision: '3:1:1',
        scrollState: {
          scrollTop: 0,
          scrollHeight: 900,
          clientHeight: 500,
          atStart: false,
          atEnd: true,
          moved: true,
          settled: true
        },
        items: [item(0), item(1), item(2), item(3)],
        accumulatedSequenceDigest: 'load-more-0-3',
        seal: true,
        nextPageUrls: []
      })
      assert.equal(sealed.phase, 'ready-to-apply')
      assert.equal(sealed.progress.pagesRead, 1)
      assert.equal(sealed.progress.scrollWindowsRead, 0)
      assert.equal(sealed.progress.sourceItems, 4)
      assert.equal(repository.openDynamicPage('run-load-more'), null)
    } finally {
      database.close()
    }
  })

  it('persists load-more no-progress and fails instead of retrying the same action', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-load-more-stalled')
      repository.createJob({
        runId: 'run-load-more-stalled',
        idempotencyKey: 'load-more-stalled',
        sourceUrl: 'https://example.test/incremental',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const item = {
        occurrenceKey: '0:https://example.test/video/0',
        absolutePosition: 0,
        code: 'STALL-1',
        detailUrl: 'https://example.test/video/0'
      }
      const base = {
        runId: 'run-load-more-stalled',
        pageKey: 'load-more-page',
        pageOrder: 0,
        pageUrl: 'https://example.test/incremental',
        documentRevision: '3:1',
        initialViewRevision: '3:1:0',
        enumerationKind: 'load-more' as const,
        positionMode: 'overlap' as const,
        containerFingerprint: 'incremental-list',
        terminalProbeCount: 0,
        nextPageUrls: []
      }
      repository.checkpointVirtualBatch({
        ...base,
        evidenceRef: '.javdex/browser/load-more-0.json',
        operationKey: 'load-more-0',
        batchOrder: 0,
        viewRevision: '3:1:0',
        scrollState: {
          scrollTop: 0,
          scrollHeight: 500,
          clientHeight: 500,
          atStart: true,
          atEnd: false,
          moved: false,
          settled: true
        },
        items: [item],
        accumulatedSequenceDigest: 'same',
        seal: false
      })
      const failed = repository.checkpointVirtualBatch({
        ...base,
        evidenceRef: '.javdex/browser/load-more-1.json',
        operationKey: 'load-more-1',
        batchOrder: 1,
        viewRevision: '3:1:1',
        scrollState: {
          scrollTop: 0,
          scrollHeight: 500,
          clientHeight: 500,
          atStart: true,
          atEnd: false,
          moved: false,
          settled: true
        },
        items: [item],
        accumulatedSequenceDigest: 'same',
        seal: false
      })

      assert.equal(failed.phase, 'failed')
      assert.equal(failed.error?.code, 'PAGINATION_LOOP')
      assert.equal((database.prepare(
        "SELECT status FROM playlist_import_frontier WHERE run_id = 'run-load-more-stalled'"
      ).get() as { status: string }).status, 'no-progress')
      assert.equal((database.prepare(
        `SELECT COUNT(*) AS n FROM playlist_import_scroll_batches batch
         JOIN playlist_import_pages page ON page.id = batch.page_id
         WHERE page.run_id = 'run-load-more-stalled'`
      ).get() as { n: number }).n, 1)
    } finally {
      database.close()
    }
  })

  it('fails the run instead of truncating a source that declares totals above the safety budget', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-declared-limit')
      repository.createJob({
        runId: 'run-declared-limit',
        idempotencyKey: 'declared-limit',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const failed = repository.checkpointStaticPage({
        runId: 'run-declared-limit',
        pageKey: 'page-0',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '4:1',
        viewRevision: '4:1:0',
        evidenceRef: '.javdex/browser/page-0.json',
        items: [],
        nextPageUrls: [],
        terminal: true,
        declaredTotalItems: PLAYLIST_IMPORT_DISCOVERY_LIMITS.maxOccurrences + 1
      })
      assert.equal(failed.phase, 'failed')
      assert.equal(failed.error?.code, 'LIMIT_REACHED')
      assert.equal(
        (database.prepare('SELECT COUNT(*) AS count FROM playlist_import_pages').get() as {
          count: number
        }).count,
        0
      )
    } finally {
      database.close()
    }
  })

  it('fails and rolls back a dynamic window above the per-batch candidate budget', () => {
    const { database, repository } = setup()
    try {
      createAgentRun(database, 'run-batch-limit')
      repository.createJob({
        runId: 'run-batch-limit',
        idempotencyKey: 'batch-limit',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const items = Array.from(
        { length: PLAYLIST_IMPORT_DISCOVERY_LIMITS.maxCandidatesPerDynamicBatch + 1 },
        (_, position) => ({
          occurrenceKey: `pos:${position}`,
          absolutePosition: position,
          code: `LIMIT-${position}`,
          detailUrl: `https://example.test/video/${position}`
        })
      )
      const failed = repository.checkpointVirtualBatch({
        runId: 'run-batch-limit',
        pageKey: 'page-0',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '5:1',
        initialViewRevision: '5:1:0',
        evidenceRef: '.javdex/browser/window-0.json',
        operationKey: 'window-0',
        batchOrder: 0,
        viewRevision: '5:1:0',
        positionMode: 'aria-posinset',
        containerFingerprint: 'list',
        scrollState: {
          scrollTop: 0,
          scrollHeight: 10_000,
          clientHeight: 500,
          atStart: true,
          atEnd: false,
          moved: false,
          settled: true
        },
        items,
        accumulatedSequenceDigest: 'too-many',
        terminalProbeCount: 0,
        seal: false,
        nextPageUrls: []
      })
      assert.equal(failed.phase, 'failed')
      assert.equal(failed.error?.code, 'LIMIT_REACHED')
      assert.equal(
        (database.prepare('SELECT COUNT(*) AS count FROM playlist_import_pages').get() as {
          count: number
        }).count,
        0
      )
    } finally {
      database.close()
    }
  })
})
