import { useLayoutEffect, useRef, useState } from 'react'
import type { ScopedVideoDetail } from '@shared/catalogTypes'
import { expectedVideoVersion } from '@shared/protocol/versions'
import { api } from '../api'
import { mediaLibraryCatalogScope } from '../query/catalogScopes'

interface Options {
  scopeKey: string
  video: ScopedVideoDetail | null
  updateVideo(video: ScopedVideoDetail): void
  invalidateVideos(): void
  notifyError(message: string): void
}

/** Serialize rating writes and use the authoritative version before the next write. */
export function useVideoRatingController(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const confirmed = useRef(options.video)
  const generation = useRef(0)
  const running = useRef(false)
  const queued = useRef<number | null>(null)
  const [pendingRating, setPendingRating] = useState<number | null>(null)

  useLayoutEffect(() => { confirmed.current = options.video }, [options.video])
  useLayoutEffect(() => {
    generation.current += 1
    running.current = false
    queued.current = null
    setPendingRating(null)
    return () => { generation.current += 1 }
  }, [options.scopeKey])

  const handleRating = async (rating: number): Promise<void> => {
    let snapshot = confirmed.current
    if (!snapshot) return
    queued.current = rating
    setPendingRating(rating)
    if (running.current) return
    running.current = true
    const session = generation.current
    const scope = mediaLibraryCatalogScope(snapshot.activeLibraryId)
    const videoId = snapshot.id
    try {
      while (queued.current != null && session === generation.current) {
        const next = queued.current
        queued.current = null
        await api.videos.setRating(videoId, next, expectedVideoVersion(snapshot))
        latest.current.invalidateVideos()
        if (session !== generation.current) return
        const detail = await api.videos.get(scope, videoId)
        if (session !== generation.current) return
        if (!detail) throw new Error('影片已不存在，请刷新后重试')
        snapshot = detail
        confirmed.current = detail
        latest.current.updateVideo(detail)
      }
    } catch (error) {
      if (session !== generation.current) return
      queued.current = null
      latest.current.notifyError(String((error as Error).message ?? error))
      // Refresh after a real conflict/failure, without silently retrying the write.
      try {
        const detail = await api.videos.get(scope, videoId)
        if (session === generation.current && detail) {
          confirmed.current = detail
          latest.current.updateVideo(detail)
        }
      } catch { /* Preserve the original write error. */ }
    } finally {
      if (session === generation.current) {
        running.current = false
        queued.current = null
        setPendingRating(null)
      }
    }
  }

  return { handleRating, rating: pendingRating ?? options.video?.rating ?? 0 }
}
