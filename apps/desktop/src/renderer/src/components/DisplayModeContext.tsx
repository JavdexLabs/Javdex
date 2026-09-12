import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import { normalizeCoverDisplayMode, type CoverDisplayMode } from '@shared/settingsTypes'

export type CoverMode = CoverDisplayMode

interface DisplayModeCtx {
  mode: CoverMode
  setMode: (m: CoverMode) => void
  showResourceTypeBadges: boolean
  syncResourceTypeBadges: (show: boolean) => void
}

const LEGACY_STORAGE_KEY = 'coverDisplayMode'

const Ctx = createContext<DisplayModeCtx>({
  mode: 'portrait',
  setMode: () => {},
  showResourceTypeBadges: false,
  syncResourceTypeBadges: () => {}
})

export function useDisplayMode(): DisplayModeCtx {
  return useContext(Ctx)
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
  const [showResourceTypeBadges, setShowResourceTypeBadges] = useState(false)

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

  const syncResourceTypeBadges = useCallback((show: boolean): void => {
    setShowResourceTypeBadges(show)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.coverMode = applicationMode
  }, [applicationMode])

  return (
    <Ctx.Provider
      value={{
        mode: applicationMode,
        setMode,
        showResourceTypeBadges,
        syncResourceTypeBadges
      }}
    >
      {children}
    </Ctx.Provider>
  )
}
