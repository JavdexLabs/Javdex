import { useCallback } from 'react'
import { api } from '../api'
import { useContinuousPage } from './useContinuousPage'

export function useActressVideoPage(actressId: number, withCover = false, initialOffset = 0) {
  const read = useCallback((offset: number) => api.actresses.videoPage(actressId, { limit: 60, offset, withCover }), [actressId, withCover])
  const result = useContinuousPage(`videos:${actressId}:${withCover}`, 60, async offset => {
    const page = await read(offset)
    return page ? { ...page, items: page.videos } : null
  }, true, initialOffset)
  return { ...result, data: result.page ? { ...result.page, videos: result.items, total: result.total } : null }
}
