import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { migrateDatabase } from '../../db/migrations'
import { PlaylistImportModuleImpl, type PlaylistImportRunDriver } from './playlistImportModule'
import { PlaylistImportRepository } from './playlistImportRepository'

function fixture(): {
  database: Database.Database
  module: PlaylistImportModuleImpl
  calls: string[]
  driver: PlaylistImportRunDriver
} {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  migrateDatabase(database)
  const calls: string[] = []
  const driver: PlaylistImportRunDriver = {
    decorate: (snapshot) => ({
      ...snapshot,
      activities: [{
        id: 'action:test',
        kind: 'action',
        status: 'success',
        tool: 'runtime',
        label: '测试活动投影'
      }]
    }),
    create: async (runId, state, onRunPersisted) => {
      calls.push(`create:${runId}`)
      database.prepare(
        `INSERT INTO agent_runs (
          id, use_case, status, config_revision, config_snapshot_json,
          runtime_id, product_state_json, created_at, updated_at
        ) VALUES (?, 'playlist-importer', 'running', '1', '{}', 'pi', ?, ?, ?)`
      ).run(runId, JSON.stringify(state), '2026-01-01', '2026-01-01')
      onRunPersisted()
    },
    start: async (runId) => { calls.push(`start:${runId}`) },
    resume: async (runId) => {
      calls.push(`resume:${runId}`)
      return new PlaylistImportRepository(database).snapshot(runId)!
    },
    retry: async (runId) => {
      calls.push(`retry:${runId}`)
      new PlaylistImportRepository(database).beginSessionRetry(runId)
    },
    finish: async (runId) => { calls.push(`finish:${runId}`) },
    cancel: async (runId) => { calls.push(`cancel:${runId}`) },
    discard: async (runId) => {
      calls.push(`discard:${runId}`)
      database.prepare('DELETE FROM agent_runs WHERE id = ?').run(runId)
    }
  }
  return { database, module: new PlaylistImportModuleImpl(() => database, driver), calls, driver }
}

