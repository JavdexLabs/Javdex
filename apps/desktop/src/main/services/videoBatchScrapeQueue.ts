import type { BatchProgress } from '@shared/batchScrapeTypes'
import type { VideoBatchScrapeRequest, VideoScrapeField, VideoScrapeUpdateMode } from '@shared/videoScrapeTypes'
import { VIDEO_BATCH_SCRAPE_STATUS_OPTIONS, VIDEO_SCRAPE_FIELD_OPTIONS } from '@shared/videoScrapeTypes'
import {
  resolveVideoScrapeFieldSources,
  type ScrapeOutcome
} from '../scrapers/scraperManager'
import {
  createScrapeCatalogBinding,
  type ScrapeCatalogBinding
} from './scrapeCatalogBinding'
import {
  freezeRemoteVideoTargets
} from './catalogRemoteBatch'
import type { BatchScrapeCheckpointPort } from './batchScrapeCheckpointPort'
import {
  CheckpointedSequentialBatchQueue,
  type CatalogKeyProvider,
  type CheckpointedBatchPolicy
} from './checkpointedSequentialBatchQueue'
import { resolveVideoBatchTargets } from './videoScrapeApplyService'
import { getMediaLibrary } from '@library/db/mediaLibraryRepo'
import { hasActiveVisibleVideoMembership } from '@library/db/libraryMembershipRepo'
import type { PersistedBatchScrapeJob } from './batchScrapeJobStore'
import type { QueueItemOutcome } from './sequentialBatchQueue'
import type { CatalogBackend } from '../application/catalogBackend'

type ProgressListener = (progress: BatchProgress) => void
type VideoTarget = { id: number; code: string; generation?: number | null; revision?: number | null }

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

function resolveVideoTargets(request: VideoBatchScrapeRequest): VideoTarget[] {
  const explicitIds = request.videoIds
    ? Array.from(new Set(request.videoIds.filter((id) => Number.isFinite(id))))
    : []
  const fieldSources = resolveVideoScrapeFieldSources(request.scraperName)
  return resolveVideoBatchTargets({
    libraryId: request.libraryId,
    status: request.status,
    videoIds: explicitIds.length > 0 ? explicitIds : request.videoIds,
    missingFields: request.missingFields,
    ...fieldSources
  })
}

async function resolveVideoQueueTargets(
  request: VideoBatchScrapeRequest,
  catalog: CatalogBackend | null
): Promise<VideoTarget[]> {
  if (catalog) {
    const fieldSources = resolveVideoScrapeFieldSources(request.scraperName)
    return freezeRemoteVideoTargets(catalog, { ...request, ...fieldSources })
  }
  return resolveVideoTargets(request)
}

export function formatVideoBatchStatusLabel(
  request: VideoBatchScrapeRequest,
  libraryName?: string | null
): string {
  const explicitIds = request.videoIds
    ? Array.from(new Set(request.videoIds.filter((id) => Number.isFinite(id))))
    : []
  const targetLabel = explicitIds.length > 0
    ? `已选 ${explicitIds.length} 部影片`
    : (STATUS_LABEL.get(request.status) ?? String(request.status))
  const scopeLabel = request.libraryId
    ? `媒体库“${libraryName?.trim() || `#${request.libraryId}`}”`
    : '全局目录'
  return `${scopeLabel} · ${targetLabel}`
}

/** Re-check a paused scoped job before using its frozen target snapshot. */
export function assertVideoBatchResumeScope(
  job: PersistedBatchScrapeJob,
  resolveTargets: typeof resolveVideoBatchTargets = resolveVideoBatchTargets,
  catalog: CatalogBackend | null = null
): PersistedBatchScrapeJob {
  if (catalog) return job
  const request = job.request as VideoBatchScrapeRequest
  if (request.libraryId === undefined) return job

  const remainingIds = Array.from(
    new Set(job.targets.slice(job.nextIndex).map((target) => target.id))
  )
  for (let start = 0; start < remainingIds.length; start += 500) {
    const videoIds = remainingIds.slice(start, start + 500)
    const scopedIds = new Set(
      resolveTargets({
        libraryId: request.libraryId,
        status: 'all',
        videoIds
      }).map((target) => target.id)
    )
    if (videoIds.some((videoId) => !scopedIds.has(videoId))) {
      throw new Error('当前媒体库作用域已变化，无法继续；请终止任务后重新开始')
    }
  }
  return job
}

/** Guard every frozen target immediately before a scoped scrape performs external work. */
export async function validateVideoBatchTargetScope(
  request: VideoBatchScrapeRequest,
  videoId: number,
  hasMembership: (
    libraryId: number,
    videoId: number
  ) => boolean | Promise<boolean> = hasActiveVisibleVideoMembership,
  catalog: CatalogBackend | null = null
): Promise<QueueItemOutcome | null> {
  if (request.libraryId === undefined) return null
  const inScope = catalog
    ? Boolean(
        await catalog.queries.getVideo({
          scope: { kind: 'library', libraryId: request.libraryId },
          videoId
        })
      )
    : await hasMembership(request.libraryId, videoId)
  if (inScope) return null
  return {
    status: 'failure',
    level: 'error',
    message: `已跳过：影片已不属于当前活动媒体库（#${request.libraryId}）`
  }
}

