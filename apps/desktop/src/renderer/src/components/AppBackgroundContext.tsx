import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from 'react'

interface AppBackgroundState {
  path: string
  label?: string
}

type AppBackgroundStore = Record<string, AppBackgroundState>

interface AppBackgroundContextValue {
  getBackground: (scope: string | null | undefined) => AppBackgroundState | null
  setBackground: (scope: string | null | undefined, background: AppBackgroundState) => void
  clearBackground: (scope: string | null | undefined) => void
  isCurrentBackground: (scope: string | null | undefined, path: string | null | undefined) => boolean
}

const AppBackgroundContext = createContext<AppBackgroundContextValue | null>(null)

function normalizeScope(scope: string | null | undefined): string | null {
  const normalized = scope?.trim()
  return normalized ? normalized : null
}

export function AppBackgroundProvider({ children }: { children: ReactNode }): JSX.Element {
  const [backgrounds, setBackgrounds] = useState<AppBackgroundStore>({})

  const getBackground = useCallback(
    (scope: string | null | undefined) => {
      const normalizedScope = normalizeScope(scope)
      return normalizedScope ? backgrounds[normalizedScope] ?? null : null
    },
    [backgrounds]
  )

  const setBackground = useCallback((scope: string | null | undefined, next: AppBackgroundState) => {
    const normalizedScope = normalizeScope(scope)
    const path = next.path.trim()
    if (!normalizedScope || !path) return
    setBackgrounds((current) => {
      const existing = current[normalizedScope]
      if (existing?.path === path && existing.label === next.label) return current
      return {
        ...current,
        [normalizedScope]: { path, label: next.label }
      }
    })
  }, [])

  const clearBackground = useCallback((scope: string | null | undefined) => {
    const normalizedScope = normalizeScope(scope)
    if (!normalizedScope) return
    setBackgrounds((current) => {
      if (!current[normalizedScope]) return current
      const next = { ...current }
      delete next[normalizedScope]
      return next
    })
  }, [])

  const isCurrentBackground = useCallback(
    (scope: string | null | undefined, path: string | null | undefined) =>
      Boolean(path && getBackground(scope)?.path === path),
    [getBackground]
  )

  const value = useMemo(
    () => ({ getBackground, setBackground, clearBackground, isCurrentBackground }),
    [clearBackground, getBackground, isCurrentBackground, setBackground]
  )

  return <AppBackgroundContext.Provider value={value}>{children}</AppBackgroundContext.Provider>
}

export function useAppBackground(): AppBackgroundContextValue {
  const value = useContext(AppBackgroundContext)
  if (!value) throw new Error('useAppBackground must be used inside AppBackgroundProvider')
  return value
}