describe('PlaylistImportModule interface', () => {
  it('returns an initial browser handoff created while opening the source page', async () => {
    const { database, module, driver, calls } = fixture()
    driver.start = async (runId) => {
      new PlaylistImportRepository(database).setBrowserHandoff({
        runId,
        requestId: 'initial-human-verification',
        reason: 'human_verification',
        prompt: '请完成人机验证'
      })
    }
    try {
      const snapshot = await module.start({
        idempotencyKey: 'initial-browser-handoff',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })

      assert.equal(snapshot.phase, 'waiting_user')
      assert.equal(snapshot.attention?.kind, 'browser-handoff')
      assert.equal(calls.some((call) => call.startsWith('discard:')), false)
    } finally {
      database.close()
    }
  })

  it('persists the import job before the run driver can project bootstrap observations', async () => {
    const database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    migrateDatabase(database)
    const driver: PlaylistImportRunDriver = {
      create: async (runId, state, ...callbacks: unknown[]) => {
        database.prepare(
          `INSERT INTO agent_runs (
            id, use_case, status, config_revision, config_snapshot_json,
            runtime_id, product_state_json, created_at, updated_at
          ) VALUES (?, 'playlist-importer', 'running', '1', '{}', 'pi', ?, ?, ?)`
        ).run(runId, JSON.stringify(state), '2026-01-01', '2026-01-01')
        const persistJob = callbacks[0]
        if (typeof persistJob === 'function') persistJob()
        assert.ok(
          new PlaylistImportRepository(database).snapshot(runId),
          'runtime bootstrap observations require an initialized import session'
        )
      },
      start: async () => undefined,
      resume: async (runId) => new PlaylistImportRepository(database).snapshot(runId)!,
      retry: async () => undefined,
      finish: async () => undefined,
      cancel: async () => undefined,
      discard: async () => undefined
    }
    const module = new PlaylistImportModuleImpl(() => database, driver)

    try {
      const snapshot = await module.start({
        idempotencyKey: 'bootstrap-order',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })

      assert.equal(snapshot.phase, 'discovering-list')
    } finally {
      database.close()
    }
  })

  it('returns immediately after accepting one run and replays the same start idempotently', async () => {
    const { database, module, calls } = fixture()
    try {
      const input = {
        idempotencyKey: 'start-key',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' as const, requestedName: 'Imported' }
      }
      const first = await module.start(input)
      const replay = await module.start(input)

      assert.equal(first.phase, 'discovering-list')
      assert.equal(first.frozenInput.autoCreateUnmatchedVideos, true)
      assert.equal(first.frozenInput.saveDetailLinks, true)
      assert.equal(first.frozenInput.saveSourcePlaylistLink, false)
      assert.equal(replay.runId, first.runId)
      assert.equal(calls.filter((call) => call.startsWith('create:')).length, 1)
      assert.equal(calls.filter((call) => call.startsWith('start:')).length, 1)
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM playlists').get() as { n: number }).n, 0)
      assert.equal(module.snapshot()?.runId, first.runId)
      assert.equal(first.activities?.[0]?.kind, 'action')
      assert.equal(module.snapshot()?.activities?.[0]?.id, 'action:test')
    } finally {
      database.close()
    }
  })

  it('allows only one foreground import session at a time', async () => {
    const { database, module } = fixture()
    try {
      const first = await module.start({
        idempotencyKey: 'foreground-first',
        sourceUrl: 'https://example.test/list/1',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      await assert.rejects(module.start({
        idempotencyKey: 'foreground-second',
        sourceUrl: 'https://example.test/list/2',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      }), /PLAYLIST_IMPORT_ALREADY_RUNNING/)

      await module.control(first.runId, {
        kind: 'cancel',
        idempotencyKey: 'cancel-first'
      })
      const second = await module.start({
        idempotencyKey: 'foreground-second',
        sourceUrl: 'https://example.test/list/2',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      assert.notEqual(second.runId, first.runId)
    } finally {
      database.close()
    }
  })

  it('rejects invalid start targets before creating an Agent run', async () => {
    const { database, module, calls } = fixture()
    try {
      await assert.rejects(module.start({
        idempotencyKey: 'missing-library-at-start',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 999,
        destination: { kind: 'create' }
      }), /TARGET_LIBRARY_NOT_FOUND/)
      assert.equal(calls.length, 0)

      database.prepare("UPDATE media_libraries SET status = 'archived' WHERE id = 1").run()
      await assert.rejects(module.start({
        idempotencyKey: 'archived-library-at-start',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      }), /TARGET_LIBRARY_ARCHIVED/)
      assert.equal(calls.length, 0)

      database.prepare("UPDATE media_libraries SET status = 'active' WHERE id = 1").run()
      await assert.rejects(module.start({
        idempotencyKey: 'missing-playlist-at-start',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'append', playlistId: 999 }
      }), /TARGET_PLAYLIST_NOT_FOUND/)
      assert.equal(calls.length, 0)
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number }).n, 0)
    } finally {
      database.close()
    }
  })

  it('includes write options in the idempotent frozen input', async () => {
    const { database, module } = fixture()
    try {
      const first = await module.start({
        idempotencyKey: 'same-options-key',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' },
        autoCreateUnmatchedVideos: false,
        saveDetailLinks: false,
        saveSourcePlaylistLink: true
      })
      assert.equal(first.frozenInput.autoCreateUnmatchedVideos, false)
      assert.equal(first.frozenInput.saveDetailLinks, false)
      assert.equal(first.frozenInput.saveSourcePlaylistLink, true)
      await assert.rejects(module.start({
        idempotencyKey: 'same-options-key',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' },
        autoCreateUnmatchedVideos: false,
        saveDetailLinks: false,
        saveSourcePlaylistLink: false
      }), /IDEMPOTENCY_KEY_REUSED/)
    } finally {
      database.close()
    }
  })

  it('rejects one idempotency key reused for different frozen input', async () => {
    const { database, module } = fixture()
    try {
      await module.start({
        idempotencyKey: 'same',
        sourceUrl: 'https://example.test/list-a',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      await assert.rejects(module.start({
        idempotencyKey: 'same',
        sourceUrl: 'https://example.test/list-b',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      }), /IDEMPOTENCY_KEY_REUSED/)
    } finally {
      database.close()
    }
  })

  it('cancels pre-apply work without creating an empty playlist', async () => {
    const { database, module, calls } = fixture()
    try {
      const started = await module.start({
        idempotencyKey: 'cancel',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const events: string[] = []
      const unsubscribe = module.subscribe((event) => events.push(`${event.runId}:${event.revision}`))
      const cancelled = await module.control(started.runId, {
        kind: 'cancel',
        idempotencyKey: 'cancel-command'
      })
      unsubscribe()

      assert.equal(cancelled.phase, 'cancelled')
      assert.equal(calls.some((call) => call === `cancel:${started.runId}`), true)
      assert.deepEqual(events, [`${started.runId}:${cancelled.revision}`])
      assert.equal((database.prepare('SELECT COUNT(*) AS n FROM playlists').get() as { n: number }).n, 0)
    } finally {
      database.close()
    }
  })

  it('preserves a retryable recovery failure when apply invalidates after identity review', async () => {
    const { database, module, calls, driver } = fixture()
    try {
      database.exec(`
        INSERT INTO videos (id, code, title) VALUES
          (20, 'DIRECT-1', 'Initial direct match'),
          (31, 'DUP-1', 'First duplicate'),
          (32, 'DUP-1', 'Second duplicate');
      `)
      const started = await module.start({
        idempotencyKey: 'stale-identity-apply',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const repository = new PlaylistImportRepository(database)
      repository.checkpointStaticPage({
        runId: started.runId,
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [
          { code: 'DIRECT-1', detailUrl: 'https://example.test/video/direct-1' },
          { code: 'DUP-1', detailUrl: 'https://example.test/video/dup-1' }
        ],
        nextPageUrls: [],
        terminal: true
      })
      const work = repository.nextBrowserWork(started.runId)
      assert.equal(work?.kind, 'detail')
      const waiting = repository.checkpointDetailIdentity({
        runId: started.runId,
        itemId: work!.kind === 'detail' ? work.itemId : 0,
        expectedItemRevision: work!.kind === 'detail' ? work.itemRevision : 0,
        detailCode: 'DUP-1',
        identity: {},
        evidenceRef: '.javdex/browser/detail.json'
      })
      assert.equal(waiting.phase, 'waiting_user')
      database.exec(`
        CREATE TRIGGER add_concurrent_direct_match
        AFTER INSERT ON playlist_import_decisions
        BEGIN
          INSERT INTO videos (id, code, title)
          VALUES (21, 'DIRECT-1', 'Concurrent direct match');
        END;
      `)
      driver.retry = async (runId) => {
        calls.push(`retry:${runId}`)
        repository.markRecoverableError(
          runId,
          'SOURCE_CHANGED',
          '详情来源在恢复时发生变化，请从检查点重试。'
        )
        throw new Error('SOURCE_CHANGED:DETAIL')
      }

      const refreshed = await module.control(started.runId, {
        kind: 'resolve-identities',
        expectedRevision: waiting.revision,
        idempotencyKey: 'choose-duplicate',
        decisions: [{
          itemId: work!.kind === 'detail' ? work.itemId : 0,
          choice: { kind: 'existing', videoId: 31 }
        }]
      })

      assert.equal(refreshed.phase, 'resolving-identities')
      assert.equal(refreshed.error?.code, 'SOURCE_CHANGED')
      assert.equal(refreshed.error?.retryable, true)
      assert.equal(calls.includes(`retry:${started.runId}`), true)
      assert.equal(repository.nextBrowserWork(started.runId)?.kind, 'detail')
      assert.equal((database.prepare('SELECT COUNT(*) AS value FROM playlists').get() as { value: number }).value, 0)
    } finally {
      database.close()
    }
  })

  it('retries a recoverable apply error after the target library becomes active again', async () => {
    const { database, module } = fixture()
    try {
      const started = await module.start({
        idempotencyKey: 'retry-archived-target',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const repository = new PlaylistImportRepository(database)
      const ready = repository.checkpointStaticPage({
        runId: started.runId,
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'NEW-RETRY', detailUrl: 'https://example.test/video/new-retry' }],
        nextPageUrls: [],
        terminal: true
      })
      assert.equal(ready.phase, 'ready-to-apply')
      database.prepare("UPDATE media_libraries SET status = 'archived' WHERE id = 1").run()
      assert.throws(
        () => repository.apply(started.runId, 'initial-archived-apply'),
        /TARGET_LIBRARY_ARCHIVED/
      )
      const blocked = repository.snapshot(started.runId)!
      assert.equal(blocked.error?.retryable, true)

      database.prepare("UPDATE media_libraries SET status = 'active' WHERE id = 1").run()
      const retry = {
        kind: 'retry',
        expectedRevision: blocked.revision,
        idempotencyKey: 'retry-archived-apply'
      } as const
      const completed = await module.control(started.runId, retry)

      assert.equal(completed.phase, 'completed')
      assert.equal(completed.outcome?.createdVideos, 1)
      await assert.rejects(module.control(started.runId, retry), /PLAYLIST_IMPORT_REVISION_STALE/)
      await assert.rejects(module.control(started.runId, {
        ...retry,
        expectedRevision: blocked.revision + 1
      }), /PLAYLIST_IMPORT_RETRY_NOT_AVAILABLE/)
    } finally {
      database.close()
    }
  })

  it('dispatches a same-session retry for a retryable discovery checkpoint', async () => {
    const { database, module, calls } = fixture()
    try {
      const started = await module.start({
        idempotencyKey: 'retry-discovery-stall',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const repository = new PlaylistImportRepository(database)
      const stalled = repository.markRecoverableError(
        started.runId,
        'NETWORK_TIMEOUT',
        '读取外部清单超时。'
      )
      assert.equal(stalled.error?.retryable, true)

      const retry = {
        kind: 'retry',
        expectedRevision: stalled.revision,
        idempotencyKey: 'retry-discovery'
      } as const
      const recovered = await module.control(started.runId, retry)

      assert.equal(recovered.phase, 'discovering-list')
      await assert.rejects(module.control(started.runId, retry), /PLAYLIST_IMPORT_REVISION_STALE/)
      assert.equal(calls.filter((call) => call === `retry:${started.runId}`).length, 1)
    } finally {
      database.close()
    }
  })

  it('clears a missing page checkpoint before dispatching a same-session retry', async () => {
    const { database, module, calls, driver } = fixture()
    try {
      const started = await module.start({
        idempotencyKey: 'retry-page-checkpoint-start',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const repository = new PlaylistImportRepository(database)
      const blocked = repository.markRecoverableError(
        started.runId,
        'PAGE_CHECKPOINT_REQUIRED',
        '离开当前清单页前必须先固化页面检查点。'
      )
      driver.retry = async (runId) => {
        calls.push(`retry:${runId}`)
        const recovering = new PlaylistImportRepository(database).beginSessionRetry(runId)
        assert.equal(recovering.error, undefined)
      }

      const recovered = await module.control(started.runId, {
        kind: 'retry',
        expectedRevision: blocked.revision,
        idempotencyKey: 'retry-page-checkpoint'
      })

      assert.equal(recovered.phase, 'discovering-list')
      assert.equal(recovered.error, undefined)
      assert.equal(calls.filter((call) => call === `retry:${started.runId}`).length, 1)
    } finally {
      database.close()
    }
  })

  it('coalesces concurrent retries with the same idempotency key before recovery side effects', async () => {
    const { database, module, calls, driver } = fixture()
    try {
      const started = await module.start({
        idempotencyKey: 'retry-concurrent-start',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const repository = new PlaylistImportRepository(database)
      const stalled = repository.checkpointScrollStall(started.runId, '等待滚动窗口。')
      let releaseRecovery!: () => void
      const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve })
      driver.retry = async (runId) => {
        calls.push(`retry:${runId}`)
        await recoveryGate
      }
      const command = {
        kind: 'retry',
        expectedRevision: stalled.revision,
        idempotencyKey: 'retry-concurrent'
      } as const

      const first = module.control(started.runId, command)
      const second = module.control(started.runId, command)
      releaseRecovery()
      const [firstResult, secondResult] = await Promise.all([first, second])

      assert.deepEqual(secondResult, firstResult)
      assert.equal(calls.filter((call) => call === `retry:${started.runId}`).length, 1)
      assert.equal((database.prepare(
        `SELECT COUNT(*) AS value FROM agent_product_journal
         WHERE run_id = ? AND event_type = 'playlist-import.retry-control'`
      ).get(started.runId) as { value: number }).value, 0)
    } finally {
      database.close()
    }
  })

  it('keeps discovery retry state in the foreground session instead of the durable product journal', async () => {
    const { database, module, calls, driver } = fixture()
    try {
      const started = await module.start({
        idempotencyKey: 'retry-discovery-restart-start',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const repository = new PlaylistImportRepository(database)
      const blocked = repository.markRecoverableError(
        started.runId,
        'NETWORK_TIMEOUT',
        '读取外部清单超时。'
      )
      driver.retry = async (runId) => {
        calls.push(`retry:${runId}`)
        new PlaylistImportRepository(database).beginSessionRetry(runId)
      }
      const command = {
        kind: 'retry',
        expectedRevision: blocked.revision,
        idempotencyKey: 'retry-discovery-restart'
      } as const

      const recovered = await module.control(started.runId, command)
      assert.equal(repository.snapshot(started.runId)?.error, undefined)
      assert.equal(recovered.phase, 'discovering-list')
      assert.equal(recovered.error, undefined)
      assert.equal(calls.filter((call) => call === `retry:${started.runId}`).length, 1)
      assert.equal((database.prepare(
        `SELECT COUNT(*) AS value FROM agent_product_journal
         WHERE run_id = ? AND event_type = 'playlist-import.retry-control'`
      ).get(started.runId) as { value: number }).value, 0)
    } finally {
      database.close()
    }
  })

  it('applies a foreground retry atomically without reserving a durable retry result', async () => {
    const { database, module } = fixture()
    try {
      const started = await module.start({
        idempotencyKey: 'retry-crash-start',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      })
      const repository = new PlaylistImportRepository(database)
      repository.checkpointStaticPage({
        runId: started.runId,
        pageKey: 'page',
        pageOrder: 0,
        pageUrl: 'https://example.test/list',
        documentRevision: '1:1',
        viewRevision: '1:1:0',
        evidenceRef: '.javdex/browser/list.json',
        items: [{ code: 'NEW-CRASH', detailUrl: 'https://example.test/video/new-crash' }],
        nextPageUrls: [],
        terminal: true
      })
      database.prepare("UPDATE media_libraries SET status = 'archived' WHERE id = 1").run()
      assert.throws(
        () => repository.apply(started.runId, 'initial-crash-apply'),
        /TARGET_LIBRARY_ARCHIVED/
      )
      const blocked = repository.snapshot(started.runId)!
      database.prepare("UPDATE media_libraries SET status = 'active' WHERE id = 1").run()
      const command = {
        kind: 'retry',
        expectedRevision: blocked.revision,
        idempotencyKey: 'retry-crash-window'
      } as const

      const recovered = await module.control(started.runId, command)

      assert.equal(recovered.phase, 'completed')
      assert.equal(recovered.outcome?.createdVideos, 1)
      assert.equal((database.prepare('SELECT COUNT(*) AS value FROM videos WHERE code = ?')
        .get('NEW-CRASH') as { value: number }).value, 1)
      assert.equal((database.prepare(
        `SELECT COUNT(*) AS value
         FROM agent_product_journal
         WHERE run_id = ? AND event_type = 'playlist-import.retry-control'`
      ).get(started.runId) as { value: number }).value, 0)
    } finally {
      database.close()
    }
  })

  it('discards a browser session when driver creation fails before persistence', async () => {
    const database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    migrateDatabase(database)
    const calls: string[] = []
    const driver: PlaylistImportRunDriver = {
      create: async (runId) => {
        calls.push(`create:${runId}`)
        throw new Error('configuration unavailable')
      },
      start: async () => undefined,
      resume: async () => { throw new Error('not used') },
      retry: async () => undefined,
      finish: async () => undefined,
      cancel: async () => undefined,
      discard: async (runId) => { calls.push(`discard:${runId}`) }
    }
    const module = new PlaylistImportModuleImpl(() => database, driver)

    try {
      await assert.rejects(module.start({
        idempotencyKey: 'create-failure-cleanup',
        sourceUrl: 'https://example.test/list',
        targetLibraryId: 1,
        destination: { kind: 'create' }
      }), /configuration unavailable/)
      assert.equal(calls.length, 2)
      assert.match(calls[0], /^create:/u)
      assert.equal(calls[1], calls[0].replace('create:', 'discard:'))
    } finally {
      database.close()
    }
  })
})