export function formatVideoBatchScrapeOutcome(
  outcome: ScrapeOutcome,
  fallbackCode: string
): { status: 'success' | 'pending' | 'failure'; level: 'success' | 'info' | 'error'; message: string } {
  if (!outcome.ok) {
    return {
      status: 'failure',
      level: 'error',
      message: `更新失败：${outcome.error ?? '未知错误'}`
    }
  }
  if (outcome.pending) {
    return {
      status: 'pending',
      level: 'info',
      message: '待确认：已保存全部匹配候选，可稍后在待确认中心处理'
    }
  }
  const warningText = outcome.warnings?.join('；')
  if (outcome.skipped) {
    return {
      status: 'success',
      level: 'info',
      message: warningText
        ? `跳过：部分字段无法安全应用（${warningText}）`
        : '跳过：所选字段无可写入内容'
    }
  }
  return {
    status: 'success',
    level: warningText ? 'info' : 'success',
    message: warningText
      ? `更新成功，部分字段未应用：${outcome.result?.title ?? fallbackCode}（${warningText}）`
      : `更新成功：${outcome.result?.title ?? fallbackCode}`
  }
}

function createVideoBatchPolicy(
  binding: ScrapeCatalogBinding
): CheckpointedBatchPolicy<VideoTarget, VideoBatchScrapeRequest> {
  return {
    kind: 'video',
    missingResumeError: '没有可继续的影片批量任务',
    invalidRunPlanError: '请至少选择一个影片更新字段',
    resolveTargets: (request) => resolveVideoQueueTargets(request, binding.catalog),
    labelOf: (target) => target.code,
    restoreTarget: (item) => ({ id: item.id, code: item.label, generation: item.generation, revision: item.revision }),
    beforeResume: (job) => assertVideoBatchResumeScope(job, resolveVideoBatchTargets, binding.catalog),
    planRun: (job, _targets, helpers) => {
      const request = job.request as VideoBatchScrapeRequest
      const fields = request.fields
      if (fields.length === 0) return null

      const mode = request.mode ?? 'replace'
      const missingFields = request.missingFields ?? []
      const delayController = helpers.createDelayController()
      const libraryName = request.libraryId && !binding.catalog
        ? getMediaLibrary(request.libraryId)?.name
        : null
      const statusLabel = formatVideoBatchStatusLabel(request, libraryName)
      const missingLabel =
        missingFields.length > 0 ? `缺少任一：${fieldListLabel(missingFields)}` : '不按缺失字段筛选'

      return {
        resumeMessage: `影片批量更新从第 ${job.nextIndex + 1}/${job.total} 项继续`,
        startMessage: (total) =>
          `影片批量更新开始（${statusLabel}，${missingLabel}，${MODE_LABEL[mode]}），共 ${total} 部，更新 ${fields.length} 个字段`,
        pausedMessage: '用户暂停了影片批量更新',
        cancelledMessage: '用户终止了影片批量更新',
        doneMessage: (progress) =>
          `影片批量更新完成：成功 ${progress.success}，待确认 ${progress.pending}，失败 ${progress.failed}`,
        getCode: (target) => target.code,
        browserRecycleInterval: 50,
        runTarget: async ({ id, code, generation, revision }) => {
          const scopeFailure = await validateVideoBatchTargetScope(
            request,
            id,
            hasActiveVisibleVideoMembership,
            binding.catalog
          )
          if (scopeFailure) return scopeFailure
          const itemOutcome = await binding.scrapeVideo(id, request.scraperName, {
            closeBrowser: false,
            fields,
            mode,
            expectedVersion: generation == null || revision == null ? undefined : { generation, revision },
            delayController
          })
          return formatVideoBatchScrapeOutcome(itemOutcome, code)
        },
        exceptionMessage: (_target, err) => `更新异常：${err.message}`
      }
    }
  }
}

/** Sequential batch queue for video metadata scraping/updating. */
class VideoBatchScrapeQueue {
  private readonly lifecycle: CheckpointedSequentialBatchQueue<VideoTarget, VideoBatchScrapeRequest>

  constructor(
    binding: ScrapeCatalogBinding = createScrapeCatalogBinding(),
    catalogKey: CatalogKeyProvider = 'local'
  ) {
    this.lifecycle = new CheckpointedSequentialBatchQueue(
      createVideoBatchPolicy(binding),
      undefined,
      catalogKey
    )
  }

  setCheckpointPort(port: BatchScrapeCheckpointPort): void {
    this.lifecycle.setCheckpointPort(port)
  }

  setListener(fn: ProgressListener | null): void {
    this.lifecycle.setListener(fn)
  }

  getProgress(): BatchProgress {
    return this.lifecycle.getProgress()
  }

  isRunning(): boolean {
    return this.lifecycle.isRunning()
  }

  isPaused(): boolean {
    return this.lifecycle.isPaused()
  }

  pause(): void {
    this.lifecycle.pause()
  }

  discard(): void {
    this.lifecycle.discard()
  }

  async resume(): Promise<void> {
    await this.lifecycle.resume()
  }

  async start(request: VideoBatchScrapeRequest): Promise<void> {
    await this.lifecycle.start(request)
  }
}

export function createVideoBatchScrapeQueue(
  backend?: CatalogBackend,
  catalogKey: CatalogKeyProvider = 'local'
): VideoBatchScrapeQueue {
  return new VideoBatchScrapeQueue(createScrapeCatalogBinding(backend), catalogKey)
}

export const videoBatchScrapeQueue = new VideoBatchScrapeQueue()
