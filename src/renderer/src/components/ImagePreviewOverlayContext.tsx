import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

interface ImagePreviewOverlayContextValue {
  isOpen: boolean
  register: () => () => void
}

const ImagePreviewOverlayContext = createContext<ImagePreviewOverlayContextValue | null>(null)

export function ImagePreviewOverlayProvider({ children }: { children: ReactNode }): JSX.Element {
  const [openCount, setOpenCount] = useState(0)

  const register = useCallback(() => {
    setOpenCount((count) => count + 1)
    return () => setOpenCount((count) => Math.max(0, count - 1))
  }, [])

  const value = useMemo(
    () => ({ isOpen: openCount > 0, register }),
    [openCount, register]
  )

  return (
    <ImagePreviewOverlayContext.Provider value={value}>{children}</ImagePreviewOverlayContext.Provider>
  )
}

export function useImagePreviewOverlay(): ImagePreviewOverlayContextValue {
  const value = useContext(ImagePreviewOverlayContext)
  if (!value) {
    throw new Error('useImagePreviewOverlay must be used inside ImagePreviewOverlayProvider')
  }
  return value
}
