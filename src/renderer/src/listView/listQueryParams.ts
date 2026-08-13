import type { ActressAvatarFilter, ActressGenderFilter, ActressListStatusFilter, ActressListSortBy } from '@shared/actressTypes'
import type { ScrapedStatus, SortDir } from '@shared/commonTypes'
import type { VideoPendingScrapeFilter, VideoQuery, VideoResourceFilter } from '@shared/videoTypes'
import { ACTRESS_LIST_DEFAULTS } from '@shared/actressTypes'
import type { ClassificationListSortBy } from '@shared/classificationTypes'

/** Shared list URL keys (library, actresses, facet list). */
export const LIST_PARAM = {
  q: 'q',
  sort: 'sort',
  dir: 'dir',
  tags: 'tags',
  prefix: 'prefix',
  status: 'status',
  avatar: 'avatar',
  year: 'year',
  gender: 'gender',
  resources: 'resources',
  pending: 'pending',
  releaseDir: 'releaseDir',
  pendingTab: 'tab',
  pendingItemId: 'id',
  pendingVideoId: 'videoId'
} as const

export const VIDEO_RESOURCE_FILTER_ORDER: VideoResourceFilter[] = [
  'local',
  'direct',
  'web',
  'magnet',
  'ed2k',
  'none'
]

export const LIBRARY_DEFAULTS = {
  status: 'all' as ScrapedStatus | 'all',
  year: 'all' as number | 'all',
  sortBy: 'release_date' as NonNullable<VideoQuery['sortBy']>,
  sortDir: 'desc' as NonNullable<VideoQuery['sortDir']>
}

export const ACTRESS_DEFAULT_GENDER: ActressGenderFilter = ACTRESS_LIST_DEFAULTS.gender

/** All statuses is the default and is never written to the URL. */
export const ACTRESS_DEFAULT_STATUS: ActressListStatusFilter = 'all'

/** All avatar states are the default and are never written to the URL. */
export const ACTRESS_DEFAULT_AVATAR: ActressAvatarFilter = 'all'

export const CLASSIFICATION_LIST_DEFAULTS = {
  sortBy: 'video_count' as ClassificationListSortBy,
  sortDir: 'desc' as SortDir
}

export function parseClassificationSort(
  rawSort: string | null,
  rawDir: string | null
): { sortBy: ClassificationListSortBy; sortDir: SortDir } {
  const sortBy =
    rawSort === 'video_count' || rawSort === 'updated_at'
      ? rawSort
      : CLASSIFICATION_LIST_DEFAULTS.sortBy
  const sortDir = rawDir === 'asc' || rawDir === 'desc' ? rawDir : CLASSIFICATION_LIST_DEFAULTS.sortDir
  return { sortBy, sortDir }
}

export function parseSeriesReleaseDir(raw: string | null): SortDir {
  return raw === 'asc' ? 'asc' : 'desc'
}

export function seriesReleaseDirParam(direction: SortDir): string | null {
  return direction === 'asc' ? 'asc' : null
}

export function parseActressStatus(raw: string | null): ActressListStatusFilter {
  if (raw === 'success' || raw === 'unscraped' || raw === 'failed') return raw
  return ACTRESS_DEFAULT_STATUS
}

/** URL value for a status filter; `null` drops the param so all statuses stay implicit. */
export function actressStatusParam(status: ActressListStatusFilter): string | null {
  return status === ACTRESS_DEFAULT_STATUS ? null : status
}

export function parseActressAvatar(raw: string | null): ActressAvatarFilter {
  if (raw === 'with' || raw === 'without' || raw === 'without-face') return raw
  return ACTRESS_DEFAULT_AVATAR
}

/** URL value for an avatar filter; all avatars stays implicit. */
export function actressAvatarParam(avatar: ActressAvatarFilter): string | null {
  return avatar === ACTRESS_DEFAULT_AVATAR ? null : avatar
}

export function parseActressSort(
  rawSort: string | null,
  rawDir: string | null
): { sortBy: ActressListSortBy; sortDir: SortDir } {
  const sortBy =
    rawSort === 'video_count' ||
    rawSort === 'gallery' ||
    rawSort === 'age' ||
    rawSort === 'cup_size'
      ? rawSort
      : ACTRESS_LIST_DEFAULTS.sortBy
  const sortDir = rawDir === 'asc' || rawDir === 'desc' ? rawDir : ACTRESS_LIST_DEFAULTS.sortDir
  return { sortBy, sortDir }
}

export function parseTagIds(raw: string | null): number[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0)
}

export function parseScrapedStatus(raw: string | null): ScrapedStatus | 'all' {
  if (raw === '0' || raw === '1' || raw === '2') return Number(raw) as ScrapedStatus
  return 'all'
}

export function parseVideoPendingScrape(raw: string | null): VideoPendingScrapeFilter {
  return raw === 'pending' || raw === 'none' ? raw : 'all'
}

export function parseYear(raw: string | null): number | 'all' {
  if (!raw || raw === 'all') return 'all'
  const y = Number(raw)
  return Number.isInteger(y) && y > 1900 ? y : 'all'
}

export function parseVideoResourceFilters(raw: string | null): VideoResourceFilter[] {
  if (!raw) return []
  const selected = new Set(raw.split(','))
  return VIDEO_RESOURCE_FILTER_ORDER.filter((kind) => selected.has(kind))
}

