import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import { normalizeCoverDisplayMode, type CoverDisplayMode } from '@shared/settingsTypes'

export type CoverMode = CoverDisplayMode

interface DisplayModeCtx {
  mode: CoverMode
  setMode: (m: CoverMode) => void
  setScopedMode: (m: CoverMode | null) => void
  toggle: () => void
  showResourceTypeBadges: boolean
  syncResourceTypeBadges: (show: boolean) => void
}

const LEGACY_STORAGE_KEY = 'coverDisplayMode'

const Ctx = createContext<DisplayModeCtx>({
  mode: 'portrait',
  setMode: () => {},
  setScopedMode: () => {},
  toggle: () => {},
  showResourceTypeBadges: false,
  syncResourceTypeBadges: () => {}
})

export function useDisplayMode(): DisplayModeCtx {
  return useContext(Ctx)
}

/**
 * Temporarily applies a surface-owned cover mode without mutating the application default.
 * The latest application setting becomes visible again as soon as the surface unmounts.
 */
export function useScopedDisplayMode(mode: CoverMode | null): void {
  const { setScopedMode } = useDisplayMode()
  useEffect(() => {
    setScopedMode(mode)
    return () => setScopedMode(null)
  }, [mode, setScopedMode])
}

function readLegacyCoverMode(): CoverMode | null {
  const value = localStorage.getItem(LEGACY_STORAGE_KEY)
  if (value === 'landscape' || value === 'portrait') return value
  return null
}

export function DisplayModeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [applicationMode, setApplicationMode] = useState<CoverMode>(
    () => readLegacyCoverMode() ?? 'portrait'
  )
  const [scopedMode, setScopedModeState] = useState<CoverMode | null>(null)
  const [showResourceTypeBadges, setShowResourceTypeBadges] = useState(false)
  const mode = scopedMode ?? applicationMode

  useEffect(() => {
    let active = true
    api.settings
      .get()
      .then(async (settings) => {
        if (!active) return
        setShowResourceTypeBadges(settings.showVideoResourceTypeBadges)
        const legacy = readLegacyCoverMode()
        const fromSettings = normalizeCoverDisplayMode(settings.coverDisplayMode)
        if (legacy && legacy !== fromSettings) {
          try {
            const next = await api.settings.update({ coverDisplayMode: legacy })
            if (!active) return
            localStorage.removeItem(LEGACY_STORAGE_KEY)
            setApplicationMode(normalizeCoverDisplayMode(next.coverDisplayMode))
            return
          } catch {
            if (!active) return
            setApplicationMode(legacy)
            return
          }
        }
        localStorage.removeItem(LEGACY_STORAGE_KEY)
        setApplicationMode(fromSettings)
      })
      .catch(() => {
        if (!active) return
        setShowResourceTypeBadges(false)
      })
    return () => {
      active = false
    }
  }, [])

  const setMode = useCallback((m: CoverMode) => {
    setApplicationMode(m)
  }, [])

  const setScopedMode = useCallback((m: CoverMode | null) => {
    setScopedModeState(m)
  }, [])

  const toggle = useCallback(() => {
    setApplicationMode((previous) =>
      previous === 'portrait' ? 'landscape' : 'portrait'
    )
  }, [])

  const syncResourceTypeBadges = useCallback((show: boolean): void => {
    setShowResourceTypeBadges(show)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.coverMode = mode
  }, [mode])

  return (
    <Ctx.Provider
      value={{
        mode,
        setMode,
        setScopedMode,
        toggle,
        showResourceTypeBadges,
        syncResourceTypeBadges
      }}
    >
      {children}
    </Ctx.Provider>
  )
}
