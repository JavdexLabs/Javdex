import type { ActressAvatarAutoCropOutcome, ActressAvatarAutoCropTarget, ActressBatchScrapeRequest, ActressBatchScrapeScope, ActressBatchScrapeStatus, ActressScrapeField, ActressScrapeUpdateMode } from '@shared/scrapeTypes'
import type { BatchProgress } from '@shared/batchScrapeTypes'
import { ACTRESS_BATCH_SCRAPE_SCOPE_OPTIONS, ACTRESS_BATCH_SCRAPE_STATUS_OPTIONS, ACTRESS_BATCH_DEFAULT_MISSING_FIELDS, ACTRESS_SCRAPE_FIELD_OPTIONS, ALL_ACTRESS_SCRAPE_FIELDS } from '@shared/scrapeTypes'
import {
  normalizeActressBatchScrapeRequest,
  parseActressBatchScrapeStatus,
  resolveActressBatchScrapeTargets
} from './actressBatchScrapeTargets'
import { scrapeActress } from '../scrapers/actressScraperManager'
import { scrapeBrowser } from '../scrapers/scrapeBrowser'
import type { PersistedBatchScrapeJob } from './batchScrapeJobStore'
import type { BatchScrapeCheckpointPort } from './batchScrapeCheckpointPort'
import { ScraperDelayController } from './scraperDelayController'
import { SequentialBatchQueue } from './sequentialBatchQueue'

type ProgressListener = (progress: BatchProgress) => void
type AvatarAutoCropListener = (
  target: ActressAvatarAutoCropTarget
) => Promise<ActressAvatarAutoCropOutcome>

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
  private avatarAutoCropListener: AvatarAutoCropListener | null = null
  private checkpoints: BatchScrapeCheckpointPort | null = null

  setCheckpointPort(port: BatchScrapeCheckpointPort): void {
    this.checkpoints = port
  }

  setListener(fn: ProgressListener | null): void {
    this.queue.setListener(fn)
  }

  setAvatarAutoCropListener(fn: AvatarAutoCropListener | null): void {
    this.avatarAutoCropListener = fn
  }

  getProgress(): BatchProgress {
    if (this.queue.isRunning()) return this.queue.getProgress()
    const job = this.checkpointPort().load()
    if (job?.kind === 'actress') return this.checkpointPort().toProgress(job)
    return this.queue.getProgress()
  }

  isRunning(): boolean {
    return this.queue.isRunning()
  }

  isPaused(): boolean {
    const job = this.checkpointPort().load()
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
      this.checkpointPort().discard()
      this.activeJob = null
    }
  }

  async resume(): Promise<void> {
    const job = this.checkpointPort().load()
    if (!job || job.kind !== 'actress') {
      throw new Error('没有可继续的演员批量任务')
    }
    await this.runJob(this.checkpointPort().assertActressRecoverable(job))
  }

  async start(requestOrScraperName?: ActressBatchScrapeRequest | string): Promise<void> {
    const request = normalizeActressBatchScrapeRequest(
      typeof requestOrScraperName === 'string'
        ? defaultRequest(requestOrScraperName)
        : (requestOrScraperName ?? defaultRequest())
    )
    const targets = resolveActressBatchScrapeTargets(request)
    const job = this.checkpointPort().create(
      'actress',
      request,
      targets,
      (target) => target.main_name
    )
    this.activeJob = job
    this.checkpointPort().persist(job, this.checkpointPort().toProgress(job), 0, 'running')
    await this.runJob(job)
  }

  private async runJob(job: PersistedBatchScrapeJob): Promise<void> {
    const request = job.request as ActressBatchScrapeRequest
    const fields = request.fields
    if (fields.length === 0) return

    const mode = request.mode ?? 'replace'
    const missingFields = request.missingFields ?? []
    const targets = this.checkpointPort().restoreTargets(job, (item) => ({
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
    const scopeLabel = request.actressIds
      ? `已选 ${targets.length} 位演员`
      : (SCOPE_LABEL.get(request.scope) ?? request.scope)
    const parsedStatus = parseActressBatchScrapeStatus(request.scrapeStatus)
    const statusLabel = parsedStatus.ok
      ? (STATUS_LABEL.get(parsedStatus.status) ?? parsedStatus.status)
      : parsedStatus.value
    const missingLabel =
      missingFields.length > 0 ? `缺少任一：${fieldListLabel(missingFields)}` : '不按缺失字段筛选'

    this.activeJob = job

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
        resumeMessage: `演员批量刮削从第 ${job.nextIndex + 1}/${job.total} 项继续`,
        startMessage: (total) =>
          `演员批量刮削开始（${scopeLabel} · ${statusLabel}，${missingLabel}，${MODE_LABEL[mode]}），共 ${total} 位，更新 ${fields.length} 个字段`,
        pausedMessage: '用户暂停了演员批量刮削',
        cancelledMessage: '用户终止了演员批量刮削',
        doneMessage: (progress) =>
          `演员批量刮削完成：成功 ${progress.success}，待确认 ${progress.pending}，失败 ${progress.failed}`,
        getCode: (target) => target.main_name,
        onCheckpoint: (progress, nextIndex) => {
          if (!this.activeJob) return
          this.checkpointPort().persist(this.activeJob, progress, nextIndex, 'running')
        },
        runTarget: async ({ id, main_name }) => {
          const itemOutcome = await scrapeActress(id, request.scraperName, {
            closeBrowser: false,
            fields,
            mode,
            useAliases: request.useAliases ?? false,
            batchJobId: job.jobId,
            delayController
          })
          if (itemOutcome.status === 'pending') {
            return {
              status: 'pending',
              level: 'info',
              message: `待确认：名称归属冲突（结果 ${itemOutcome.pendingId}）`
            }
          }
          if (itemOutcome.ok) {
            if (itemOutcome.skipped) {
              return {
                status: 'success',
                level: 'info',
                message: '跳过：所选更新字段无需写入'
              }
            }
            let avatarAutoCropOutcome: ActressAvatarAutoCropOutcome | null = null
            if (
              request.autoCropAvatar &&
              fields.includes('avatar') &&
              itemOutcome.avatarUpdated
            ) {
              avatarAutoCropOutcome = this.avatarAutoCropListener
                ? await this.avatarAutoCropListener({ actressId: id, mainName: main_name })
                : { status: 'failed', message: '智能构图服务不可用' }
            }

            const details = [...(itemOutcome.warnings ?? [])]
            if (avatarAutoCropOutcome?.status === 'success') {
              details.push('头像智能构图完成')
            } else if (avatarAutoCropOutcome?.status === 'skipped') {
              details.push(`头像智能构图已跳过：${avatarAutoCropOutcome.message ?? '没有可用原图'}`)
            } else if (avatarAutoCropOutcome?.status === 'failed') {
              details.push(`头像智能构图失败：${avatarAutoCropOutcome.message ?? '未知错误'}`)
            }

            if (details.length > 0) {
              return {
                status: 'success',
                level: 'info',
                message: `刮削成功；${details.join('；')}`
              }
            }
            return {
              status: 'success',
              level: 'success',
              message: '刮削成功'
            }
          }
          return {
            status: 'failure',
            level: 'error',
            message: `刮削失败：${itemOutcome.error ?? '未知错误'}`
          }
        },
        exceptionMessage: (_target, err) => `刮削异常：${err.message}`,
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
      scrapeBrowser.close()
    }
  }

  private checkpointPort(): BatchScrapeCheckpointPort {
    if (!this.checkpoints) throw new Error('批量刮削检查点尚未初始化')
    return this.checkpoints
  }
}

export const actressScrapeQueue = new ActressScrapeQueue()
