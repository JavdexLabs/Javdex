import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc-channels'
import type { ScrapeIpcEvent, ScrapeIpcEventChannel } from '@shared/scrapeIpcContract'
import type {
  ActressAvatarAutoCropOutcome,
  ActressAvatarAutoCropResponse,
  ActressAvatarAutoCropTarget,
  ActressBatchScrapeFilter,
  ActressBatchScrapeRequest,
  ActressScrapeDisposition,
  ActressScrapeField,
  ActressScrapeUpdateMode,
  ScrapeResult,
  VideoBatchScrapeFilter,
  VideoBatchScrapeRequest,
  VideoBatchScrapeStatus,
  VideoRematchBatchRequest,
  VideoRematchScope,
  VideoScrapeField,
  VideoScrapeOneResult,
  VideoScrapeUpdateMode
} from '@shared/scrapeTypes'
import type { BatchProgress, BatchScrapeState } from '@shared/batchScrapeTypes'
import { ALL_VIDEO_SCRAPE_FIELDS } from '@shared/scrapeTypes'
import type { ActressDetail } from '@shared/libraryTypes'
import type { BatchScrapeCheckpointPort } from './batchScrapeCheckpointPort'
import { actressScrapeQueue } from './actressScrapeQueue'
import { videoBatchScrapeQueue } from './videoBatchScrapeQueue'
import { scrapeRunCoordinator } from './scrapeRunCoordinator'
import {
  assertActressBatchJobRecoverable,
  assertBatchScrapeAvailable,
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
  loadBatchScrapeJob
} from './batchScrapeJobStore'
import { estimateActressBatchScrapeTargetCount } from './actressBatchScrapeTargets'
import { scrapeActress } from '../scrapers/actressScraperManager'
import { resolveVideoScrapeFieldSources, scrapeVideo } from '../scrapers/scraperManager'
import { getActressDetail } from '../db/actressRepo'
import { countVideosForRematch } from '../db/videoRepo'
import { resolveVideoBatchTargets } from './videoImageAvailability'
import {
  AvatarAutoCropMediator,
  type AvatarAutoCropMediatorDependencies
} from './avatarAutoCropMediator'

type ProgressListener = (progress: BatchProgress) => void

interface BatchQueue<Request> {
  isRunning(): boolean
  setListener(listener: ProgressListener): void
  start(request?: Request | string): Promise<void>
  resume(): Promise<void>
  pause(): void
  discard(): void
  setCheckpointPort(port: BatchScrapeCheckpointPort): void
}

interface ActressBatchQueue extends BatchQueue<ActressBatchScrapeRequest> {
  setAvatarAutoCropListener(
    listener: (target: ActressAvatarAutoCropTarget) => Promise<ActressAvatarAutoCropOutcome>
  ): void
}

interface RunCoordinator {
  isRunning(): boolean
  getActiveLabel(): string | null
  runExclusive<T>(label: string, run: () => Promise<T>): Promise<T>
}

interface VideoScrapeOutcome {
  ok: boolean
  result?: ScrapeResult | null
  skipped?: boolean
  warnings?: string[]
  error?: string
}

export interface ScrapeJobControllerDependencies {
  coordinator: RunCoordinator
  assertBatchAvailable(): void
  getBatchState(): BatchScrapeState
  videoQueue: BatchQueue<VideoBatchScrapeRequest>
  actressQueue: ActressBatchQueue
  scrapeVideo(
    videoId: number,
    scraperName?: string,
    options?: { fields?: VideoScrapeField[]; mode?: VideoScrapeUpdateMode }
  ): Promise<VideoScrapeOutcome>
  scrapeActress(
    actressId: number,
    scraperName?: string,
    options?: {
      fields?: ActressScrapeField[]
      mode?: ActressScrapeUpdateMode
      queryName?: string
      useAliases?: boolean
    }
  ): Promise<ActressScrapeDisposition>
  getActress(id: number): ActressDetail | null
  countVideos(filter: VideoBatchScrapeFilter & Record<string, unknown>): number
  countRematches(scope: VideoRematchScope): number
  countActresses(filter: ActressBatchScrapeFilter): number
  resolveVideoFieldSources(scraperName?: string): Record<string, unknown>
  emit<Channel extends ScrapeIpcEventChannel>(
    channel: Channel,
    payload: ScrapeIpcEvent<Channel>
  ): void
  rendererAvailable(): boolean
  checkpoints: BatchScrapeCheckpointPort
  avatarAutoCrop?: AvatarAutoCropMediator
  avatarAutoCropOptions?: Partial<
    Pick<AvatarAutoCropMediatorDependencies, 'randomId' | 'autoCropTimeoutMs'>
  >
}

