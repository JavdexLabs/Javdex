import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import type { CatalogScope } from '@shared/mediaLibraryTypes'
import type { VideoQuery } from '@shared/videoTypes'
import { api } from '../api'
import { toScopedVideoCardPage } from '@shared/cardProjection'
import { LIST_PARAM, patchSearchParams } from '../listView/listQueryParams'
import { videoKeys } from './queryKeys'

/** A related-video grid holds one page; its URL offset survives nested detail routes. */
export function useCatalogVideoPage(scope: CatalogScope, query: VideoQuery, hash: string, onError: (error: unknown) => void, enabled = true) {
  const [params, setParams] = useSearchParams()
  const raw = params.get(LIST_PARAM.relatedVideoOffset), value = Number(raw)
  const parsedOffset = raw && /^\d+$/.test(raw) && Number.isSafeInteger(value) ? Math.floor(value / 60) * 60 : 0
  const previous = useRef(hash), changed = previous.current !== hash
  const offset = changed ? 0 : parsedOffset
  const move = (next: number) => setParams(current => patchSearchParams(current, { [LIST_PARAM.relatedVideoOffset]: next > 0 ? String(next) : null }), { replace: true })
  const result = useQuery({ queryKey: [...videoKeys.list(scope, query, hash), 'related-page', offset],
    queryFn: async () => toScopedVideoCardPage(await api.videos.list(scope, { ...query, limit: 60, offset })), gcTime: 0, enabled })
  useEffect(() => {
    previous.current = hash
    const total = result.data?.total
    const next = changed ? 0 : total !== undefined && offset >= total ? Math.max(0, Math.floor((total - 1) / 60) * 60) : offset
    if (raw !== (next ? String(next) : null)) setParams(current => patchSearchParams(current, { [LIST_PARAM.relatedVideoOffset]: next ? String(next) : null }), { replace: true })
  }, [hash, changed, offset, raw, result.data?.total, setParams])
  useEffect(() => { if (result.error) onError(result.error) }, [result.error, onError])
  return { videos: result.data?.items ?? [], total: result.data?.total ?? 0, loading: result.isPending,
    offset, move, fetching: result.isFetching, error: result.error, retry: () => void result.refetch(),
    refetchSilent: () => { if (result.isStale) void result.refetch() } }
}
