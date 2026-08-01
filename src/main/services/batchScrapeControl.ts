import type { BatchProgress, BatchScrapeState } from '@shared/types'
import { randomUUID } from 'node:crypto'
import { reconcilePersistedActressBatchJob } from './actressBatchScrapeTargets'
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

/**
 * Apply actress load-time status reconciliation and persist rewritten scopes.
 * Returns the job that callers should use for viewing or resume decisions.
 */
export function prepareLoadedBatchScrapeJob(
  job: PersistedBatchScrapeJob
): {
  job: PersistedBatchScrapeJob
  recoverable: boolean
  unrecoverableReason?: string
} {
  if (job.kind !== 'actress') {
    return { job, recoverable: true }
  }
  const reconciled = reconcilePersistedActressBatchJob(job)
  if (reconciled.rewritten) {
    saveBatchScrapeJob(reconciled.job)
  }
  if (!reconciled.recoverable) {
    return {
      job: reconciled.job,
      recoverable: false,
      unrecoverableReason: reconciled.reason
    }
  }
  return { job: reconciled.job, recoverable: true }
}

/** Throws when an actress batch job cannot be resumed safely. */
export function assertActressBatchJobRecoverable(job: PersistedBatchScrapeJob): PersistedBatchScrapeJob {
  const prepared = prepareLoadedBatchScrapeJob(job)
  if (!prepared.recoverable) {
    throw new Error(prepared.unrecoverableReason ?? '该演员批量任务不可恢复')
  }
  return prepared.job
}

export function getBatchScrapeState(): BatchScrapeState {
  let job = loadBatchScrapeJob()
  if (!job) return { kind: null, progress: null, recoverable: true }
  if (job.status === 'running') {
    job = { ...job, status: 'paused' }
    saveBatchScrapeJob(job)
  }
  const prepared = prepareLoadedBatchScrapeJob(job)
  return {
    kind: prepared.job.kind,
    progress: jobToBatchProgress(prepared.job),
    recoverable: prepared.recoverable,
    unrecoverableReason: prepared.unrecoverableReason
  }
}

export function createBatchScrapeJob<TTarget extends { id: number }>(
  kind: BatchScrapeJobKind,
  request: PersistedBatchScrapeJob['request'],
  targets: TTarget[],
  getLabel: (target: TTarget) => string
): PersistedBatchScrapeJob {
  return {
    jobId: randomUUID(),
    kind,
    request,
    targets: targets.map((target) => ({ id: target.id, label: getLabel(target) })),
    nextIndex: 0,
    success: 0,
    pending: 0,
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
    pending: progress.pending,
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
