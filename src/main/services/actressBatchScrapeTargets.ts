import type {
  ActressBatchScrapeFilter,
  ActressBatchScrapeRequest,
  ActressBatchScrapeStatus,
  LegacyActressBatchScrapeStatus
} from '@shared/types'
import { listActressesForBatchScrape, type ActressBatchTarget } from '../db/actressRepo'

/** Batch filter as received over IPC or read back from a persisted job snapshot. */
export type ActressBatchScrapeFilterInput = Omit<ActressBatchScrapeFilter, 'scrapeStatus'> & {
  scrapeStatus?: string
}

/** Batch request as received over IPC or read back from a persisted job snapshot. */
export type ActressBatchScrapeRequestInput = Omit<ActressBatchScrapeRequest, 'scrapeStatus'> & {
  scrapeStatus?: string
}

/** Filter whose cumulative-status scope has been resolved to a canonical value. */
export type NormalizedActressBatchScrapeFilter = ActressBatchScrapeFilter & {
  scrapeStatus: ActressBatchScrapeStatus
}

/** Request whose cumulative-status scope has been resolved to a canonical value. */
export type NormalizedActressBatchScrapeRequest = ActressBatchScrapeRequest & {
  scrapeStatus: ActressBatchScrapeStatus
}

export type ActressBatchScrapeStatusParse =
  | { ok: true; status: ActressBatchScrapeStatus }
  | { ok: false; value: string }

const CANONICAL_STATUSES = new Set<string>([
  'unscraped',
  'success',
  'failed',
  'all'
] satisfies ActressBatchScrapeStatus[])

const LEGACY_STATUSES: Record<LegacyActressBatchScrapeStatus, ActressBatchScrapeStatus> = {
  scraped: 'success'
}

/**
 * Lenient status read shared by new requests and persisted job snapshots.
 * An omitted scope means every actress; the legacy two-state value means 刮削成功.
 */
export function parseActressBatchScrapeStatus(value: unknown): ActressBatchScrapeStatusParse {
  if (value === undefined || value === null) return { ok: true, status: 'all' }
  if (typeof value === 'string') {
    if (CANONICAL_STATUSES.has(value)) {
      return { ok: true, status: value as ActressBatchScrapeStatus }
    }
    const legacy = LEGACY_STATUSES[value as LegacyActressBatchScrapeStatus]
    if (legacy) return { ok: true, status: legacy }
  }
  return { ok: false, value: String(value) }
}

/** Status of a new request. Unknown values are rejected instead of widening the batch. */
export function normalizeActressBatchScrapeStatus(value: unknown): ActressBatchScrapeStatus {
  const parsed = parseActressBatchScrapeStatus(value)
  if (!parsed.ok) throw new Error(`未知的演员刮削状态范围：${parsed.value}`)
  return parsed.status
}

/** Deduplicated finite ids, or an empty list when the input carries no explicit ids. */
function explicitActressBatchIds(actressIds: readonly number[] | undefined): number[] {
  if (!actressIds) return []
  return Array.from(new Set(actressIds.map(Number).filter((id) => Number.isFinite(id))))
}

export function normalizeActressBatchScrapeFilter(
  input: ActressBatchScrapeFilterInput
): NormalizedActressBatchScrapeFilter {
  const filter: NormalizedActressBatchScrapeFilter = {
    scope: input.scope,
    scrapeStatus: normalizeActressBatchScrapeStatus(input.scrapeStatus),
    missingFields: input.missingFields
  }
  if (input.actressIds) filter.actressIds = explicitActressBatchIds(input.actressIds)
  return filter
}

export function normalizeActressBatchScrapeRequest(
  input: ActressBatchScrapeRequestInput
): NormalizedActressBatchScrapeRequest {
  return { ...input, ...normalizeActressBatchScrapeFilter(input) }
}

/**
 * Targets of a normalized filter, resolved against the actresses stored right now.
 * Explicit ids are the authoritative target set: gender, cumulative status and
 * missing-field filters are ignored, and ids without a stored actress drop out.
 */
export function resolveActressBatchScrapeTargets(
  filter: NormalizedActressBatchScrapeFilter
): ActressBatchTarget[] {
  if (filter.actressIds) {
    return listActressesForBatchScrape({
      actressIds: filter.actressIds,
      scope: 'all',
      scrapeStatus: 'all',
      missingFields: []
    })
  }
  return listActressesForBatchScrape(filter)
}

/**
 * Target count for the advanced scrape UI. The estimate reflects the data at query
 * time; a batch resolves its targets again on start, so totals may differ.
 */
export function estimateActressBatchScrapeTargetCount(
  input: ActressBatchScrapeFilterInput
): number {
  return resolveActressBatchScrapeTargets(normalizeActressBatchScrapeFilter(input)).length
}
