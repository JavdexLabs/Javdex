import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { PRIVACY_MODE_SCOPES, type ThemeId } from '@shared/types'
import { api } from '../api'
import {
  applyPrivacyMode,
  readCachedPrivacyMode,
  type PrivacyModeSettings
} from '../privacyMode'
import { applyTheme, normalizeTheme } from '../theme'

interface ThemeCtx {
  theme: ThemeId
  setTheme: (theme: ThemeId) => Promise<void>
  privacyMode: PrivacyModeSettings
  syncPrivacyMode: (settings: PrivacyModeSettings) => void
}

const DEFAULT_PRIVACY_MODE: PrivacyModeSettings = {
  privacyModeEnabled: false,
  privacyModeScopes: [...PRIVACY_MODE_SCOPES]
}

const Ctx = createContext<ThemeCtx>({
  theme: 'graphite',
  setTheme: async () => {},
  privacyMode: DEFAULT_PRIVACY_MODE,
  syncPrivacyMode: () => {}
})

export function useTheme(): ThemeCtx {
  return useContext(Ctx)
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [theme, setThemeState] = useState<ThemeId>('graphite')
  const [privacyMode, setPrivacyModeState] = useState<PrivacyModeSettings>(
    () => readCachedPrivacyMode() ?? DEFAULT_PRIVACY_MODE
  )
  const privacyRevisionRef = useRef(0)

  useEffect(() => {
    const privacyRevision = privacyRevisionRef.current
    api.settings
      .get()
      .then((s) => {
        const t = normalizeTheme(s.theme)
        applyTheme(t)
        if (privacyRevision === privacyRevisionRef.current) {
          applyPrivacyMode(s)
          setPrivacyModeState(s)
        }
        setThemeState(t)
      })
      .catch(() => applyTheme('graphite'))
  }, [])

  const setTheme = useCallback(async (next: ThemeId) => {
    applyTheme(next)
    setThemeState(next)
    await api.settings.update({ theme: next })
  }, [])

  const syncPrivacyMode = useCallback((settings: PrivacyModeSettings) => {
    privacyRevisionRef.current += 1
    applyPrivacyMode(settings)
    setPrivacyModeState(settings)
  }, [])

  return (
    <Ctx.Provider value={{ theme, setTheme, privacyMode, syncPrivacyMode }}>
      {children}
    </Ctx.Provider>
  )
}
