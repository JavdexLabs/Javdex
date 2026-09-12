import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActressGalleryPage } from '@shared/actressTypes'
import { api } from '../api'
import { useImagePreviewOverlay } from '../components/ImagePreviewOverlayContext'

/** Grid and preview each own at most one page. Page + selection commit atomically. */
export function useActressGalleryPreview(actressId: number) {
  const { requestHistoryClose, abandonHistoryEntry, previewEnabled, beginHistoryEntry } = useImagePreviewOverlay()
  const [view, setView] = useState<{ page: ActressGalleryPage; index: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const token = useRef<string | null>(null)
  const request = useRef(0)
  const pending = useRef<{ offset: number; anchorId?: number; last?: boolean } | null>(null)
  const finish = useCallback(() => {
    request.current += 1
    token.current = null
    pending.current = null
    setView(null)
    setLoading(false)
    setError(null)
  }, [])
  const close = useCallback(() => {
    request.current += 1
    pending.current = null
    if (token.current) requestHistoryClose(token.current, finish)
    else finish()
  }, [requestHistoryClose, finish])
  useEffect(() => () => {
    request.current += 1
    if (token.current) abandonHistoryEntry(token.current)
    token.current = null
  }, [actressId, abandonHistoryEntry])
  useEffect(() => { if (!previewEnabled) close() }, [previewEnabled, close])

  const open = (page: ActressGalleryPage, assetId: number) => {
    const index = page.items.findIndex(item => item.id === assetId)
    if (!previewEnabled || token.current || index < 0) return
    token.current = beginHistoryEntry(finish)
    setView({ page, index })
  }
  const read = useCallback(async (query: { offset: number; anchorId?: number; last?: boolean }) => {
    if (!token.current) return
    const sequence = ++request.current
    pending.current = query
    setLoading(true)
    setError(null)
    try {
      let page = await api.actresses.galleryPage(actressId, { limit: 60, offset: query.offset, anchorId: query.anchorId })
      if (sequence !== request.current) return
      if (!page || page.total === 0 || (query.anchorId !== undefined && page.anchorIndex == null)) { close(); return }
      if (page.items.length === 0) {
        page = await api.actresses.galleryPage(actressId, { limit: 60, offset: Math.floor((page.total - 1) / 60) * 60 })
        if (sequence !== request.current) return
      }
      if (!page || page.items.length === 0) { close(); return }
      setView({ page, index: page.anchorIndex ?? (query.last ? page.items.length - 1 : 0) })
      pending.current = null
    } catch (cause) {
      if (sequence === request.current) setError(String((cause as Error).message ?? cause))
    } finally {
      if (sequence === request.current) setLoading(false)
    }
  }, [actressId, close])
  const select = (index: number) => {
    if (!view || loading) return
    request.current += 1
    pending.current = null
    setError(null)
    if (index >= 0 && index < view.page.items.length) setView({ ...view, index })
    else if (index < 0 && view.page.offset > 0) void read({ offset: view.page.offset - 60, last: true })
    else if (index >= view.page.items.length && view.page.offset + view.page.items.length < view.page.total) void read({ offset: view.page.offset + 60 })
  }
  const refresh = useCallback(() => {
    if (view) void read({ offset: view.page.offset, anchorId: view.page.items[view.index].id })
  }, [read, view])
  return { view, loading, error, enabled: previewEnabled, open, close, select, refresh,
    retry: () => { if (pending.current) void read(pending.current) },
    closeIf: (assetId: number) => { if (view?.page.items[view.index]?.id === assetId) close() }
  }
}
