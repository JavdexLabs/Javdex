import type { BatchProgress } from '@shared/types'
import {
  clearBatchScrapeJob,
  hasPausedBatchScrapeJob,
  jobToBatchProgress,
  loadBatchScrapeJob,
  saveBatchScrapeJob,
  type BatchScrapeJobKind,
  type BatchScrapeJobTarget,
  type PersistedBatchScrapeJob
} from './batchScrapeJobStore'
import { scrapeRunCoordinator } from './scrapeRunCoordinator'

export function assertBatchScrapeAvailable(): void {
  const active = scrapeRunCoordinator.getActiveLabel()
  if (active) {
    throw new Error(`${active}进行中，请稍后再试`)
  }
  if (hasPausedBatchScrapeJob()) {
    throw new Error('存在已暂停的批量刮削任务，请先继续或终止后再试')
  }
}

export function getBatchScrapeState(): {
  kind: BatchScrapeJobKind | null
  progress: BatchProgress | null
} {
  let job = loadBatchScrapeJob()
  if (!job) return { kind: null, progress: null }
  if (job.status === 'running') {
    job = { ...job, status: 'paused' }
    saveBatchScrapeJob(job)
  }
  return { kind: job.kind, progress: jobToBatchProgress(job) }
}

export function createBatchScrapeJob<TTarget extends { id: number }>(
  kind: BatchScrapeJobKind,
  request: PersistedBatchScrapeJob['request'],
  targets: TTarget[],
  getLabel: (target: TTarget) => string
): PersistedBatchScrapeJob {
  return {
    kind,
    request,
    targets: targets.map((target) => ({ id: target.id, label: getLabel(target) })),
    nextIndex: 0,
    success: 0,
    failed: 0,
    logs: [],
    total: targets.length,
    status: 'running',
    updatedAt: new Date().toISOString()
  }
}

export function persistBatchScrapeCheckpoint(
  job: PersistedBatchScrapeJob,
  progress: BatchProgress,
  nextIndex: number,
  status: PersistedBatchScrapeJob['status'] = 'running'
): void {
  saveBatchScrapeJob({
    ...job,
    nextIndex,
    success: progress.success,
    failed: progress.failed,
    logs: progress.logs,
    total: progress.total,
    status
  })
}

export function markBatchScrapePaused(job: PersistedBatchScrapeJob, progress: BatchProgress): void {
  persistBatchScrapeCheckpoint(job, progress, progress.current, 'paused')
}

export function finishBatchScrapeJob(): void {
  clearBatchScrapeJob()
}

export function discardBatchScrapeJob(): void {
  clearBatchScrapeJob()
}

export function restoreTargetsFromJob<T extends { id: number }>(
  job: PersistedBatchScrapeJob,
  buildTarget: (item: BatchScrapeJobTarget) => T
): T[] {
  return job.targets.map(buildTarget)
}