export class ScrapeJobController {
  private readonly avatarAutoCrop: AvatarAutoCropMediator

  constructor(private readonly dependencies: ScrapeJobControllerDependencies) {
    this.avatarAutoCrop =
      dependencies.avatarAutoCrop ??
      new AvatarAutoCropMediator({
        emit: (channel, payload) => this.dependencies.emit(channel, payload),
        rendererAvailable: () => this.dependencies.rendererAvailable(),
        randomId: dependencies.avatarAutoCropOptions?.randomId ?? randomUUID,
        autoCropTimeoutMs: dependencies.avatarAutoCropOptions?.autoCropTimeoutMs ?? 5_000,
        assertCanBeginBatch: () => this.assertQueuesIdleForNewBatch()
      })
  }

  initialize(): void {
    this.avatarAutoCrop.clearBatchToken()
    const interrupted = this.dependencies.checkpoints.load()
    if (interrupted?.status === 'running') {
      this.dependencies.checkpoints.markPaused(
        interrupted,
        this.dependencies.checkpoints.toProgress(interrupted)
      )
    }
    this.dependencies.actressQueue.setAvatarAutoCropListener((target) =>
      this.avatarAutoCrop.request(target)
    )
    this.dependencies.videoQueue.setCheckpointPort(this.dependencies.checkpoints)
    this.dependencies.actressQueue.setCheckpointPort(this.dependencies.checkpoints)
  }

  rendererDisconnected(): void {
    this.avatarAutoCrop.rendererDisconnected()
  }

  requestAvatarAutoCrop(
    target: ActressAvatarAutoCropTarget
  ): Promise<ActressAvatarAutoCropOutcome> {
    return this.avatarAutoCrop.request(target)
  }

  completeAvatarAutoCrop(response: ActressAvatarAutoCropResponse): boolean {
    return this.avatarAutoCrop.complete(response)
  }

  async scrapeOneVideo(
    videoId: number,
    scraperName?: string,
    fields?: VideoScrapeField[],
    mode?: VideoScrapeUpdateMode
  ): Promise<VideoScrapeOneResult> {
    this.dependencies.assertBatchAvailable()
    const outcome = await this.dependencies.coordinator.runExclusive('影片刮削', () =>
      this.dependencies.scrapeVideo(videoId, scraperName, { fields, mode })
    )
    if (!outcome.ok || !outcome.result) throw new Error(outcome.error)
    return {
      result: outcome.result,
      applied: !outcome.skipped,
      warnings: outcome.warnings ?? []
    }
  }

  scrapeOneActress(
    actressId: number,
    scraperName?: string,
    fields?: ActressScrapeField[],
    mode?: ActressScrapeUpdateMode,
    queryName?: string,
    useAliases?: boolean,
    autoCropAvatar?: boolean
  ): Promise<ActressScrapeDisposition> {
    this.dependencies.assertBatchAvailable()
    return this.dependencies.coordinator.runExclusive('演员刮削', async () => {
      const result = await this.dependencies.scrapeActress(actressId, scraperName, {
        fields,
        mode,
        queryName,
        useAliases
      })
      if (
        result.status === 'success' &&
        autoCropAvatar &&
        fields?.includes('avatar') &&
        result.avatarUpdated &&
        !result.skipped
      ) {
        const actress = this.dependencies.getActress(actressId)
        if (actress) {
          await this.avatarAutoCrop.request({ actressId, mainName: actress.main_name })
        }
      }
      return result
    })
  }

  getBatchState(): BatchScrapeState {
    return this.dependencies.getBatchState()
  }

