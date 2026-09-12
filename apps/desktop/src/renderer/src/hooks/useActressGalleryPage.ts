import { useCallback } from 'react'
import { api } from '../api'
import { useBoundedMediaPage } from './useBoundedMediaPage'

export function useActressGalleryPage(actressId: number, localOnly = false) {
  const read = useCallback((offset: number) => api.actresses.galleryPage(actressId, { limit: 60, offset, localOnly }), [actressId, localOnly])
  return useBoundedMediaPage(`gallery:${actressId}:${localOnly}`, read)
}
