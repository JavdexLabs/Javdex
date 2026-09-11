import { useCallback } from 'react'
import { api } from '../api'
import { useBoundedMediaPage } from './useBoundedMediaPage'

export function useActressVideoPage(actressId: number, withCover = false) {
  const read = useCallback((offset: number) => api.actresses.videoPage(actressId, { limit: 60, offset, withCover }), [actressId, withCover])
  return useBoundedMediaPage(`videos:${actressId}:${withCover}`, read)
}
