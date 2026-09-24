import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { PRIVACY_MODE_SCOPES, type ThemeId } from '@shared/settingsTypes'
import { api } from '../api'
import { applyPrivacyMode, readCachedPrivacyMode, type PrivacyModeSettings } from '../privacyMode'
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
  const themeRevisionRef = useRef(0)
  const savedThemeRef = useRef<ThemeId>('graphite')
  const themeQueueRef = useRef(Promise.resolve())

  useEffect(() => {
    const privacyRevision = privacyRevisionRef.current
    const themeRevision = themeRevisionRef.current
    themeQueueRef.current = api.settings
      .get()
      .then((s) => {
        const t = normalizeTheme(s.theme)
        savedThemeRef.current = t
        if (themeRevision === themeRevisionRef.current) {
          applyTheme(t)
          setThemeState(t)
        }
        if (privacyRevision === privacyRevisionRef.current) {
          applyPrivacyMode(s)
          setPrivacyModeState(s)
        }
      })
      .catch(() => {
        if (themeRevision === themeRevisionRef.current) applyTheme('graphite')
      })
  }, [])

  const setTheme = useCallback(async (next: ThemeId) => {
    const revision = ++themeRevisionRef.current
    applyTheme(next)
    setThemeState(next)
    const operation = themeQueueRef.current
      .catch(() => {})
      .then(async () => {
        try {
          await api.settings.update({ theme: next })
          savedThemeRef.current = next
        } catch (error) {
          if (revision === themeRevisionRef.current) {
            applyTheme(savedThemeRef.current)
            setThemeState(savedThemeRef.current)
          }
          throw error
        }
      })
    themeQueueRef.current = operation.catch(() => {})
    await operation
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
