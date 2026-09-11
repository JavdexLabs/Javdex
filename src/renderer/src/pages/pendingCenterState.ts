import type { ActressConflictQueueItem } from '@shared/actressConflictTypes'
import type {
  PendingScanQueueItem,
  PendingScanResource,
  PendingScanResourceTarget
} from '@shared/libraryTypes'
import type { PendingVideoScrapeSummary } from '@shared/videoScrapeTypes'
import { selectDefaultPendingScanPrimary } from '@shared/pendingScanPrimary'
import {
  PENDING_DOMAINS,
  pendingItemKey,
  samePendingItemKey,
  type PendingDomain,
  type PendingItemKey,
  type PendingTypeFilter
} from '../listView/pendingRoutes'

function pendingPathOrderKey(filePath: string): string {
  const slashNormalized = filePath.replaceAll('\\', '/')
  const platform =
    typeof navigator !== 'undefined'
      ? navigator.platform.toLowerCase()
      : typeof process !== 'undefined'
        ? process.platform
        : ''
  return platform.includes('mac') || platform.includes('win')
    ? slashNormalized.toLowerCase()
    : slashNormalized
}

export function arePendingScanAssignmentsComplete(
  resourceIds: readonly number[],
  assignments: Readonly<Record<number, PendingScanResourceTarget | undefined>>
): boolean {
  return resourceIds.length > 0 && resourceIds.every((resourceId) => {
    const target = assignments[resourceId]
    if (!target) return false
    return target.kind === 'existing'
      ? Number.isInteger(target.videoId) && target.videoId > 0
      : target.groupKey.trim().length > 0
  })
}

export function pendingScanTargetValue(target: PendingScanResourceTarget | undefined): string {
  if (!target) return ''
  return target.kind === 'existing'
    ? `existing:${target.videoId}`
    : `new:${target.groupKey}`
}

export function pendingScanTargetFromValue(value: string): PendingScanResourceTarget | undefined {
  if (value.startsWith('existing:')) {
    const videoId = Number(value.slice('existing:'.length))
    return Number.isInteger(videoId) && videoId > 0
      ? { kind: 'existing', videoId }
      : undefined
  }
  if (value.startsWith('new:')) {
    const groupKey = value.slice('new:'.length).trim()
    return groupKey ? { kind: 'new', groupKey } : undefined
  }
  return undefined
}

export function defaultPendingScanPrimaryResourceId(
  resources: readonly PendingScanResource[]
): number | null {
  return selectDefaultPendingScanPrimary(resources, pendingPathOrderKey)?.id ?? null
}

export function arePendingScrapeSelectionsComplete(
  sources: ReadonlyArray<{
    id: number
    candidates: ReadonlyArray<{ id: number }>
  }>,
  selections: Readonly<Record<number, number>>
): boolean {
  return sources.length > 0 && sources.every((source) => {
    const selectedId = selections[source.id]
    return selectedId != null && source.candidates.some((candidate) => candidate.id === selectedId)
  })
}

export function pendingResourceDisplayName(resource: PendingScanResource): string {
  return resource.displayName || resource.filePath.split(/[\\/]/).at(-1) || resource.filePath
}

export interface PendingScanAssignmentSummary {
  key: string
  label: string
  detail: string
}

/** Preview of what "确认全部分配" will create, grouped by assignment target. */
export function summarizePendingScanAssignments(
  resources: readonly PendingScanResource[],
  assignments: Readonly<Record<number, PendingScanResourceTarget | undefined>>,
  primaryByGroup: Readonly<Record<string, number>>
): PendingScanAssignmentSummary[] {
  const buckets = new Map<string, { label: string; groupKey: string | null; items: PendingScanResource[] }>()
  for (const resource of resources) {
    const target = assignments[resource.id]
    if (!target) continue
    const key = pendingScanTargetValue(target)
    const bucket = buckets.get(key) ?? {
      label:
        target.kind === 'existing'
          ? `现有影片 #${target.videoId}`
          : `新建影片 ${target.groupKey}`,
      groupKey: target.kind === 'new' ? target.groupKey : null,
      items: []
    }
    bucket.items.push(resource)
    buckets.set(key, bucket)
  }
  return [...buckets.entries()].map(([key, bucket]) => {
    const parts = [`${bucket.items.length} 条资源`]
    if (bucket.groupKey) {
      const primaryId =
        primaryByGroup[bucket.groupKey] ?? defaultPendingScanPrimaryResourceId(bucket.items)
      const primary = bucket.items.find((item) => item.id === primaryId)
      parts.push(`主资源 ${primary ? pendingResourceDisplayName(primary) : '未指定'}`)
    }
    return { key, label: bucket.label, detail: parts.join(' · ') }
  })
}

