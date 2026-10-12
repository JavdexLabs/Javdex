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
import { useOverlayHistory } from '../interaction/OverlayHistoryContext'
import { readOverlayHistoryMarker, withOverlayHistoryMarker } from '../interaction/overlayHistory'

export { IMAGE_PREVIEW_HISTORY_KEY } from '../interaction/overlayHistory'

interface ImagePreviewHistoryMarker {
  token: string
  kind: 'image-preview'
}

export function readImagePreviewHistoryMarker(state: unknown): ImagePreviewHistoryMarker | null {
  const marker = readOverlayHistoryMarker(state)
  return marker?.kind === 'image-preview' ? { kind: 'image-preview', token: marker.token } : null
}

export function withImagePreviewHistoryMarker(
  state: unknown,
  token: string
): Record<string, unknown> {
  return withOverlayHistoryMarker(state, { kind: 'image-preview', token })
}

interface ImagePreviewOverlayContextValue {
  isOpen: boolean
  previewEnabled: boolean
  register: () => () => void
  beginHistoryEntry: (close: () => void) => string
  requestHistoryClose: (token: string, close: () => void) => void
  abandonHistoryEntry: (token: string) => void
}

const ImagePreviewOverlayContext = createContext<ImagePreviewOverlayContextValue | null>(null)

export function ImagePreviewOverlayProvider({
  children,
  previewEnabled = true
}: {
  children: ReactNode
  previewEnabled?: boolean
}): JSX.Element {
  const [openCount, setOpenCount] = useState(0)
  const history = useOverlayHistory()
  const beginHistoryEntry = useCallback((close: () => void) => history.open('image-preview', close), [history])
  const requestHistoryClose = useCallback((token: string) => history.close(token), [history])
  const abandonHistoryEntry = history.abandon

  const register = useCallback(() => {
    setOpenCount((count) => count + 1)
    return () => setOpenCount((count) => Math.max(0, count - 1))
  }, [])

  const value = useMemo(
    () => ({
      isOpen: openCount > 0,
      previewEnabled,
      register,
      beginHistoryEntry,
      requestHistoryClose,
      abandonHistoryEntry
    }),
    [
      abandonHistoryEntry,
      beginHistoryEntry,
      openCount,
      previewEnabled,
      register,
      requestHistoryClose
    ]
  )

  return (
    <ImagePreviewOverlayContext.Provider value={value}>{children}</ImagePreviewOverlayContext.Provider>
  )
}

export function useHistoryBackedImagePreviewState(): {
  isOpen: boolean
  isEnabled: boolean
  open: () => void
  close: () => void
} {
  const { previewEnabled, beginHistoryEntry, requestHistoryClose, abandonHistoryEntry } =
    useImagePreviewOverlay()
  const [isOpen, setIsOpen] = useState(false)
  const tokenRef = useRef<string | null>(null)

  const finish = useCallback(() => {
    tokenRef.current = null
    setIsOpen(false)
  }, [])

  const open = useCallback(() => {
    if (!previewEnabled || tokenRef.current) return
    tokenRef.current = beginHistoryEntry(finish)
    setIsOpen(true)
  }, [beginHistoryEntry, finish, previewEnabled])

  const close = useCallback(() => {
    const token = tokenRef.current
    if (!token) {
      setIsOpen(false)
      return
    }
    requestHistoryClose(token, finish)
  }, [finish, requestHistoryClose])

  useEffect(() => {
    if (!previewEnabled && isOpen) close()
  }, [close, isOpen, previewEnabled])

  useEffect(() => {
    return () => {
      const token = tokenRef.current
      if (token) abandonHistoryEntry(token)
    }
  }, [abandonHistoryEntry])

  return { isOpen, isEnabled: previewEnabled, open, close }
}

export function useImagePreviewOverlay(): ImagePreviewOverlayContextValue {
  const value = useContext(ImagePreviewOverlayContext)
  if (!value) {
    throw new Error('useImagePreviewOverlay must be used inside ImagePreviewOverlayProvider')
  }
  return value
}
