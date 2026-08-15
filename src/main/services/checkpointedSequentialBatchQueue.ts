import type { BatchLogEntry, BatchProgress } from '@shared/batchScrapeTypes'
import { scrapeBrowser } from '../scrapers/scrapeBrowser'
import type { BatchScrapeJobKind, PersistedBatchScrapeJob } from './batchScrapeJobStore'
import type { BatchScrapeCheckpointPort } from './batchScrapeCheckpointPort'
import { ScraperDelayController } from './scraperDelayController'
import {
  SequentialBatchQueue,
  type QueueItemOutcome
} from './sequentialBatchQueue'

type ProgressListener = (progress: BatchProgress) => void

export interface CheckpointedBatchRunPlan<TTarget extends { id: number }> {
  resumeMessage: string
  startMessage: (total: number) => string
  pausedMessage: string
  cancelledMessage: string
  doneMessage: (progress: BatchProgress) => string
  getCode: (target: TTarget) => string
  /** Close the scraper window after this many attempted targets while preserving its session. */
  browserRecycleInterval?: number
  runTarget: (target: TTarget) => Promise<QueueItemOutcome>
  exceptionMessage: (target: TTarget, err: Error) => string
}

export interface CheckpointedBatchPolicyHelpers {
  addLog(code: string, level: BatchLogEntry['level'], message: string): void
  createDelayController(): ScraperDelayController
}

export interface CheckpointedBatchPolicy<TTarget extends { id: number }, TRequest> {
  kind: BatchScrapeJobKind
  missingResumeError: string
  resolveTargets(request: TRequest): TTarget[]
  labelOf(target: TTarget): string
  restoreTarget(item: { id: number; label: string }): TTarget
  beforeResume?(
    job: PersistedBatchScrapeJob,
    port: BatchScrapeCheckpointPort
  ): PersistedBatchScrapeJob
  planRun(
    job: PersistedBatchScrapeJob,
    targets: TTarget[],
    helpers: CheckpointedBatchPolicyHelpers
  ): CheckpointedBatchRunPlan<TTarget> | null
}

/**
 * Shared checkpointed sequential batch lifecycle for video/actress scrape queues.
 * Domain adapters supply target resolution and per-item policy via CheckpointedBatchPolicy.
 */
export class CheckpointedSequentialBatchQueue<TTarget extends { id: number }, TRequest> {
  private readonly queue = new SequentialBatchQueue<TTarget>()
  private activeJob: PersistedBatchScrapeJob | null = null
  private checkpoints: BatchScrapeCheckpointPort | null = null

  constructor(
    private readonly policy: CheckpointedBatchPolicy<TTarget, TRequest>,
    private readonly closeBrowser: () => void = () => scrapeBrowser.close()
  ) {}

  setCheckpointPort(port: BatchScrapeCheckpointPort): void {
    this.checkpoints = port
  }

  setListener(fn: ProgressListener | null): void {
    this.queue.setListener(fn)
  }

  getProgress(): BatchProgress {
    if (this.queue.isRunning()) return this.queue.getProgress()
    const job = this.checkpointPort().load()
    if (job?.kind === this.policy.kind) return this.checkpointPort().toProgress(job)
    return this.queue.getProgress()
  }

  isRunning(): boolean {
    return this.queue.isRunning()
  }

  isPaused(): boolean {
    const job = this.checkpointPort().load()
    return job?.kind === this.policy.kind && !this.queue.isRunning()
  }

  pause(): void {
    this.queue.pause()
  }

  discard(): void {
    if (this.queue.isRunning()) {
      this.queue.cancel()
      return
    }
    if (this.isPaused()) {
      this.checkpointPort().discard()
      this.activeJob = null
    }
  }

  async resume(): Promise<void> {
    const job = this.checkpointPort().load()
    if (!job || job.kind !== this.policy.kind) {
      throw new Error(this.policy.missingResumeError)
    }
    const recoverable = this.policy.beforeResume
      ? this.policy.beforeResume(job, this.checkpointPort())
      : job
    await this.runJob(recoverable)
  }

  async start(request: TRequest): Promise<void> {
    const targets = this.policy.resolveTargets(request)
    const job = this.checkpointPort().create(
      this.policy.kind,
      request as PersistedBatchScrapeJob['request'],
      targets,
      (target) => this.policy.labelOf(target)
    )
    this.activeJob = job
    this.checkpointPort().persist(job, this.checkpointPort().toProgress(job), 0, 'running')
    await this.runJob(job)
  }

  private async runJob(job: PersistedBatchScrapeJob): Promise<void> {
    const helpers: CheckpointedBatchPolicyHelpers = {
      addLog: (code, level, message) => this.queue.addLog(code, level, message),
      createDelayController: () =>
        new ScraperDelayController({
          onWait: ({ pluginName, waitMs }) => {
            this.queue.addLog(
              '-',
              'info',
              `等待 ${(waitMs / 1000).toFixed(1)}s 后继续...（${pluginName}）`
            )
          }
        })
    }
    const targets = this.checkpointPort().restoreTargets(job, (item) =>
      this.policy.restoreTarget(item)
    )
    const plan = this.policy.planRun(job, targets, helpers)
    if (!plan) return

    this.activeJob = job
    const browserRecycleInterval =
      plan.browserRecycleInterval && plan.browserRecycleInterval > 0
        ? Math.floor(plan.browserRecycleInterval)
        : null
    let targetsSinceBrowserRecycle = 0
    let browserClosedAfterLastTarget = false

    try {
      const outcome = await this.queue.start({
        targets,
        startIndex: job.nextIndex,
        initialProgress: {
          success: job.success,
          pending: job.pending,
          failed: job.failed,
          logs: job.logs
        },
        resumeMessage: plan.resumeMessage,
        startMessage: plan.startMessage,
        pausedMessage: plan.pausedMessage,
        cancelledMessage: plan.cancelledMessage,
        doneMessage: plan.doneMessage,
        getCode: plan.getCode,
        onCheckpoint: (progress, nextIndex) => {
          if (!this.activeJob) return
          this.checkpointPort().persist(this.activeJob, progress, nextIndex, 'running')
        },
        runTarget: async (target) => {
          browserClosedAfterLastTarget = false
          try {
            return await plan.runTarget(target)
          } finally {
            if (browserRecycleInterval) {
              targetsSinceBrowserRecycle += 1
              if (targetsSinceBrowserRecycle >= browserRecycleInterval) {
                this.closeBrowser()
                targetsSinceBrowserRecycle = 0
                browserClosedAfterLastTarget = true
              }
            }
          }
        },
        exceptionMessage: plan.exceptionMessage,
        delayAfterTarget: false
      })

      if (outcome === 'paused' && this.activeJob) {
        this.checkpointPort().markPaused(this.activeJob, this.queue.getProgress())
      } else if (outcome === 'done') {
        this.checkpointPort().finish()
        this.activeJob = null
      } else if (outcome === 'cancelled') {
        this.checkpointPort().discard()
        this.activeJob = null
        this.queue.resetToIdle()
      }
    } finally {
      if (!browserClosedAfterLastTarget) this.closeBrowser()
    }
  }

  private checkpointPort(): BatchScrapeCheckpointPort {
    if (!this.checkpoints) throw new Error('批量刮削检查点尚未初始化')
    return this.checkpoints
  }
}
