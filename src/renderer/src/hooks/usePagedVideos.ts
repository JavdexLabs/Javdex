import { useCallback, useEffect, useRef, useState } from 'react'
import type { Video, VideoQuery } from '@shared/types'
import { api } from '../api'

const DEFAULT_PAGE_SIZE = 240

interface UsePagedVideosResult {
  videos: Video[]
  total: number
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  loadMore: () => void
}

export function usePagedVideos(
  query: VideoQuery,
  onError: (error: unknown) => void,
  pageSize = DEFAULT_PAGE_SIZE,
  enabled = true
): UsePagedVideosResult {
  const [videos, setVideos] = useState<Video[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const requestSeqRef = useRef(0)
  const loadingMoreRef = useRef(false)

  useEffect(() => {
    if (!enabled) {
      requestSeqRef.current += 1
      loadingMoreRef.current = false
      setVideos([])
      setTotal(0)
      setLoading(false)
      setLoadingMore(false)
      return
    }

    const requestId = requestSeqRef.current + 1
    requestSeqRef.current = requestId
    loadingMoreRef.current = false
    setLoading(true)
    setLoadingMore(false)

    api.videos
      .list({ ...query, limit: pageSize, offset: 0 })
      .then((res) => {
        if (requestSeqRef.current !== requestId) return
        setVideos(res.items)
        setTotal(res.total)
      })
      .catch(onError)
      .finally(() => {
        if (requestSeqRef.current === requestId) setLoading(false)
      })
  }, [enabled, onError, pageSize, query])

  const hasMore = videos.length < total

  const loadMore = useCallback(() => {
    if (loading || loadingMoreRef.current || videos.length >= total) return
    if (!enabled) return

    const requestId = requestSeqRef.current
    const offset = videos.length
    loadingMoreRef.current = true
    setLoadingMore(true)

    api.videos
      .list({ ...query, limit: pageSize, offset })
      .then((res) => {
        if (requestSeqRef.current !== requestId) return
        setVideos((current) => {
          const seen = new Set(current.map((v) => v.id))
          const next = res.items.filter((v) => !seen.has(v.id))
          return [...current, ...next]
        })
        setTotal(res.total)
      })
      .catch(onError)
      .finally(() => {
        if (requestSeqRef.current === requestId) {
          loadingMoreRef.current = false
          setLoadingMore(false)
        }
      })
  }, [enabled, loading, onError, pageSize, query, total, videos.length])

  return { videos, total, loading, loadingMore, hasMore, loadMore }
}