export function videoResourceFiltersParam(filters: VideoResourceFilter[]): string | null {
  const selected = new Set(filters)
  const canonical = VIDEO_RESOURCE_FILTER_ORDER.filter((kind) => selected.has(kind))
  return canonical.length > 0 ? canonical.join(',') : null
}

export function canonicalizeLibrarySearchParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  const canonicalResources = videoResourceFiltersParam(
    parseVideoResourceFilters(params.get(LIST_PARAM.resources))
  )
  if (canonicalResources) next.set(LIST_PARAM.resources, canonicalResources)
  else next.delete(LIST_PARAM.resources)
  const pending = parseVideoPendingScrape(params.get(LIST_PARAM.pending))
  if (pending === 'all') next.delete(LIST_PARAM.pending)
  else next.set(LIST_PARAM.pending, pending)
  return next
}

export function parseSort(
  rawSort: string | null,
  rawDir: string | null
): { sortBy: NonNullable<VideoQuery['sortBy']>; sortDir: NonNullable<VideoQuery['sortDir']> } {
  const sortBy =
    rawSort === 'add_time' ||
    rawSort === 'release_date' ||
    rawSort === 'rating' ||
    rawSort === 'code'
      ? rawSort
      : LIBRARY_DEFAULTS.sortBy
  const sortDir = rawDir === 'asc' || rawDir === 'desc' ? rawDir : LIBRARY_DEFAULTS.sortDir
  return { sortBy, sortDir }
}

export function parseGender(raw: string | null): ActressGenderFilter {
  if (raw === 'male' || raw === 'all') return raw
  return ACTRESS_DEFAULT_GENDER
}

export function libraryVideoQueryFromSearchParams(params: URLSearchParams): VideoQuery {
  const { sortBy, sortDir } = parseSort(params.get(LIST_PARAM.sort), params.get(LIST_PARAM.dir))
  const tagIds = parseTagIds(params.get(LIST_PARAM.tags))
  const codePrefix = (params.get(LIST_PARAM.prefix) ?? '').trim().toUpperCase()
  const q = (params.get(LIST_PARAM.q) ?? '').trim()
  const resourceKinds = parseVideoResourceFilters(params.get(LIST_PARAM.resources))

  return {
    search: q || undefined,
    scrapedStatus: parseScrapedStatus(params.get(LIST_PARAM.status)),
    pendingScrape: parseVideoPendingScrape(params.get(LIST_PARAM.pending)),
    year: parseYear(params.get(LIST_PARAM.year)),
    tagIds: tagIds.length ? tagIds : undefined,
    codePrefix: codePrefix || undefined,
    resourceKinds: resourceKinds.length ? resourceKinds : undefined,
    sortBy,
    sortDir
  }
}

/** Stable key for in-memory scroll / query cache (session-only, not persisted). */
export function hashListQuery(parts: Record<string, string | number | undefined>): string {
  const keys = Object.keys(parts).sort()
  return keys.map((k) => `${k}=${parts[k] ?? ''}`).join('&')
}

export function libraryQueryHash(params: URLSearchParams): string {
  const q = libraryVideoQueryFromSearchParams(params)
  return hashListQuery({
    q: q.search ?? '',
    status: q.scrapedStatus ?? 'all',
    pending: q.pendingScrape ?? 'all',
    year: q.year === 'all' ? 'all' : q.year,
    sort: q.sortBy ?? '',
    dir: q.sortDir ?? '',
    tags: q.tagIds?.join(',') ?? '',
    prefix: q.codePrefix ?? '',
    resources: q.resourceKinds?.join(',') ?? ''
  })
}

export function actressQueryHash(params: URLSearchParams): string {
  const { sortBy, sortDir } = parseActressSort(
    params.get(LIST_PARAM.sort),
    params.get(LIST_PARAM.dir)
  )
  return hashListQuery({
    q: (params.get(LIST_PARAM.q) ?? '').trim(),
    gender: parseGender(params.get(LIST_PARAM.gender)),
    status: parseActressStatus(params.get(LIST_PARAM.status)),
    avatar: parseActressAvatar(params.get(LIST_PARAM.avatar)),
    sort: sortBy,
    dir: sortDir
  })
}

export function classificationListQueryHash(type: string, params: URLSearchParams): string {
  const { sortBy, sortDir } = parseClassificationSort(
    params.get(LIST_PARAM.sort),
    params.get(LIST_PARAM.dir)
  )
  return hashListQuery({
    type,
    q: (params.get(LIST_PARAM.q) ?? '').trim(),
    sort: sortBy,
    dir: sortDir
  })
}

export function patchSearchParams(
  current: URLSearchParams,
  patch: Record<string, string | null | undefined>
): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === '') next.delete(key)
    else next.set(key, value)
  }
  return next
}

export function isDefaultLibraryParams(params: URLSearchParams): boolean {
  const q = libraryVideoQueryFromSearchParams(params)
  return (
    !(params.get(LIST_PARAM.q) ?? '').trim() &&
    q.scrapedStatus === LIBRARY_DEFAULTS.status &&
    q.pendingScrape === 'all' &&
    q.year === LIBRARY_DEFAULTS.year &&
    q.sortBy === LIBRARY_DEFAULTS.sortBy &&
    q.sortDir === LIBRARY_DEFAULTS.sortDir &&
    !q.tagIds?.length &&
    !q.codePrefix &&
    !q.resourceKinds?.length
  )
}
