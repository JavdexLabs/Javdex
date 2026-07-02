import type { ActressGenderFilter, ScrapedStatus, VideoQuery, ActressListSortBy, ListSortDir } from '@shared/types'
import { ACTRESS_LIST_DEFAULTS } from '@shared/types'

/** Shared list URL keys (library, actresses, facet list). */
export const LIST_PARAM = {
  q: 'q',
  sort: 'sort',
  dir: 'dir',
  tags: 'tags',
  prefix: 'prefix',
  status: 'status',
  year: 'year',
  gender: 'gender'
} as const

export const LIBRARY_DEFAULTS = {
  status: 'all' as ScrapedStatus | 'all',
  year: 'all' as number | 'all',
  sortBy: 'release_date' as NonNullable<VideoQuery['sortBy']>,
  sortDir: 'desc' as NonNullable<VideoQuery['sortDir']>
}

export const ACTRESS_DEFAULT_GENDER: ActressGenderFilter = ACTRESS_LIST_DEFAULTS.gender

export function parseActressSort(
  rawSort: string | null,
  rawDir: string | null
): { sortBy: ActressListSortBy; sortDir: ListSortDir } {
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

export function parseYear(raw: string | null): number | 'all' {
  if (!raw || raw === 'all') return 'all'
  const y = Number(raw)
  return Number.isInteger(y) && y > 1900 ? y : 'all'
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

  return {
    search: q || undefined,
    scrapedStatus: parseScrapedStatus(params.get(LIST_PARAM.status)),
    year: parseYear(params.get(LIST_PARAM.year)),
    tagIds: tagIds.length ? tagIds : undefined,
    codePrefix: codePrefix || undefined,
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
    year: q.year === 'all' ? 'all' : q.year,
    sort: q.sortBy ?? '',
    dir: q.sortDir ?? '',
    tags: q.tagIds?.join(',') ?? '',
    prefix: q.codePrefix ?? ''
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
    sort: sortBy,
    dir: sortDir
  })
}

export function facetListQueryHash(type: string, params: URLSearchParams): string {
  return hashListQuery({
    type,
    q: (params.get(LIST_PARAM.q) ?? '').trim()
  })
}

export function facetDetailQueryHash(
  type: string,
  value: string,
  params: URLSearchParams
): string {
  const { sortBy, sortDir } = parseSort(params.get(LIST_PARAM.sort), params.get(LIST_PARAM.dir))
  return hashListQuery({
    scope: 'facet-detail',
    type,
    value,
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
    q.year === LIBRARY_DEFAULTS.year &&
    q.sortBy === LIBRARY_DEFAULTS.sortBy &&
    q.sortDir === LIBRARY_DEFAULTS.sortDir &&
    !q.tagIds?.length &&
    !q.codePrefix
  )
}
