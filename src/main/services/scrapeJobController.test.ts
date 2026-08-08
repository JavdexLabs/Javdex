import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
    countVideos: () => 0,
    countRematches: () => 0,
    countActresses: () => 0,
    resolveVideoFieldSources: () => ({}),
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
        request: { status: 'all', fields: ['title'] },
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
    } finally {
      resetBatchScrapeJobCache()
      if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
      else process.env.JAVDEX_TEST_USER_DATA = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('publishes progress and supports pause, resume, and discard for persisted batches', async () => {
    let listener: ((progress: never) => void) | undefined
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
          },
          resume: async () => {
            resumed += 1
          },
          pause: () => {
            paused += 1
            running = false
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
      status: 'completed',
      logs: []
    } as never)
    assert.equal(events.at(-1)?.channel, 'scrape:videoBatchProgress')
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
