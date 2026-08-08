import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { BatchProgress } from '@shared/batchScrapeTypes'
import type { PersistedBatchScrapeJob } from './batchScrapeJobStore'
import type { BatchScrapeCheckpointPort } from './batchScrapeCheckpointPort'
import { CheckpointedSequentialBatchQueue } from './checkpointedSequentialBatchQueue'

type Target = { id: number; code: string }
type Request = { fields: string[]; labels: string[] }

function createMemoryCheckpoints(): BatchScrapeCheckpointPort & {
  jobs: PersistedBatchScrapeJob[]
} {
  let job: PersistedBatchScrapeJob | null = null
  const jobs: PersistedBatchScrapeJob[] = []
  const port: BatchScrapeCheckpointPort & { jobs: PersistedBatchScrapeJob[] } = {
    jobs,
    load: () => job,
    create: (kind, request, targets, getLabel) => {
      job = {
        jobId: 'job-1',
        kind,
        request: request as PersistedBatchScrapeJob['request'],
        targets: targets.map((target) => ({ id: target.id, label: getLabel(target) })),
        nextIndex: 0,
        success: 0,
        pending: 0,
        failed: 0,
        logs: [],
        total: targets.length,
        status: 'running',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
      jobs.push(structuredClone(job))
      return job
    },
    persist: (current, progress, nextIndex, status = 'running') => {
      job = {
        ...current,
        nextIndex,
        success: progress.success,
        pending: progress.pending,
        failed: progress.failed,
        logs: progress.logs,
        status,
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
      jobs.push(structuredClone(job))
    },
    markPaused: (current, progress) => {
      job = {
        ...current,
        nextIndex: progress.current,
        success: progress.success,
        pending: progress.pending,
        failed: progress.failed,
        logs: progress.logs,
        status: 'paused',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
      jobs.push(structuredClone(job))
    },
    finish: () => {
      job = null
    },
    discard: () => {
      job = null
    },
    toProgress: (current) => ({
      total: current.total,
      current: current.nextIndex,
      success: current.success,
      pending: current.pending,
      failed: current.failed,
      currentCode: null,
      status: current.status === 'paused' ? 'paused' : 'running',
      logs: current.logs
    }),
    restoreTargets: (current, buildTarget) => current.targets.map((item) => buildTarget(item)),
    assertActressRecoverable: (current) => current
  }
  return port
}

describe('CheckpointedSequentialBatchQueue', () => {
  it('persists checkpoints, pauses, and resumes from the next index', async () => {
    const checkpoints = createMemoryCheckpoints()
    const processed: string[] = []
    let queueRef: CheckpointedSequentialBatchQueue<Target, Request> | null = null

    const queue = new CheckpointedSequentialBatchQueue<Target, Request>({
      kind: 'video',
      missingResumeError: '没有可继续的影片批量任务',
      resolveTargets: (request) =>
        request.labels.map((code, index) => ({ id: index + 1, code })),
      labelOf: (target) => target.code,
      restoreTarget: (item) => ({ id: item.id, code: item.label }),
      planRun: (job, _targets, _helpers) => {
        const request = job.request as unknown as Request
        if (request.fields.length === 0) return null
        return {
          resumeMessage: 'resume',
          startMessage: (total) => `start ${total}`,
          pausedMessage: 'paused',
          cancelledMessage: 'cancelled',
          doneMessage: (progress: BatchProgress) => `done ${progress.success}`,
          getCode: (target) => target.code,
          runTarget: async (target) => {
            processed.push(target.code)
            if (target.code === 'A') queueRef?.pause()
            return { status: 'success', level: 'success', message: 'ok' }
          },
          exceptionMessage: () => 'error'
        }
      }
    })
    queueRef = queue
    queue.setCheckpointPort(checkpoints)

    await queue.start({ fields: ['title'], labels: ['A', 'B', 'C'] })
    assert.equal(queue.isPaused(), true)
    assert.deepEqual(processed, ['A'])
    assert.equal(checkpoints.load()?.nextIndex, 1)
    assert.equal(checkpoints.load()?.status, 'paused')

    await queue.resume()
    assert.deepEqual(processed, ['A', 'B', 'C'])
    assert.equal(queue.isRunning(), false)
    assert.equal(checkpoints.load(), null)
  })

  it('discards a paused job without running', async () => {
    const checkpoints = createMemoryCheckpoints()
    const queue = new CheckpointedSequentialBatchQueue<Target, Request>({
      kind: 'video',
      missingResumeError: '没有可继续的影片批量任务',
      resolveTargets: (request) =>
        request.labels.map((code, index) => ({ id: index + 1, code })),
      labelOf: (target) => target.code,
      restoreTarget: (item) => ({ id: item.id, code: item.label }),
      planRun: () => ({
        resumeMessage: 'resume',
        startMessage: () => 'start',
        pausedMessage: 'paused',
        cancelledMessage: 'cancelled',
        doneMessage: () => 'done',
        getCode: (target) => target.code,
        runTarget: async () => {
          queue.pause()
          return { status: 'success', level: 'success', message: 'ok' }
        },
        exceptionMessage: () => 'error'
      })
    })
    queue.setCheckpointPort(checkpoints)

    await queue.start({ fields: ['title'], labels: ['A', 'B'] })
    assert.equal(queue.isPaused(), true)

    queue.discard()
    assert.equal(checkpoints.load(), null)
    assert.equal(queue.isPaused(), false)
  })

  it('cancels a running job and clears the checkpoint', async () => {
    const checkpoints = createMemoryCheckpoints()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const queue = new CheckpointedSequentialBatchQueue<Target, Request>({
      kind: 'video',
      missingResumeError: '没有可继续的影片批量任务',
      resolveTargets: (request) =>
        request.labels.map((code, index) => ({ id: index + 1, code })),
      labelOf: (target) => target.code,
      restoreTarget: (item) => ({ id: item.id, code: item.label }),
      planRun: () => ({
        resumeMessage: 'resume',
        startMessage: () => 'start',
        pausedMessage: 'paused',
        cancelledMessage: 'cancelled',
        doneMessage: () => 'done',
        getCode: (target) => target.code,
        runTarget: async (target) => {
          if (target.code === 'A') await gate
          return { status: 'success', level: 'success', message: 'ok' }
        },
        exceptionMessage: () => 'error'
      })
    })
    queue.setCheckpointPort(checkpoints)

    const started = queue.start({ fields: ['title'], labels: ['A', 'B'] })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(queue.isRunning(), true)
    queue.discard()
    release()
    await started

    assert.equal(checkpoints.load(), null)
    assert.equal(queue.getProgress().status, 'idle')
  })
})
