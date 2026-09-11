import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, type QueryKey } from '@tanstack/react-query'
import { useLocation, useSearchParams } from 'react-router-dom'
import type {
  ClassificationListPage,
  ClassificationListSortBy,
  ClassificationPageQuery,
  SeriesListQuery
} from '@shared/classificationTypes'
import type { SortDir } from '@shared/commonTypes'
import {
  CLASSIFICATION_PAGE_SIZE,
  classificationListQueryHash,
  LIST_PARAM,
  parseClassificationSort,
  parseFacetOffset,
  patchSearchParams
} from '../listView/listQueryParams'

/** One observed page survives nested detail navigation; inactive pages are not retained. */
export function useClassificationPage<T>(
  scope: string,
  keyForPage: (hash: string) => QueryKey,
  readPage: (input: SeriesListQuery & ClassificationPageQuery) => Promise<ClassificationListPage<T>>
) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const previousScope = useRef(scope)
  const scopeChanged = previousScope.current !== scope
  const urlQ = params.get(LIST_PARAM.q) ?? ''
  const context = `${scope}:${location.key}:${location.pathname}:${params.toString()}`
  const [draft, setDraft] = useState<{ context: string; value: string } | null>(null)
  // Clear on departure as well: POP may restore a previously used location.key.
  useEffect(() => { setDraft(null) }, [context])
  const searchInput = draft?.context === context ? draft.value : urlQ
  const setSearchInput = (value: string): void => setDraft({ context, value })
  const { sortBy, sortDir } = parseClassificationSort(
    params.get(LIST_PARAM.sort), params.get(LIST_PARAM.dir)
  )
  const offset = parseFacetOffset(params.get(LIST_PARAM.facetOffset))
  const queryHash = classificationListQueryHash(scope, params)

  useEffect(() => {
    const changed = previousScope.current !== scope
    previousScope.current = scope
    const canonicalOffset = offset === 0 ? null : String(offset)
    if (!changed && params.get(LIST_PARAM.facetOffset) === canonicalOffset) return
    setParams(previous => patchSearchParams(previous, {
      ...(changed ? { [LIST_PARAM.q]: null, [LIST_PARAM.sort]: null, [LIST_PARAM.dir]: null } : {}),
      [LIST_PARAM.facetOffset]: changed ? null : canonicalOffset
    }), { replace: true })
  }, [scope, offset, params, setParams])

  // Only an edit made against the current URL may commit. Back/forward, sort and role
  // navigation invalidate pending input instead of letting an old debounce rewrite the URL.
  useEffect(() => {
    if (scopeChanged || draft?.context !== context || draft.value.trim() === urlQ.trim()) return
    const timer = setTimeout(() => {
      setParams(previous => patchSearchParams(previous, {
        [LIST_PARAM.q]: draft.value.trim() || null,
        [LIST_PARAM.facetOffset]: null
      }), { replace: true })
    }, 250)
    return () => clearTimeout(timer)
  }, [context, draft, scopeChanged, setParams, urlQ])

  const query = useQuery({
    queryKey: [...keyForPage(queryHash), 'page'],
    queryFn: () => readPage({ search: urlQ, sortBy, sortDir, limit: CLASSIFICATION_PAGE_SIZE, offset }),
    enabled: !scopeChanged,
    gcTime: 0,
    placeholderData: () => undefined
  })
  const move = useCallback((next: number): void => {
    const normalized = parseFacetOffset(String(next))
    setParams(previous => patchSearchParams(previous, {
      [LIST_PARAM.facetOffset]: normalized === 0 ? null : String(normalized)
    }), { replace: true })
  }, [setParams])
  const total = query.data?.total
  const lastOffset = total === undefined ? offset : Math.max(0, Math.ceil(total / CLASSIFICATION_PAGE_SIZE) - 1) * CLASSIFICATION_PAGE_SIZE
  const outOfBounds = !scopeChanged && !query.isError && offset > lastOffset
  useEffect(() => {
    if (outOfBounds) move(lastOffset)
  }, [outOfBounds, lastOffset, move])

  const patchSort = (next: ClassificationListSortBy, dir: SortDir): void => {
    setParams(previous => patchSearchParams(previous, {
      [LIST_PARAM.sort]: next,
      [LIST_PARAM.dir]: dir,
      [LIST_PARAM.facetOffset]: null
    }), { replace: true })
  }

  return {
    query, queryHash, urlQ, searchInput, setSearchInput, sortBy, sortDir, patchSort,
    offset, move, total,
    items: scopeChanged || outOfBounds ? [] : query.data?.items ?? [],
    loading: scopeChanged || query.isPending || outOfBounds,
    canNext: !query.isError && total !== undefined && offset + CLASSIFICATION_PAGE_SIZE < total
  }
}