  countVideoBatch(filter: VideoBatchScrapeFilter): number {
    return this.dependencies.countVideos({
      ...filter,
      ...this.dependencies.resolveVideoFieldSources(filter.scraperName)
    })
  }

  countRematches(scope: VideoRematchScope): number {
    return this.dependencies.countRematches(scope)
  }

  countActressBatch(filter: ActressBatchScrapeFilter): number {
    return this.dependencies.countActresses(filter)
  }

  startLegacyVideoBatch(scraperName?: string): boolean {
    return this.startVideoBatch(IPC.SCRAPE_BATCH_PROGRESS, {
      scraperName,
      status: 0,
      fields: ALL_VIDEO_SCRAPE_FIELDS,
      mode: 'replace'
    })
  }

  startVideoBatch(
    progressChannel:
      | typeof IPC.SCRAPE_BATCH_PROGRESS
      | typeof IPC.SCRAPE_VIDEO_BATCH_PROGRESS
      | typeof IPC.SCRAPE_REMATCH_BATCH_PROGRESS,
    request: VideoBatchScrapeRequest
  ): boolean {
    this.assertCanStartNewBatch()
    if (!request.fields?.length) throw new Error('请至少选择一个要更新的字段')
    this.dependencies.videoQueue.setListener((progress) =>
      this.dependencies.emit(progressChannel, progress)
    )
    void this.dependencies.coordinator
      .runExclusive('影片批量更新', () => this.dependencies.videoQueue.start(request))
      .catch((error) => console.error('video batch scrape failed:', error))
    return true
  }

  startRematchBatch(request: VideoRematchBatchRequest): boolean {
    return this.startVideoBatch(IPC.SCRAPE_REMATCH_BATCH_PROGRESS, {
      scraperName: request.scraperName,
      fields: request.fields,
      status: rematchScopeToBatchStatus(request.scope),
      mode: request.mode ?? 'replace'
    })
  }

  startActressBatch(request?: ActressBatchScrapeRequest | string): boolean {
    this.assertCanStartNewBatch()
    if (typeof request !== 'string' && request && !request.fields?.length) {
      throw new Error('请至少选择一个要更新的字段')
    }
    this.dependencies.actressQueue.setListener((progress) =>
      this.dependencies.emit(IPC.ACTRESS_SCRAPE_BATCH_PROGRESS, progress)
    )
    void this.dependencies.coordinator
      .runExclusive('演员批量刮削', () => this.dependencies.actressQueue.start(request))
      .catch((error) => console.error('actress scrape batch failed:', error))
    return true
  }

  pauseVideoBatch(): boolean {
    if (!this.dependencies.videoQueue.isRunning()) return false
    this.dependencies.videoQueue.pause()
    return true
  }

  pauseActressBatch(): boolean {
    if (!this.dependencies.actressQueue.isRunning()) return false
    this.dependencies.actressQueue.pause()
    return true
  }

  pauseActiveBatch(): boolean {
    if (this.dependencies.videoQueue.isRunning()) return this.pauseVideoBatch()
    if (this.dependencies.actressQueue.isRunning()) return this.pauseActressBatch()
    return false
  }

  resumeActiveBatch(): boolean {
    this.assertCanResumeBatch()
    const job = this.dependencies.checkpoints.load()
    if (!job) throw new Error('没有可继续的批量刮削任务')
    if (job.kind === 'video') {
      this.dependencies.videoQueue.setListener((progress) =>
        this.dependencies.emit(IPC.SCRAPE_VIDEO_BATCH_PROGRESS, progress)
      )
      void this.dependencies.coordinator
        .runExclusive('影片批量更新', () => this.dependencies.videoQueue.resume())
        .catch((error) => console.error('video batch scrape resume failed:', error))
      return true
    }
    this.dependencies.actressQueue.setListener((progress) =>
      this.dependencies.emit(IPC.ACTRESS_SCRAPE_BATCH_PROGRESS, progress)
    )
    void this.dependencies.coordinator
      .runExclusive('演员批量刮削', () => this.dependencies.actressQueue.resume())
      .catch((error) => console.error('actress batch scrape resume failed:', error))
    return true
  }

