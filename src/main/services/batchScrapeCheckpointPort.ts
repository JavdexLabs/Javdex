import type { BatchProgress } from '@shared/scrapeTypes'
import type {
  BatchScrapeJobKind,
  BatchScrapeJobTarget,
  PersistedBatchScrapeJob
} from './batchScrapeJobStore'

export interface BatchScrapeCheckpointPort {
  load(): PersistedBatchScrapeJob | null
  create<TTarget extends { id: number }>(
    kind: BatchScrapeJobKind,
    request: PersistedBatchScrapeJob['request'],
    targets: TTarget[],
    getLabel: (target: TTarget) => string
  ): PersistedBatchScrapeJob
  persist(
    job: PersistedBatchScrapeJob,
    progress: BatchProgress,
    nextIndex: number,
    status?: PersistedBatchScrapeJob['status']
  ): void
  markPaused(job: PersistedBatchScrapeJob, progress: BatchProgress): void
  finish(): void
  discard(): void
  toProgress(job: PersistedBatchScrapeJob): BatchProgress
  restoreTargets<T extends { id: number }>(
    job: PersistedBatchScrapeJob,
    buildTarget: (item: BatchScrapeJobTarget) => T
  ): T[]
  assertActressRecoverable(job: PersistedBatchScrapeJob): PersistedBatchScrapeJob
}
