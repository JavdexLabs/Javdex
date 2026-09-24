import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImagePreviewItem } from '../components/ImagePreviewLightbox'
import { useImagePreviewOverlay } from '../components/ImagePreviewOverlayContext'

/** Track lightbox position by stable asset id so list refreshes do not drop preview state. */
export function useImagePreviewById(items: ImagePreviewItem[]): {
  previewIndex: number | null
  isOpen: boolean
  isEnabled: boolean
  openPreview: (assetId: number) => void
  closePreview: () => void
  closePreviewIf: (assetId: number) => void
  setPreviewIndex: (index: number) => void
} {
  const [previewAssetId, setPreviewAssetId] = useState<number | null>(null)
  const { previewEnabled, beginHistoryEntry, requestHistoryClose, abandonHistoryEntry } =
    useImagePreviewOverlay()
  const historyTokenRef = useRef<string | null>(null)

  const previewIndex = useMemo(() => {
    if (previewAssetId == null) return null
    const idx = items.findIndex((item) => item.id === previewAssetId)
    return idx >= 0 ? idx : null
  }, [items, previewAssetId])

  const finishPreview = useCallback(() => {
    historyTokenRef.current = null
    setPreviewAssetId(null)
  }, [])

  const openPreview = useCallback(
    (assetId: number) => {
      if (!previewEnabled || historyTokenRef.current) return
      historyTokenRef.current = beginHistoryEntry(finishPreview)
      setPreviewAssetId(assetId)
    },
    [beginHistoryEntry, finishPreview, previewEnabled]
  )

  const closePreview = useCallback(() => {
    const token = historyTokenRef.current
    if (!token) {
      setPreviewAssetId(null)
      return
    }
    requestHistoryClose(token, finishPreview)
  }, [finishPreview, requestHistoryClose])

  useEffect(() => {
    if (!previewEnabled && previewAssetId != null) closePreview()
  }, [closePreview, previewAssetId, previewEnabled])

  useEffect(() => {
    if (previewAssetId != null && previewIndex == null) closePreview()
  }, [closePreview, previewAssetId, previewIndex])

  useEffect(() => {
    return () => {
      const token = historyTokenRef.current
      if (token) abandonHistoryEntry(token)
    }
  }, [abandonHistoryEntry])

  const closePreviewIf = useCallback(
    (assetId: number) => {
      if (previewAssetId === assetId) closePreview()
    },
    [closePreview, previewAssetId]
  )

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
    isEnabled: previewEnabled,
    openPreview,
    closePreview,
    closePreviewIf,
    setPreviewIndex
  }
}