  discardActiveBatch(): boolean {
    const job = this.dependencies.checkpoints.load()
    if (!job) return false
    if (job.kind === 'video') {
      this.dependencies.videoQueue.discard()
      if (!this.dependencies.videoQueue.isRunning()) {
        this.dependencies.emit(IPC.SCRAPE_VIDEO_BATCH_PROGRESS, idleBatchProgress())
      }
      return true
    }
    this.dependencies.actressQueue.discard()
    if (!this.dependencies.actressQueue.isRunning()) {
      this.dependencies.emit(IPC.ACTRESS_SCRAPE_BATCH_PROGRESS, idleBatchProgress())
    }
    return true
  }

  beginAvatarAutoCropBatch(): string {
    return this.avatarAutoCrop.beginBatch()
  }

  endAvatarAutoCropBatch(token: string): boolean {
    return this.avatarAutoCrop.endBatch(token)
  }

  private assertQueuesIdleForNewBatch(): void {
    this.dependencies.assertBatchAvailable()
    if (this.dependencies.videoQueue.isRunning()) throw new Error('影片批量更新已在进行中')
    if (this.dependencies.actressQueue.isRunning()) throw new Error('演员批量刮削已在进行中')
  }

  private assertCanStartNewBatch(): void {
    if (this.avatarAutoCrop.hasActiveBatch()) {
      throw new Error('批量智能构图正在进行中，请完成或停止后再试')
    }
    this.assertQueuesIdleForNewBatch()
  }

  private assertCanResumeBatch(): void {
    if (this.avatarAutoCrop.hasActiveBatch()) {
      throw new Error('批量智能构图正在进行中，请完成或停止后再试')
    }
    if (this.dependencies.coordinator.isRunning()) {
      throw new Error(`${this.dependencies.coordinator.getActiveLabel()}进行中，请稍后再试`)
    }
    if (this.dependencies.videoQueue.isRunning() || this.dependencies.actressQueue.isRunning()) {
      throw new Error('批量刮削已在进行中')
    }
    const job = this.dependencies.checkpoints.load()
    if (!job) throw new Error('没有可继续的批量刮削任务')
    if (job.kind === 'actress') this.dependencies.checkpoints.assertActressRecoverable(job)
  }
}

export function createScrapeJobController(
  dependencies: ScrapeJobControllerDependencies
): ScrapeJobController {
  return new ScrapeJobController(dependencies)
}

export function createDefaultScrapeJobController(
  boundary: Pick<ScrapeJobControllerDependencies, 'emit' | 'rendererAvailable'>
): ScrapeJobController {
  return createScrapeJobController({
    coordinator: scrapeRunCoordinator,
    assertBatchAvailable: assertBatchScrapeAvailable,
    getBatchState: getBatchScrapeState,
    videoQueue: videoBatchScrapeQueue,
    actressQueue: actressScrapeQueue,
    scrapeVideo,
    scrapeActress,
    getActress: getActressDetail,
    countVideos: (filter) => resolveVideoBatchTargets(filter).length,
    countRematches: countVideosForRematch,
    countActresses: estimateActressBatchScrapeTargetCount,
    resolveVideoFieldSources: resolveVideoScrapeFieldSources,
    checkpoints: defaultBatchScrapeCheckpoints,
    ...boundary
  })
}

const defaultBatchScrapeCheckpoints: BatchScrapeCheckpointPort = {
  load: loadBatchScrapeJob,
  create: createBatchScrapeJob,
  persist: persistBatchScrapeCheckpoint,
  markPaused: markBatchScrapePaused,
  finish: finishBatchScrapeJob,
  discard: discardBatchScrapeJob,
  toProgress: jobToBatchProgress,
  restoreTargets: restoreTargetsFromJob,
  assertActressRecoverable: assertActressBatchJobRecoverable
}

function rematchScopeToBatchStatus(scope: VideoRematchScope): VideoBatchScrapeStatus {
  if (scope === 'scraped') return 1
  if (scope === 'failed') return 2
  return 'all'
}

function idleBatchProgress(): BatchProgress {
  return {
    total: 0,
    current: 0,
    success: 0,
    pending: 0,
    failed: 0,
    currentCode: null,
    status: 'idle',
    logs: []
  }
}
