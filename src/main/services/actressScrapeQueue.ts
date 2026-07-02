import type {
  ActressBatchScrapeRequest,
  ActressBatchScrapeScope,
  ActressBatchScrapeStatus,
  ActressScrapeField,
  ActressScrapeUpdateMode,
  BatchProgress
} from '@shared/types'
import {
  ACTRESS_BATCH_SCRAPE_SCOPE_OPTIONS,
  ACTRESS_BATCH_SCRAPE_STATUS_OPTIONS,
  ACTRESS_BATCH_DEFAULT_MISSING_FIELDS,
  ACTRESS_SCRAPE_FIELD_OPTIONS,
  ALL_ACTRESS_SCRAPE_FIELDS
} from '@shared/types'
import { listActressesForBatchScrape } from '../db/actressRepo'
import { scrapeActress } from '../scrapers/actressScraperManager'
import { scrapeBrowser } from '../scrapers/scrapeBrowser'
import {
  createBatchScrapeJob,
  discardBatchScrapeJob,
  finishBatchScrapeJob,
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

const MODE_LABEL: Record<ActressScrapeUpdateMode, string> = {
  replace: '覆盖更新',
  fillEmpty: '空字段补齐',
  replaceIfPresent: '有值覆盖'
}

const SCOPE_LABEL = new Map<ActressBatchScrapeScope, string>(
  ACTRESS_BATCH_SCRAPE_SCOPE_OPTIONS.map((option) => [option.id, option.label])
)

const STATUS_LABEL = new Map<ActressBatchScrapeStatus, string>(
  ACTRESS_BATCH_SCRAPE_STATUS_OPTIONS.map((option) => [option.id, option.label])
)

const FIELD_LABEL = new Map<ActressScrapeField, string>(
  ACTRESS_SCRAPE_FIELD_OPTIONS.map((option) => [option.id, option.label])
)

function fieldListLabel(fields: ActressScrapeField[]): string {
  return fields.map((field) => FIELD_LABEL.get(field) ?? field).join('、')
}

function defaultRequest(scraperName?: string): ActressBatchScrapeRequest {
  return {
    scraperName,
    scope: 'female',
    missingFields: [...ACTRESS_BATCH_DEFAULT_MISSING_FIELDS],
    fields: ALL_ACTRESS_SCRAPE_FIELDS,
    mode: 'replace'
  }
}

/**
 * Sequential batch actress-profile scrape queue.
 * Processes configured actress profile targets one at a time.
 */
class ActressScrapeQueue {
  private readonly queue = new SequentialBatchQueue<{ id: number; main_name: string }>()
  private activeJob: PersistedBatchScrapeJob | null = null

  setListener(fn: ProgressListener | null): void {
    this.queue.setListener(fn)
  }

  getProgress(): BatchProgress {
    if (this.queue.isRunning()) return this.queue.getProgress()
    const job = loadBatchScrapeJob()
    if (job?.kind === 'actress') return jobToBatchProgress(job)
    return this.queue.getProgress()
  }

  isRunning(): boolean {
    return this.queue.isRunning()
  }

  isPaused(): boolean {
    const job = loadBatchScrapeJob()
    return job?.kind === 'actress' && !this.queue.isRunning()
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
    if (!job || job.kind !== 'actress') {
      throw new Error('没有可继续的演员批量任务')
    }
    await this.runJob(job)
  }

  async start(requestOrScraperName?: ActressBatchScrapeRequest | string): Promise<void> {
    const request =
      typeof requestOrScraperName === 'string'
        ? defaultRequest(requestOrScraperName)
        : (requestOrScraperName ?? defaultRequest())
    const targets = listActressesForBatchScrape({
      scope: request.scope,
      scrapeStatus: request.scrapeStatus,
      missingFields: request.missingFields
    })
    const job = createBatchScrapeJob('actress', request, targets, (target) => target.main_name)
    this.activeJob = job
    persistBatchScrapeCheckpoint(job, jobToBatchProgress(job), 0, 'running')
    await this.runJob(job)
  }

  private async runJob(job: PersistedBatchScrapeJob): Promise<void> {
    const request = job.request as ActressBatchScrapeRequest
    const fields = request.fields
    if (fields.length === 0) return

    const mode = request.mode ?? 'replace'
    const missingFields = request.missingFields ?? []
    const targets = restoreTargetsFromJob(job, (item) => ({
      id: item.id,
      main_name: item.label
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
    const scopeLabel = SCOPE_LABEL.get(request.scope) ?? request.scope
    const statusLabel =
      STATUS_LABEL.get(request.scrapeStatus ?? 'all') ?? request.scrapeStatus ?? '全部'
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
        resumeMessage: `演员批量刮削从第 ${job.nextIndex + 1}/${job.total} 项继续`,
        startMessage: (total) =>
          `演员批量刮削开始（${scopeLabel} · ${statusLabel}，${missingLabel}，${MODE_LABEL[mode]}），共 ${total} 位，更新 ${fields.length} 个字段`,
        pausedMessage: '用户暂停了演员批量刮削',
        cancelledMessage: '用户终止了演员批量刮削',
        doneMessage: (progress) =>
          `演员批量刮削完成：成功 ${progress.success}，失败 ${progress.failed}`,
        getCode: (target) => target.main_name,
        onCheckpoint: (progress, nextIndex) => {
          if (!this.activeJob) return
          persistBatchScrapeCheckpoint(this.activeJob, progress, nextIndex, 'running')
        },
        runTarget: async ({ id, main_name }) => {
          const itemOutcome = await scrapeActress(id, request.scraperName, {
            closeBrowser: false,
            fields,
            mode,
            useAliases: request.useAliases ?? false,
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
            if (itemOutcome.warnings?.length) {
              return {
                success: true,
                level: 'info',
                message: `刮削成功；${itemOutcome.warnings.join('；')}`
              }
            }
            return {
              success: true,
              level: 'success',
              message: '刮削成功'
            }
          }
          return {
            success: false,
            level: 'error',
            message: `刮削失败：${itemOutcome.error ?? '未知错误'}`
          }
        },
        exceptionMessage: (_target, err) => `刮削异常：${err.message}`,
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

export const actressScrapeQueue = new ActressScrapeQueue()
