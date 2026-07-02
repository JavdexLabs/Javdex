import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { ThemeId } from '@shared/types'
import { api } from '../api'
import { applyTheme, normalizeTheme } from '../theme'

interface ThemeCtx {
  theme: ThemeId
  setTheme: (theme: ThemeId) => Promise<void>
}

const Ctx = createContext<ThemeCtx>({
  theme: 'graphite',
  setTheme: async () => {}
})

export function useTheme(): ThemeCtx {
  return useContext(Ctx)
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [theme, setThemeState] = useState<ThemeId>('graphite')

  useEffect(() => {
    api.settings
      .get()
      .then((s) => {
        const t = normalizeTheme(s.theme)
        applyTheme(t)
        setThemeState(t)
      })
      .catch(() => applyTheme('graphite'))
  }, [])

  const setTheme = useCallback(async (next: ThemeId) => {
    applyTheme(next)
    setThemeState(next)
    await api.settings.update({ theme: next })
  }, [])

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>
}
