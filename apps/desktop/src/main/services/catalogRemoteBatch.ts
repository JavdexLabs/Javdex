import { DIRECT_ID_BATCH_MAX } from '@shared/protocol/limits'
import type { TargetListCreateInput, TargetListPage } from '@shared/protocol/tasks'
import type { ActressBatchScrapeFilter } from '@shared/actressScrapeTypes'
import type { VideoBatchScrapeFilter } from '@shared/videoScrapeTypes'
import {
  compactTargetActressFilter,
  compactTargetVideoFilter,
  targetListRequestDigest
} from '@library/catalog/catalogTargetLists'
import type { CatalogBackend } from '../application/catalogBackend'
import { ipcMutation } from '../application/mutationContext'

const REMOTE_EXPLICIT_ID_MAX = DIRECT_ID_BATCH_MAX

function uniqueIds(ids: readonly number[] | undefined): number[] {
  if (!ids) return []
  return Array.from(new Set(ids.filter((id) => Number.isFinite(id))))
}

function assertRemoteExplicitCount(kind: 'video' | 'actress', count: number): void {
  if (count <= REMOTE_EXPLICIT_ID_MAX) return
  throw new Error(
    kind === 'video'
      ? '远程已选影片不能超过 200 部；更大范围请用筛选条件冻结'
      : '远程已选演员不能超过 200 位；更大范围请用筛选条件冻结'
  )
}

async function createRemoteTargetList(
  backend: CatalogBackend,
  input: TargetListCreateInput
): Promise<{ targetListId: string; count: number }> {
  return (await backend.tasks.createTargetList(input, ipcMutation())) as {
    targetListId: string
    count: number
  }
}

async function pageAllTargetEntries(
  backend: CatalogBackend,
  targetListId: string
): Promise<NonNullable<TargetListPage['entries']>> {
  const entries: NonNullable<TargetListPage['entries']> = []
  let offset = 0
  for (;;) {
    const page = (await backend.tasks.pageTargetList({
      targetListId,
      offset,
      limit: REMOTE_EXPLICIT_ID_MAX
    })) as TargetListPage
    const pageEntries =
      page.entries ??
      page.ids.map((id) => ({ id, present: true as const, label: null, revision: null }))
    entries.push(...pageEntries)
    if (!page.hasMore) break
    offset += page.ids.length
    if (page.ids.length === 0) break
  }
  return entries
}

function presentTargets<T extends { id: number }>(
  entries: NonNullable<TargetListPage['entries']>,
  toTarget: (id: number, label: string | null | undefined) => T
): T[] {
  return entries
    .filter((entry) => entry.present !== false)
    .map((entry) => toTarget(entry.id, entry.label))
}

export function remoteVideoTargetListInput(filter: VideoBatchScrapeFilter): TargetListCreateInput {
  const ids = uniqueIds(filter.videoIds)
  if (ids.length > 0) {
    assertRemoteExplicitCount('video', ids.length)
    const input = { kind: 'videos.ids', ids }
    return { ...input, filterDigest: targetListRequestDigest(input) }
  }
  const videoFilter = compactTargetVideoFilter({
    libraryId: filter.libraryId,
    status: filter.status,
    missingFields: filter.missingFields,
    sourceName: filter.sourceName,
    ratingSourceName: filter.ratingSourceName
  })
  const input = { kind: 'videos.filter', videoFilter }
  return { ...input, filterDigest: targetListRequestDigest(input) }
}

export function remoteActressTargetListInput(filter: ActressBatchScrapeFilter): TargetListCreateInput {
  const ids = uniqueIds(filter.actressIds)
  if (ids.length > 0) {
    assertRemoteExplicitCount('actress', ids.length)
    const input = { kind: 'actresses.ids', ids }
    return { ...input, filterDigest: targetListRequestDigest(input) }
  }
  const actressFilter = compactTargetActressFilter({
    scope: filter.scope,
    scrapeStatus: filter.scrapeStatus,
    missingFields: filter.missingFields
  })
  const input = { kind: 'actresses.filter', actressFilter }
  return { ...input, filterDigest: targetListRequestDigest(input) }
}

export async function freezeRemoteVideoTargets(
  backend: CatalogBackend,
  filter: VideoBatchScrapeFilter
): Promise<Array<{ id: number; code: string }>> {
  const created = await createRemoteTargetList(backend, remoteVideoTargetListInput(filter))
  const entries = await pageAllTargetEntries(backend, created.targetListId)
  return presentTargets(entries, (id, label) => ({ id, code: label?.trim() || `#${id}` }))
}

export async function freezeRemoteActressTargets(
  backend: CatalogBackend,
  filter: ActressBatchScrapeFilter
): Promise<Array<{ id: number; main_name: string }>> {
  const created = await createRemoteTargetList(backend, remoteActressTargetListInput(filter))
  const entries = await pageAllTargetEntries(backend, created.targetListId)
  return presentTargets(entries, (id, label) => ({ id, main_name: label?.trim() || `#${id}` }))
}

export async function countRemoteVideoTargets(
  backend: CatalogBackend,
  filter: VideoBatchScrapeFilter
): Promise<number> {
  const created = await createRemoteTargetList(backend, remoteVideoTargetListInput(filter))
  return created.count
}

export async function countRemoteActressTargets(
  backend: CatalogBackend,
  filter: ActressBatchScrapeFilter
): Promise<number> {
  const created = await createRemoteTargetList(backend, remoteActressTargetListInput(filter))
  return created.count
}
