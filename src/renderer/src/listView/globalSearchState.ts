import type { GlobalSearchInput } from '@shared/catalogTypes'
import { LIST_PARAM, hashListQuery } from './listQueryParams'
import { parsePositiveRouteId } from './routeIds'

export const GLOBAL_SEARCH_LIBRARY_PARAM = 'libraries'

export function parseGlobalSearchLibraryIds(raw: string | null): number[] {
  if (!raw) return []
  const ids = raw
    .split(',')
    .map((part) => parsePositiveRouteId(part.trim()))
    .filter((id): id is number => id != null)
  return [...new Set(ids)].sort((left, right) => left - right)
}

export function globalSearchLibraryIdsParam(ids: readonly number[]): string | null {
  const valid = ids
    .map((id) => parsePositiveRouteId(String(id)))
    .filter((id): id is number => id != null)
  const canonical = [...new Set(valid)].sort((left, right) => left - right)
  return canonical.length > 0 ? canonical.join(',') : null
}

export function canonicalizeGlobalSearchParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  const q = (params.get(LIST_PARAM.q) ?? '').trim()
  if (q) next.set(LIST_PARAM.q, q)
  else next.delete(LIST_PARAM.q)

  const libraries = globalSearchLibraryIdsParam(
    parseGlobalSearchLibraryIds(params.get(GLOBAL_SEARCH_LIBRARY_PARAM))
  )
  if (libraries) next.set(GLOBAL_SEARCH_LIBRARY_PARAM, libraries)
  else next.delete(GLOBAL_SEARCH_LIBRARY_PARAM)
  return next
}

export function globalSearchInputFromParams(
  params: URLSearchParams,
  pagination: { limit: number; offset: number }
): GlobalSearchInput {
  const q = (params.get(LIST_PARAM.q) ?? '').trim()
  const libraryIds = parseGlobalSearchLibraryIds(params.get(GLOBAL_SEARCH_LIBRARY_PARAM))
  return {
    search: q || undefined,
    libraryIds: libraryIds.length > 0 ? libraryIds : undefined,
    sortBy: 'add_time',
    sortDir: 'desc',
    limit: pagination.limit,
    offset: pagination.offset
  }
}

export function globalSearchQueryHash(params: URLSearchParams): string {
  return hashListQuery({
    q: (params.get(LIST_PARAM.q) ?? '').trim(),
    libraries: parseGlobalSearchLibraryIds(
      params.get(GLOBAL_SEARCH_LIBRARY_PARAM)
    ).join(',')
  })
}
