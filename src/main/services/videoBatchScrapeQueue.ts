import type {
  BatchProgress,
  VideoBatchScrapeRequest,
  VideoScrapeField,
  VideoScrapeUpdateMode
} from '@shared/types'
import { VIDEO_BATCH_SCRAPE_STATUS_OPTIONS, VIDEO_SCRAPE_FIELD_OPTIONS } from '@shared/types'
import { listVideosForBatchScrape } from '../db/videoRepo'
import { scrapeVideo } from '../scrapers/scraperManager'
import { scrapeBrowser } from '../scrapers/scrapeBrowser'
import {
  createBatchScrapeJob,
  discardBatchScrapeJob,
  finishBatchScrapeJob,
  getBatchScrapeState,
  markBatchScrapePaused,
  persistBatchScrapeCheckpoint,
  restoreTargetsFromJob
} from './batchScrapeControl'
import {
  jobToBatchProgress,
  loadBatchScrapeJob,
  type PersistedBatchScrapeJob
} from './batchScrapeJobStore'
import { ScraperDelayController } from './scraperDelayController'
import { SequentialBatchQueue } from './sequentialBatchQueue'

type ProgressListener = (progress: BatchProgress) => void

const MODE_LABEL: Record<VideoScrapeUpdateMode, string> = {
  replace: '覆盖更新',
  fillEmpty: '空字段补齐',
  replaceIfPresent: '有值覆盖'
}

const STATUS_LABEL = new Map(
  VIDEO_BATCH_SCRAPE_STATUS_OPTIONS.map((option) => [option.id, option.label])
)

const FIELD_LABEL = new Map(
  VIDEO_SCRAPE_FIELD_OPTIONS.map((option) => [option.id, option.label])
)

function fieldListLabel(fields: VideoScrapeField[]): string {
  return fields.map((field) => FIELD_LABEL.get(field) ?? field).join('、')
}

function resolveVideoTargets(request: VideoBatchScrapeRequest): Array<{ id: number; code: string }> {
  const explicitIds = request.videoIds
    ? Array.from(new Set(request.videoIds.filter((id) => Number.isFinite(id))))
    : []
  return listVideosForBatchScrape({
    status: request.status,
    videoIds: explicitIds.length > 0 ? explicitIds : request.videoIds,
    missingFields: request.missingFields
  })
}

function buildStatusLabel(request: VideoBatchScrapeRequest): string {
  const explicitIds = request.videoIds
    ? Array.from(new Set(request.videoIds.filter((id) => Number.isFinite(id))))
    : []
  return explicitIds.length > 0
    ? `已选 ${explicitIds.length} 部影片`
    : (STATUS_LABEL.get(request.status) ?? String(request.status))
}

/** Sequential batch queue for video metadata scraping/updating. */
class VideoBatchScrapeQueue {
  private readonly queue = new SequentialBatchQueue<{ id: number; code: string }>()
  private activeJob: PersistedBatchScrapeJob | null = null

  setListener(fn: ProgressListener | null): void {
    this.queue.setListener(fn)
  }

  getProgress(): BatchProgress {
    if (this.queue.isRunning()) return this.queue.getProgress()
    const job = loadBatchScrapeJob()
    if (job?.kind === 'video') return jobToBatchProgress(job)
    return this.queue.getProgress()
  }

  isRunning(): boolean {
    return this.queue.isRunning()
  }

  isPaused(): boolean {
    const job = loadBatchScrapeJob()
    return job?.kind === 'video' && !this.queue.isRunning()
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
      discardBatchScrapeJob()
      this.activeJob = null
    }
  }

  async resume(): Promise<void> {
    const job = loadBatchScrapeJob()
    if (!job || job.kind !== 'video') {
      throw new Error('没有可继续的影片批量任务')
    }
    await this.runJob(job)
  }

  async start(request: VideoBatchScrapeRequest): Promise<void> {
    const targets = resolveVideoTargets(request)
    const job = createBatchScrapeJob('video', request, targets, (target) => target.code)
    this.activeJob = job
    persistBatchScrapeCheckpoint(job, jobToBatchProgress(job), 0, 'running')
    await this.runJob(job)
  }

  private async runJob(job: PersistedBatchScrapeJob): Promise<void> {
    const request = job.request as VideoBatchScrapeRequest
    const fields = request.fields
    if (fields.length === 0) return

    const mode = request.mode ?? 'replace'
    const missingFields = request.missingFields ?? []
    const targets = restoreTargetsFromJob(job, (item) => ({
      id: item.id,
      code: item.label
    }))
    const delayController = new ScraperDelayController({
      onWait: ({ pluginName, waitMs }) => {
        this.queue.addLog(
          '-',
          'info',
          `等待 ${(waitMs / 1000).toFixed(1)}s 后继续...（${pluginName}）`
        )
      }
    })
    const statusLabel = buildStatusLabel(request)
    const missingLabel =
      missingFields.length > 0 ? `缺少任一：${fieldListLabel(missingFields)}` : '不按缺失字段筛选'

    this.activeJob = job

    try {
      const outcome = await this.queue.start({
        targets,
        startIndex: job.nextIndex,
        initialProgress: {
          success: job.success,
          failed: job.failed,
          logs: job.logs
        },
        resumeMessage: `影片批量更新从第 ${job.nextIndex + 1}/${job.total} 项继续`,
        startMessage: (total) =>
          `影片批量更新开始（${statusLabel}，${missingLabel}，${MODE_LABEL[mode]}），共 ${total} 部，更新 ${fields.length} 个字段`,
        pausedMessage: '用户暂停了影片批量更新',
        cancelledMessage: '用户终止了影片批量更新',
        doneMessage: (progress) =>
          `影片批量更新完成：成功 ${progress.success}，失败 ${progress.failed}`,
        getCode: (target) => target.code,
        onCheckpoint: (progress, nextIndex) => {
          if (!this.activeJob) return
          persistBatchScrapeCheckpoint(this.activeJob, progress, nextIndex, 'running')
        },
        runTarget: async ({ id, code }) => {
          const itemOutcome = await scrapeVideo(id, request.scraperName, {
            closeBrowser: false,
            fields,
            mode,
            delayController
          })
          if (itemOutcome.ok) {
            if (itemOutcome.skipped) {
              return {
                success: true,
                level: 'info',
                message: '跳过：所选更新字段无需写入'
              }
            }
            return {
              success: true,
              level: 'success',
              message: `更新成功：${itemOutcome.result?.title ?? code}`
            }
          }
          return {
            success: false,
            level: 'error',
            message: `更新失败：${itemOutcome.error ?? '未知错误'}`
          }
        },
        exceptionMessage: (_target, err) => `更新异常：${err.message}`,
        delayAfterTarget: false
      })

      if (outcome === 'paused' && this.activeJob) {
        markBatchScrapePaused(this.activeJob, this.queue.getProgress())
      } else if (outcome === 'done') {
        finishBatchScrapeJob()
        this.activeJob = null
      } else if (outcome === 'cancelled') {
        discardBatchScrapeJob()
        this.activeJob = null
        this.queue.resetToIdle()
      }
    } finally {
      scrapeBrowser.close()
    }
  }
}

export const videoBatchScrapeQueue = new VideoBatchScrapeQueue()