export const PENDING_DOMAIN_LABEL: Record<PendingDomain, string> = {
  scan: '扫描资源',
  scrape: '影片刮削',
  actress: '演员名称冲突'
}

export interface PendingQueueItem {
  key: PendingItemKey
  title: string
  meta: string
  coverPath: string | null
  /** Conflicts already cleared; only an explicit apply is left. */
  ready: boolean
}

export interface PendingQueueSection {
  domain: PendingDomain
  label: string
  items: PendingQueueItem[]
}

export interface PendingQueueInput {
  scanItems: readonly PendingScanQueueItem[]
  scrapeItems: readonly PendingVideoScrapeSummary[]
  conflictItems: readonly ActressConflictQueueItem[]
  libraryNames?: ReadonlyMap<number, string>
}

function scanQueueItem(
  item: PendingScanQueueItem,
  libraryNames?: ReadonlyMap<number, string>
): PendingQueueItem {
  const libraryName = libraryNames?.get(item.libraryId) ?? `媒体库 #${item.libraryId}`
  return {
    key: pendingItemKey('scan', item.kind === 'group' ? item.id : `identity-${item.id}`),
    title: item.label,
    meta: `${libraryName} · ${item.kind === 'group' ? `${item.resourceCount} 条资源` : item.displayName}`,
    coverPath: null,
    ready: false
  }
}

function scrapeQueueItem(scrape: PendingVideoScrapeSummary): PendingQueueItem {
  return {
    key: pendingItemKey('scrape', scrape.id),
    title: scrape.code || `影片 #${scrape.videoId}`,
    meta: `${scrape.candidateCount} 个候选 · ${scrape.sourceCount} 个来源`,
    coverPath: scrape.stagedCoverPath,
    ready: false
  }
}

function actressQueueItem(group: ActressConflictQueueItem): PendingQueueItem {
  const claimCount = group.pendingNameClaimCount
  return {
    key: pendingItemKey('actress', group.normalizedName),
    title: group.displayName,
    meta:
      group.status === 'applicable'
        ? '冲突已解除，等待应用'
        : `刮削 ${group.candidateCount} · 历史 ${claimCount}`,
    coverPath: group.avatarPath,
    ready: group.status === 'applicable'
  }
}

/** Build the unified inbox queue; empty domains drop out so the rail never shows a dead section. */
export function buildPendingQueueSections(
  input: PendingQueueInput,
  type: PendingTypeFilter
): PendingQueueSection[] {
  const byDomain: Record<PendingDomain, PendingQueueItem[]> = {
    scan: input.scanItems.map((item) => scanQueueItem(item, input.libraryNames)),
    scrape: input.scrapeItems.map(scrapeQueueItem),
    actress: input.conflictItems.map(actressQueueItem)
  }
  return PENDING_DOMAINS.filter((domain) => type === 'all' || type === domain)
    .map((domain) => ({ domain, label: PENDING_DOMAIN_LABEL[domain], items: byDomain[domain] }))
    .filter((section) => section.items.length > 0)
}

export function pendingQueueTotal(sections: readonly PendingQueueSection[]): number {
  return sections.reduce((sum, section) => sum + section.items.length, 0)
}

/**
 * Keep the URL selection when it still exists, otherwise fall back to the first
 * queue item so the workspace is never blank while work remains.
 */
export function resolvePendingSelection(
  sections: readonly PendingQueueSection[],
  requested: PendingItemKey | null,
  preferredDomain?: PendingDomain | null
): PendingItemKey | null {
  const items = sections.flatMap((section) => section.items)
  const match = items.find((item) => samePendingItemKey(item.key, requested))
  return match?.key ?? items.find(item => item.key.domain === preferredDomain)?.key ?? items[0]?.key ?? null
}
