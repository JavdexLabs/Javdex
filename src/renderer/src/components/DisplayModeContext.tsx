import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type CoverMode = 'portrait' | 'landscape'

interface DisplayModeCtx {
  mode: CoverMode
  setMode: (m: CoverMode) => void
  toggle: () => void
}

const STORAGE_KEY = 'coverDisplayMode'

const Ctx = createContext<DisplayModeCtx>({
  mode: 'portrait',
  setMode: () => {},
  toggle: () => {}
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

  useEffect(() => {
    document.documentElement.dataset.coverMode = mode
  }, [mode])

  return <Ctx.Provider value={{ mode, setMode, toggle }}>{children}</Ctx.Provider>
}
