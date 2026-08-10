import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'

export type CoverMode = 'portrait' | 'landscape'

interface DisplayModeCtx {
  mode: CoverMode
  setMode: (m: CoverMode) => void
  toggle: () => void
  showResourceTypeBadges: boolean
  syncResourceTypeBadges: (show: boolean) => void
}

const STORAGE_KEY = 'coverDisplayMode'

const Ctx = createContext<DisplayModeCtx>({
  mode: 'portrait',
  setMode: () => {},
  toggle: () => {},
  showResourceTypeBadges: false,
  syncResourceTypeBadges: () => {}
})

export function useDisplayMode(): DisplayModeCtx {
  return useContext(Ctx)
}

function readInitial(): CoverMode {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'landscape' ? 'landscape' : 'portrait'
}

export function DisplayModeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [mode, setModeState] = useState<CoverMode>(readInitial)
  const [showResourceTypeBadges, setShowResourceTypeBadges] = useState(false)

  useEffect(() => {
    api.settings
      .get()
      .then((settings) => setShowResourceTypeBadges(settings.showVideoResourceTypeBadges))
      .catch(() => setShowResourceTypeBadges(false))
  }, [])

  const setMode = useCallback((m: CoverMode) => {
    setModeState(m)
    localStorage.setItem(STORAGE_KEY, m)
  }, [])

  const toggle = useCallback(() => {
    setModeState((prev) => {
      const next = prev === 'portrait' ? 'landscape' : 'portrait'
      localStorage.setItem(STORAGE_KEY, next)
      return next
    })
  }, [])

  const syncResourceTypeBadges = useCallback((show: boolean) => {
    setShowResourceTypeBadges(show)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.coverMode = mode
  }, [mode])

  return (
    <Ctx.Provider
      value={{ mode, setMode, toggle, showResourceTypeBadges, syncResourceTypeBadges }}
    >
      {children}
    </Ctx.Provider>
  )
}
