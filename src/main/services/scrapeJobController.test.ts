import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SequentialBatchQueue } from './sequentialBatchQueue'
import type { BatchProgress } from '@shared/batchScrapeTypes'
import {
  createDefaultScrapeJobController,
  createScrapeJobController,
  type ScrapeJobControllerDependencies
} from './scrapeJobController'
import {
  loadBatchScrapeJob,
  resetBatchScrapeJobCache,
  saveBatchScrapeJob
} from './batchScrapeJobStore'

function dependencies(
  overrides: Partial<ScrapeJobControllerDependencies> = {}
): ScrapeJobControllerDependencies {
  let active: string | null = null
  return {
    coordinator: {
      isRunning: () => active !== null,
      getActiveLabel: () => active,
      runExclusive: async <T>(label: string, run: () => Promise<T>): Promise<T> => {
        if (active) throw new Error(`${active}进行中，请稍后再试`)
        active = label
        try {
          return await run()
        } finally {
          active = null
        }
      }
    },
    assertBatchAvailable: () => undefined,
    getBatchState: () => ({ kind: null, progress: null, recoverable: true }),
    videoQueue: {
      isRunning: () => false,
      setListener: () => undefined,
      start: async () => undefined,
      resume: async () => undefined,
      pause: () => undefined,
      discard: () => undefined,
      setCheckpointPort: () => undefined
    },
    actressQueue: {
      isRunning: () => false,
      setListener: () => undefined,
      setAvatarAutoCropListener: () => undefined,
      start: async () => undefined,
      resume: async () => undefined,
      pause: () => undefined,
      discard: () => undefined,
      setCheckpointPort: () => undefined
    },
    scrapeVideo: async () => ({ ok: true, result: { code: 'TEST-001' }, skipped: false }),
    scrapeActress: async () => ({
      status: 'success',
      ok: true,
      result: { mainName: 'Test' },
      skipped: false
    }),
    getActress: () => null,
    hasVideoInLibraryScope: () => true,
    countVideos: () => 0,
    countRematches: () => 0,
    countActresses: () => 0,
    resolveVideoFieldSources: () => ({}),
    pendingVideoScrapes: {
      count: () => 0,
      existingIds: () => [],
      page: () => ({ items: [], total: 0, offset: 0 }),
      get: () => null,
      list: () => [],
      confirm: () => ({ status: 'applied', applied: true, warnings: [] }),
      discard: () => true
    },
    emit: () => undefined,
    rendererAvailable: () => true,
    avatarAutoCropOptions: {
      randomId: () => 'request-1',
      autoCropTimeoutMs: 10
    },
    checkpoints: {
      load: () => null,
      create: () => ({}) as never,
      persist: () => undefined,
      markPaused: () => undefined,
      finish: () => undefined,
      discard: () => undefined,
      toProgress: () => ({
        total: 0,
        current: 0,
        success: 0,
        pending: 0,
        failed: 0,
        currentCode: null,
        status: 'paused',
        logs: []
      }),
      restoreTargets: () => [] as never,
      assertActressRecoverable: (job) => job
    },
    ...overrides
  }
}

