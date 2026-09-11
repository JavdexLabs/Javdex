import { useEffect } from 'react'
import { useContinuousPage } from '../hooks/useContinuousPage'
import { useRelatedVideoOffset } from '../hooks/useRelatedVideoOffset'
import type { CatalogScope } from '@shared/mediaLibraryTypes'
import type { VideoQuery } from '@shared/videoTypes'
import { api } from '../api'
import { toScopedVideoCardPage } from '@shared/cardProjection'
import { videoKeys } from './queryKeys'

/** A related-video grid retains at most three pages; its URL offset survives nested detail routes. */
export function useCatalogVideoPage(scope: CatalogScope, query: VideoQuery, hash: string, onError: (error: unknown) => void, enabled = true) {
  const { offset, move, align } = useRelatedVideoOffset(hash)
  const result = useContinuousPage(JSON.stringify(videoKeys.list(scope, query, hash)), 60,
    async offset => toScopedVideoCardPage(await api.videos.list(scope, { ...query, limit: 60, offset })), enabled, offset)
  useEffect(() => { align(result.known, result.total) }, [align, result.known, result.total])
  useEffect(() => { if (result.error) onError(result.error) }, [result.error, onError])
  return { videos: result.items, total: result.total ?? 0, loading: result.loading,
    offset, move, fetching: result.loading, error: result.error, retry: result.reload,
    refetchSilent: result.reload, window: result.window }
}
