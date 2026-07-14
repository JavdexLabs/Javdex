import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

export const IMAGE_PREVIEW_HISTORY_KEY = 'avImagePreview'
const HISTORY_CLOSE_FALLBACK_MS = 300

interface ImagePreviewHistoryMarker {
  token: string
  kind: 'image-preview'
}

interface ActiveHistoryPreview {
  token: string
  phase: 'open' | 'closing'
  close: () => void
}

function createToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function readImagePreviewHistoryMarker(state: unknown): ImagePreviewHistoryMarker | null {
  if (!state || typeof state !== 'object') return null
  const marker = (state as Record<string, unknown>)[IMAGE_PREVIEW_HISTORY_KEY]
  if (!marker || typeof marker !== 'object') return null
  const value = marker as Record<string, unknown>
  return value.kind === 'image-preview' && typeof value.token === 'string'
    ? { kind: 'image-preview', token: value.token }
    : null
}

export function withImagePreviewHistoryMarker(
  state: unknown,
  token: string
): Record<string, unknown> {
  const base = state && typeof state === 'object' ? state : {}
  return {
    ...base,
    [IMAGE_PREVIEW_HISTORY_KEY]: { kind: 'image-preview', token }
  }
}

interface ImagePreviewOverlayContextValue {
  isOpen: boolean
  register: () => () => void
  beginHistoryEntry: (close: () => void) => string
  requestHistoryClose: (token: string, close: () => void) => void
  abandonHistoryEntry: (token: string) => void
}

const ImagePreviewOverlayContext = createContext<ImagePreviewOverlayContextValue | null>(null)

export function ImagePreviewOverlayProvider({ children }: { children: ReactNode }): JSX.Element {
  const [openCount, setOpenCount] = useState(0)
  const activeHistoryRef = useRef<ActiveHistoryPreview | null>(null)
  const fallbackTimerRef = useRef<number | null>(null)

  const clearFallback = useCallback(() => {
    if (fallbackTimerRef.current != null) {
      window.clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = null
    }
  }, [])

  const finishHistoryPreview = useCallback(
    (token: string, fallbackClose?: () => void) => {
      const active = activeHistoryRef.current
      if (!active || active.token !== token) return
      clearFallback()
      activeHistoryRef.current = null
      ;(active.close ?? fallbackClose)?.()
    },
    [clearFallback]
  )

  useEffect(() => {
    const onPopState = (event: PopStateEvent): void => {
      const active = activeHistoryRef.current
      if (!active) return
      const marker = readImagePreviewHistoryMarker(event.state)
      if (marker?.token === active.token) return
      finishHistoryPreview(active.token)
    }
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
      clearFallback()
    }
  }, [clearFallback, finishHistoryPreview])

  const beginHistoryEntry = useCallback((close: () => void): string => {
    const token = createToken()
    activeHistoryRef.current = { token, phase: 'open', close }
    window.history.pushState(
      withImagePreviewHistoryMarker(window.history.state, token),
      '',
      window.location.href
    )
    return token
  }, [])

  const requestHistoryClose = useCallback(
    (token: string, close: () => void): void => {
      const active = activeHistoryRef.current
      if (!active || active.token !== token) {
        close()
        return
      }
      if (active.phase === 'closing') return
      const marker = readImagePreviewHistoryMarker(window.history.state)
      if (marker?.token !== token) {
        finishHistoryPreview(token, close)
        return
      }
      active.phase = 'closing'
      window.history.back()
      fallbackTimerRef.current = window.setTimeout(() => {
        finishHistoryPreview(token, close)
      }, HISTORY_CLOSE_FALLBACK_MS)
    },
    [finishHistoryPreview]
  )

  const abandonHistoryEntry = useCallback(
    (token: string): void => {
      if (activeHistoryRef.current?.token !== token) return
      clearFallback()
      activeHistoryRef.current = null
    },
    [clearFallback]
  )

  const register = useCallback(() => {
    setOpenCount((count) => count + 1)
    return () => setOpenCount((count) => Math.max(0, count - 1))
  }, [])

  const value = useMemo(
    () => ({
      isOpen: openCount > 0,
      register,
      beginHistoryEntry,
      requestHistoryClose,
      abandonHistoryEntry
    }),
    [abandonHistoryEntry, beginHistoryEntry, openCount, register, requestHistoryClose]
  )

  return (
    <ImagePreviewOverlayContext.Provider value={value}>{children}</ImagePreviewOverlayContext.Provider>
  )
}

export function useHistoryBackedImagePreviewState(): {
  isOpen: boolean
  open: () => void
  close: () => void
} {
  const { beginHistoryEntry, requestHistoryClose, abandonHistoryEntry } =
    useImagePreviewOverlay()
  const [isOpen, setIsOpen] = useState(false)
  const tokenRef = useRef<string | null>(null)

  const finish = useCallback(() => {
    tokenRef.current = null
    setIsOpen(false)
  }, [])

  const open = useCallback(() => {
    if (tokenRef.current) return
    tokenRef.current = beginHistoryEntry(finish)
    setIsOpen(true)
  }, [beginHistoryEntry, finish])

  const close = useCallback(() => {
    const token = tokenRef.current
    if (!token) {
      setIsOpen(false)
      return
    }
    requestHistoryClose(token, finish)
  }, [finish, requestHistoryClose])

  useEffect(() => {
    return () => {
      const token = tokenRef.current
      if (token) abandonHistoryEntry(token)
    }
  }, [abandonHistoryEntry])

  return { isOpen, open, close }
}

export function useImagePreviewOverlay(): ImagePreviewOverlayContextValue {
  const value = useContext(ImagePreviewOverlayContext)
  if (!value) {
    throw new Error('useImagePreviewOverlay must be used inside ImagePreviewOverlayProvider')
  }
  return value
}