describe('ScrapeJobController', () => {
  it('flushes and detaches UI progress on rejection before accepting another batch', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    t.mock.method(console, 'error', () => undefined)
    const base = dependencies()
    let listener: ((progress: BatchProgress) => void) | null = null
    let stale: ((progress: BatchProgress) => void) | null = null
    const progress = (current: number): BatchProgress => ({
      total: 2, current, success: 0, pending: 0, failed: 0,
      currentCode: String(current), status: 'running', logs: []
    })
    const events: BatchProgress[] = []
    let starts = 0
    let cleanedBeforeUnlock = 0
    const controller = createScrapeJobController(dependencies({
      coordinator: {
        ...base.coordinator,
        runExclusive: <T>(label: string, run: () => Promise<T>) => base.coordinator.runExclusive(label, async () => {
          try {
            return await run()
          } finally {
            assert.equal(listener, null, 'listener is removed before the coordinator unlocks')
            cleanedBeforeUnlock++
          }
        })
      },
      videoQueue: {
        ...base.videoQueue,
        setListener: (next) => { listener = next },
        start: async () => {
          starts++
          stale = listener
          listener?.(progress(1))
          listener?.(progress(2))
          throw Error('checkpoint failed')
        }
      },
      emit: (_channel, value) => events.push(value as BatchProgress)
    }))
    controller.startLegacyVideoBatch()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(listener, null)
    assert.equal(events.at(-1)?.current, 2)
    const delivered = events.length
    const oldListener = stale as ((value: BatchProgress) => void) | null
    controller.startLegacyVideoBatch()
    oldListener?.(progress(999))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(starts, 2)
    assert.equal(cleanedBeforeUnlock, 2)
    assert.equal(events.length, delivered * 2)
    assert.ok(events.every((value) => value.current !== 999))
    t.mock.timers.tick(1000)
    assert.equal(events.length, delivered * 2)
  })

  for (const kind of ['video', 'actress'] as const) {
    for (const terminal of ['done', 'paused', 'cancelled'] as const) {
      it(`coalesces ${kind} UI progress while preserving checkpoints and ${terminal} delivery`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const queue = new SequentialBatchQueue<number>()
        const events: Array<{ channel: string; progress: BatchProgress }> = []
        const checkpoints: number[] = []
        const run = async () => {
          await queue.start({
            targets: Array.from({ length: 10000 }, (_, id) => id),
            startMessage: () => 'start', pausedMessage: 'paused', cancelledMessage: 'cancelled',
            doneMessage: () => 'done', getCode: String, exceptionMessage: () => 'error',
            delayAfterTarget: false,
            onCheckpoint: (_progress, next) => checkpoints.push(next),
            runTarget: async (id) => {
              if (id === 101) assert.equal(events.at(-1)?.progress.failed, 1, 'failures reach UI immediately')
              if (id === 9998 && terminal === 'paused') queue.pause()
              if (id === 9998 && terminal === 'cancelled') queue.cancel()
              return id === 100
                ? { status: 'failure', level: 'error', message: 'failed' }
                : { status: 'success', level: 'success', message: 'ok' }
            }
          })
          if (terminal === 'cancelled') queue.resetToIdle()
        }
        const base = dependencies()
        let starts = 0
        let resumes = 0
        const queuePort = {
          ...base[kind === 'video' ? 'videoQueue' : 'actressQueue'],
          isRunning: () => queue.isRunning(),
          setListener: (listener: ((progress: BatchProgress) => void) | null) => queue.setListener(listener),
          start: async () => { starts++; await run() },
          resume: async () => { resumes++; await run() }
        }
        const controller = createScrapeJobController(dependencies({
          ...(kind === 'video' ? { videoQueue: queuePort } : {
            actressQueue: { ...base.actressQueue, ...queuePort }
          }),
          checkpoints: { ...base.checkpoints, load: () => terminal === 'done' ? null : { kind, status: 'paused' } as never },
          emit: (channel, progress) => events.push({ channel, progress: progress as BatchProgress })
        }))
        if (terminal !== 'done') controller.resumeActiveBatch()
        else if (kind === 'video') controller.startVideoBatch('scrape:videoBatchProgress', { status: 'all', fields: ['title'], mode: 'replace' })
        else controller.startActressBatch({ scope: 'all', fields: ['avatar'], mode: 'replace' })
        await new Promise((resolve) => setImmediate(resolve))
        const processed = terminal === 'done' ? 10000 : 9999
        assert.deepEqual(checkpoints.slice(0, processed), Array.from({ length: processed }, (_, id) => id + 1))
        assert.ok(events.length < 100, 'UI delivery is bounded independently of per-item persistence')
        assert.equal(events[0].progress.status, 'running')
        const final = events.filter((event) => event.progress.status === terminal).at(-1)
        assert.equal(final?.progress.success, processed - 1)
        assert.equal(final?.progress.failed, 1)
        assert.equal(final?.progress.currentCode, null)
        assert.equal(events.at(-1)?.progress.status, terminal === 'cancelled' ? 'idle' : terminal)
        assert.ok(events.every((event) => event.channel === (kind === 'video' ? 'scrape:videoBatchProgress' : 'actressScrape:batchProgress')))
        const delivered = events.length
        t.mock.timers.tick(1000)
        assert.equal(events.length, delivered)
        assert.equal(queue.isRunning(), false)
        assert.equal(starts, terminal === 'done' ? 1 : 0)
        assert.equal(resumes, terminal === 'done' ? 0 : 1)
      })
    }
  }

  it('preserves media-library scope through batch count and start orchestration', async () => {
    let countedFilter: unknown
    let startedRequest: unknown
    const base = dependencies()
    const controller = createScrapeJobController(
      dependencies({
        countVideos: (filter) => {
          countedFilter = filter
          return 3
        },
        resolveVideoFieldSources: () => ({
          sourceName: 'Source',
          ratingSourceName: 'Source'
        }),
        videoQueue: {
          ...base.videoQueue,
          start: async (request) => {
            startedRequest = request
          }
        }
      })
    )

    assert.equal(
      controller.countVideoBatch({ libraryId: 7, status: 0, missingFields: ['summary'] }),
      3
    )
    assert.deepEqual(countedFilter, {
      libraryId: 7,
      status: 0,
      missingFields: ['summary'],
      sourceName: 'Source',
      ratingSourceName: 'Source'
    })
    assert.equal(
      controller.startVideoBatch('scrape:videoBatchProgress', {
        libraryId: 7,
        status: 'all',
        videoIds: [11],
        fields: ['title']
      }),
      true
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(startedRequest, {
      libraryId: 7,
      status: 'all',
      videoIds: [11],
      fields: ['title']
    })
  })

  it('rejects a single-video scrape outside the requesting active media library', async () => {
    let scraped = false
    const controller = createScrapeJobController(
      dependencies({
        hasVideoInLibraryScope: (libraryId, videoId) => libraryId === 2 && videoId === 7,
        scrapeVideo: async () => {
          scraped = true
          return { ok: true, result: { code: 'TEST-001' }, skipped: false }
        }
      })
    )

    await assert.rejects(
      () => controller.scrapeOneVideo(8, undefined, ['title'], 'fillEmpty', undefined, 2),
      /影片不属于当前活动媒体库/
    )
    assert.equal(scraped, false)
    await controller.scrapeOneVideo(7, undefined, ['title'], 'fillEmpty', undefined, 2)
    assert.equal(scraped, true)
  })

  it('forwards an explicit director choice and returns structured classification outcomes', async () => {
    let receivedOptions: Parameters<ScrapeJobControllerDependencies['scrapeVideo']>[2]
    const controller = createScrapeJobController(
      dependencies({
        scrapeVideo: async (_videoId, _scraperName, options) => {
          receivedOptions = options
          return {
            ok: true,
            result: { code: 'TEST-001', director: 'Shared Director' },
            skipped: false,
            classifications: [
              {
                field: 'director',
                status: 'matched',
                inputName: 'Shared Director',
                entityId: 42
              }
            ]
          }
        }
      })
    )

    const outcome = await controller.scrapeOneVideo(
      1,
      'Test Source',
      ['director'],
      'replaceIfPresent',
      42
    )

    assert.deepEqual(receivedOptions, {
      fields: ['director'],
      mode: 'replaceIfPresent',
      directorSelectionId: 42,
      directorAmbiguity: 'choice'
    })
    assert.deepEqual(outcome.classifications, [
      {
        field: 'director',
        status: 'matched',
        inputName: 'Shared Director',
        entityId: 42
      }
    ])
  })

  it('serializes single video and actress scrape runs', async () => {
    let release!: () => void
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    const controller = createScrapeJobController(
      dependencies({
        scrapeVideo: async () => {
          await first
          return { ok: true, result: { code: 'TEST-001' }, skipped: false }
        }
      })
    )

    const video = controller.scrapeOneVideo(1)
    await assert.rejects(() => controller.scrapeOneActress(1), /影片刮削进行中/)
    release()
    await video
  })

  it('pauses an interrupted persisted job during initialization', () => {
    const saved: unknown[] = []
    const controller = createScrapeJobController(
      dependencies({
        checkpoints: {
          ...dependencies().checkpoints,
          load: () => ({ kind: 'video', status: 'running' }) as never,
          markPaused: (job) => saved.push({ ...job, status: 'paused' })
        }
      })
    )

    controller.initialize()

    assert.deepEqual(saved, [{ kind: 'video', status: 'paused' }])
  })

  it('recovers an on-disk running checkpoint as paused after restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-scrape-controller-'))
    const previous = process.env.JAVDEX_TEST_USER_DATA
    process.env.JAVDEX_TEST_USER_DATA = root
    resetBatchScrapeJobCache()
    try {
      saveBatchScrapeJob({
        jobId: 'restart-job',
        kind: 'video',
        request: { libraryId: 7, status: 'all', fields: ['title'] },
        targets: [{ id: 1, label: 'TEST-001' }],
        nextIndex: 0,
        success: 0,
        pending: 0,
        failed: 0,
        logs: [],
        total: 1,
        status: 'running',
        updatedAt: '2026-01-01T00:00:00.000Z'
      })
      resetBatchScrapeJobCache()

      createDefaultScrapeJobController({
        emit: () => undefined,
        rendererAvailable: () => false
      }).initialize()
      resetBatchScrapeJobCache()

      assert.equal(loadBatchScrapeJob()?.status, 'paused')
      assert.equal(loadBatchScrapeJob()?.jobId, 'restart-job')
      assert.equal(
        (loadBatchScrapeJob()?.request as { libraryId?: number } | undefined)?.libraryId,
        7
      )
    } finally {
      resetBatchScrapeJobCache()
      if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
      else process.env.JAVDEX_TEST_USER_DATA = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('publishes progress and supports pause, resume, and discard for persisted batches', async () => {
    let listener: ((progress: never) => void) | undefined
    let finishRun: (() => void) | undefined
    let running = false
    let paused = 0
    let resumed = 0
    let discarded = 0
    const events: Array<{ channel: string; payload: unknown }> = []
    const job = { kind: 'video', status: 'paused' } as never
    const controller = createScrapeJobController(
      dependencies({
        checkpoints: {
          ...dependencies().checkpoints,
          load: () => job
        },
        videoQueue: {
          isRunning: () => running,
          setListener: (next) => {
            listener = next as (progress: never) => void
          },
          start: async () => {
            running = true
            await new Promise<void>((resolve) => { finishRun = resolve })
          },
          resume: async () => {
            resumed += 1
            running = true
            await new Promise<void>((resolve) => { finishRun = resolve })
          },
          pause: () => {
            paused += 1
            running = false
            finishRun?.()
          },
          discard: () => {
            discarded += 1
          },
          setCheckpointPort: () => undefined
        },
        emit: (channel, payload) => events.push({ channel, payload })
      })
    )

    assert.equal(
      controller.startVideoBatch('scrape:videoBatchProgress', {
        fields: ['title'],
        mode: 'replace',
        status: 'all'
      }),
      true
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(controller.pauseActiveBatch(), true)
    assert.equal(paused, 1)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(controller.resumeActiveBatch(), true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(resumed, 1)
    listener?.({
      total: 1,
      current: 1,
      success: 1,
      pending: 0,
      failed: 0,
      currentCode: null,
      status: 'done',
      logs: []
    } as never)
    assert.equal(events.at(-1)?.channel, 'scrape:videoBatchProgress')
    running = false
    finishRun?.()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(controller.discardActiveBatch(), true)
    assert.equal(discarded, 1)
  })

  it('prevents starting a scrape batch while automatic crop owns the batch lock', () => {
    const controller = createScrapeJobController(dependencies())
    controller.beginAvatarAutoCropBatch()

    assert.throws(
      () =>
        controller.startActressBatch({
          fields: ['avatar'],
          mode: 'replace',
          filter: { scope: 'all', status: 'all' }
        } as never),
      /批量智能构图正在进行中/
    )
  })
})
