import type { BatchProgress } from '@shared/types'

/** True only while a batch is in-flight; done/cancelled results stay visible but are not “active”. */
export function isBatchScrapeActive(batch: BatchProgress | null): boolean {
  return batch?.status === 'running' || batch?.status === 'paused'
}
