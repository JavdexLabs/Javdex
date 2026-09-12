import { useCallback, useEffect, useRef, useState } from 'react'
import type { QueryKey } from '@tanstack/react-query'
import { useContinuousPage } from './useContinuousPage'
import { useLocation, useSearchParams } from 'react-router-dom'
import type {
  ClassificationListPage,
  ClassificationListSortBy,
  ClassificationPageQuery,
  SeriesListQuery
} from '@shared/classificationTypes'
import type { SortDir } from '@shared/commonTypes'
import {
  CLASSIFICATION_LIST_DEFAULTS,
  CLASSIFICATION_PAGE_SIZE,
  classificationListQueryHash,
  LIST_PARAM,
  parseClassificationSort,
  parseFacetOffset,
  patchSearchParams
} from '../listView/listQueryParams'

/** Three observed pages support continuous browsing and nested detail navigation. */
export function useClassificationPage<T>(
  scope: string,
  keyForPage: (hash: string) => QueryKey,
  readPage: (input: SeriesListQuery & ClassificationPageQuery) => Promise<ClassificationListPage<T>>
) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const previousScope = useRef(scope)
  const [clearing, setClearing] = useState(false)
  const resetting = previousScope.current !== scope || clearing
  const blockAnchor = useRef(false)
  blockAnchor.current = resetting
  const urlQ = resetting ? '' : (params.get(LIST_PARAM.q) ?? '')
  const context = `${scope}:${location.key}:${location.pathname}:${params.toString()}`
  const [draft, setDraft] = useState<{ context: string; value: string } | null>(null)
  // Clear on departure as well: POP may restore a previously used location.key.
  useEffect(() => { setDraft(null) }, [context])
  const searchInput = resetting ? '' : draft?.context === context ? draft.value : urlQ
  const setSearchInput = (value: string): void => setDraft({ context, value })
  const { sortBy, sortDir } = resetting
    ? CLASSIFICATION_LIST_DEFAULTS
    : parseClassificationSort(params.get(LIST_PARAM.sort), params.get(LIST_PARAM.dir))
  const offset = resetting ? 0 : parseFacetOffset(params.get(LIST_PARAM.facetOffset))
  const identityParams = new URLSearchParams(params); identityParams.delete(LIST_PARAM.facetOffset)
  if (resetting) {
    identityParams.delete(LIST_PARAM.q)
    identityParams.delete(LIST_PARAM.sort)
    identityParams.delete(LIST_PARAM.dir)
  }
  const queryHash = classificationListQueryHash(scope, identityParams)

  useEffect(() => {
    const changed = previousScope.current !== scope
    previousScope.current = scope
    if (changed) {
      setClearing(true)
      setParams(previous => patchSearchParams(previous, {
        [LIST_PARAM.q]: null, [LIST_PARAM.sort]: null, [LIST_PARAM.dir]: null, [LIST_PARAM.facetOffset]: null
      }), { replace: true })
      return
    }
    if (clearing) return
    const canonicalOffset = offset === 0 ? null : String(offset)
    if (params.get(LIST_PARAM.facetOffset) === canonicalOffset) return
    setParams(previous => patchSearchParams(previous, {
      [LIST_PARAM.facetOffset]: canonicalOffset
    }), { replace: true })
  }, [scope, offset, params, setParams, clearing])

  useEffect(() => {
    if (!clearing) return
    if (!params.get(LIST_PARAM.q) && !params.get(LIST_PARAM.sort) && !params.get(LIST_PARAM.dir)) {
      setClearing(false)
    }
  }, [clearing, params])

  // Only an edit made against the current URL may commit. Back/forward, sort and role
  // navigation invalidate pending input instead of letting an old debounce rewrite the URL.
  useEffect(() => {
    if (resetting || draft?.context !== context || draft.value.trim() === urlQ.trim()) return
    const timer = setTimeout(() => {
      setParams(previous => patchSearchParams(previous, {
        [LIST_PARAM.q]: draft.value.trim() || null,
        [LIST_PARAM.facetOffset]: null
      }), { replace: true })
    }, 250)
    return () => clearTimeout(timer)
  }, [context, draft, resetting, setParams, urlQ])

  const continuous = useContinuousPage(JSON.stringify(keyForPage(queryHash)), CLASSIFICATION_PAGE_SIZE,
    offset => readPage({ search: urlQ, sortBy, sortDir, limit: CLASSIFICATION_PAGE_SIZE, offset }), true, offset)
  const query = { data: continuous.page, isError: Boolean(continuous.error), error: continuous.error ? new Error(continuous.error) : null,
    isFetching: continuous.loading, isPending: continuous.loading, refetch: continuous.reload }
  const move = useCallback((next: number): void => {
    if (blockAnchor.current) return
    const normalized = parseFacetOffset(String(next))
    setParams(previous => patchSearchParams(previous, {
      [LIST_PARAM.facetOffset]: normalized === 0 ? null : String(normalized)
    }), { replace: true })
  }, [setParams])
  const total = continuous.known ? continuous.total : undefined
  const lastOffset = total === undefined ? offset : Math.max(0, Math.ceil(total / CLASSIFICATION_PAGE_SIZE) - 1) * CLASSIFICATION_PAGE_SIZE
  const outOfBounds = !resetting && continuous.known && !query.isError && offset > lastOffset
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
    items: continuous.items,
    window: continuous.window,
    loading: query.isPending,
    canNext: !query.isError && total !== undefined && offset + CLASSIFICATION_PAGE_SIZE < total
  }
}
