import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ImagePreviewItem } from '../components/ImagePreviewLightbox'

/** Track lightbox position by stable asset id so list refreshes do not drop preview state. */
export function useImagePreviewById(items: ImagePreviewItem[]): {
  previewIndex: number | null
  isOpen: boolean
  openPreview: (assetId: number) => void
  closePreview: () => void
  closePreviewIf: (assetId: number) => void
  setPreviewIndex: (index: number) => void
} {
  const [previewAssetId, setPreviewAssetId] = useState<number | null>(null)

  const previewIndex = useMemo(() => {
    if (previewAssetId == null) return null
    const idx = items.findIndex((item) => item.id === previewAssetId)
    return idx >= 0 ? idx : null
  }, [items, previewAssetId])

  useEffect(() => {
    if (previewAssetId != null && previewIndex == null) {
      setPreviewAssetId(null)
    }
  }, [previewAssetId, previewIndex])

  const openPreview = useCallback((assetId: number) => {
    setPreviewAssetId(assetId)
  }, [])

  const closePreview = useCallback(() => {
    setPreviewAssetId(null)
  }, [])

  const closePreviewIf = useCallback((assetId: number) => {
    setPreviewAssetId((current) => (current === assetId ? null : current))
  }, [])

  const setPreviewIndex = useCallback(
    (index: number) => {
      const item = items[index]
      if (item) setPreviewAssetId(item.id)
    },
    [items]
  )

  return {
    previewIndex,
    isOpen: previewIndex != null,
    openPreview,
    closePreview,
    closePreviewIf,
    setPreviewIndex
  }
}
