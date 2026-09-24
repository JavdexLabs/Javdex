import type { LocalNfoAnchor, LocalNfoIdentityInspection } from '@library/nfo/localNfoTypes'

export type LocalNfoScanDisposition =
  | 'none'
  | 'imported'
  | 'skipped'
  | 'warning'
  | 'pending-candidate'

export interface LocalNfoScanApplyResult {
  disposition: LocalNfoScanDisposition
  warnings: string[]
  pendingScrapeId?: number
}

export interface LocalNfoScanService {
  inspectIdentity(anchor: LocalNfoAnchor): LocalNfoIdentityInspection
  /** Before DB commit, not proof of commit. No-write outcomes may run without a business transaction.
   * Returned warnings may grow during post-commit asset handling. */
  apply(
    videoId: number,
    code: string,
    anchors: readonly LocalNfoAnchor[],
    beforeCommit?: (result: LocalNfoScanApplyResult) => void
  ): Promise<LocalNfoScanApplyResult>
}

let configured: LocalNfoScanService | null = null

export function configureLocalNfoScanService(service: LocalNfoScanService): void {
  configured = service
}

export function resetLocalNfoScanServiceForTests(): void {
  configured = null
}

export function getConfiguredLocalNfoScanService(): LocalNfoScanService {
  if (!configured) throw new Error('Local NFO scan service is not configured')
  return configured
}
