import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  normalizeCoverDisplayMode,
  normalizeCoverSizePreset,
  normalizeListLoadMode,
  normalizeListPageSize,
  type CoverDisplayMode,
  type CoverSizePreset,
  type ListLoadMode,
  type ListPageSize
} from '@shared/settingsTypes'

export type CoverMode = CoverDisplayMode

interface DisplayModeCtx {
  mode: CoverMode
  setMode: (m: CoverMode) => void
  coverSize: CoverSizePreset
  setCoverSize: (size: CoverSizePreset) => void
  persistCoverSize: (size: CoverSizePreset) => Promise<boolean>
  listLoadMode: ListLoadMode
  setListLoadMode: (mode: ListLoadMode) => void
  listPageSize: ListPageSize
  setListPageSize: (size: ListPageSize) => void
  persistListPageSize: (size: ListPageSize) => Promise<boolean>
  showResourceTypeBadges: boolean
  syncResourceTypeBadges: (show: boolean) => void
}

const LEGACY_STORAGE_KEY = 'coverDisplayMode'

const Ctx = createContext<DisplayModeCtx>({
  mode: 'portrait',
  setMode: () => {},
  coverSize: 'md',
  setCoverSize: () => {},
  persistCoverSize: async () => true,
  listLoadMode: 'scroll',
  setListLoadMode: () => {},
  listPageSize: 100,
  setListPageSize: () => {},
  persistListPageSize: async () => true,
  showResourceTypeBadges: false,
  syncResourceTypeBadges: () => {}
})

export function useDisplayMode(): DisplayModeCtx {
  return useContext(Ctx)
}

function readLegacyCoverMode(): CoverMode | null {
  if (typeof localStorage === 'undefined') return null
  const value = localStorage.getItem(LEGACY_STORAGE_KEY)
  if (value === 'landscape' || value === 'portrait') return value
  return null
}

function clearLegacyCoverMode(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  }
}

function useSavedPreference<T>(initial: T, save: (value: T) => Promise<T>) {
  const [value, render] = useState(initial)
  const revision = useRef(0)
  const visibleRevision = useRef(0)
  const confirmed = useRef({ revision: 0, value: initial })
  const load = useCallback((next: T) => {
    if (revision.current !== 0) return
    confirmed.current.value = next
    render(next)
  }, [])
  const set = useCallback((next: T) => {
    confirmed.current = { revision: ++revision.current, value: next }
    visibleRevision.current = revision.current
    render(next)
  }, [])
  const persist = useCallback(async (next: T) => {
    const request = ++revision.current
    visibleRevision.current = request
    render(next)
    try {
      const saved = await save(next)
      if (request > confirmed.current.revision) confirmed.current = { revision: request, value: saved }
      if (request >= visibleRevision.current) {
        visibleRevision.current = request
        render(saved)
      }
      return true
    } catch {
      if (request === visibleRevision.current) {
        visibleRevision.current = confirmed.current.revision
        render(confirmed.current.value)
      }
      return false
    }
  }, [save])
  return [value, set, load, persist] as const
}

async function saveCoverSize(value: CoverSizePreset): Promise<CoverSizePreset> {
  return normalizeCoverSizePreset((await window.api.settings.update({ coverSizePreset: value })).coverSizePreset)
}

async function savePageSize(value: ListPageSize): Promise<ListPageSize> {
  return normalizeListPageSize((await window.api.settings.update({ listPageSize: value })).listPageSize)
}

export function DisplayModeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [applicationMode, setApplicationMode] = useState<CoverMode>(
    () => readLegacyCoverMode() ?? 'portrait'
  )
  const [coverSize, setCoverSize, loadCoverSize, persistCoverSize] = useSavedPreference<CoverSizePreset>('md', saveCoverSize)
  const [listPageSize, setListPageSize, loadPageSize, persistListPageSize] = useSavedPreference<ListPageSize>(100, savePageSize)
  const [listLoadMode, setListLoadModeState] = useState<ListLoadMode>('scroll')
  const [showResourceTypeBadges, setShowResourceTypeBadges] = useState(false)
  const touchedMode = useRef(false)
  const touchedLoadMode = useRef(false)

  useEffect(() => {
    let active = true
    window.api.settings
      .get()
      .then(async (settings) => {
        if (!active) return
        setShowResourceTypeBadges(settings.showVideoResourceTypeBadges)
        loadCoverSize(normalizeCoverSizePreset(settings.coverSizePreset))
        loadPageSize(normalizeListPageSize(settings.listPageSize))
        if (!touchedLoadMode.current) setListLoadModeState(normalizeListLoadMode(settings.listLoadMode))
        const legacy = readLegacyCoverMode()
        const fromSettings = normalizeCoverDisplayMode(settings.coverDisplayMode)
        if (legacy && legacy !== fromSettings) {
          try {
            const next = await window.api.settings.update({ coverDisplayMode: legacy })
            if (!active) return
            clearLegacyCoverMode()
            if (!touchedMode.current) {
              setApplicationMode(normalizeCoverDisplayMode(next.coverDisplayMode))
            }
            return
          } catch {
            if (!active) return
            if (!touchedMode.current) setApplicationMode(legacy)
            return
          }
        }
        clearLegacyCoverMode()
        if (!touchedMode.current) setApplicationMode(fromSettings)
      })
      .catch(() => {
        if (!active) return
        setShowResourceTypeBadges(false)
      })
    return () => {
      active = false
    }
  }, [loadCoverSize, loadPageSize])

  const setMode = useCallback((m: CoverMode) => {
    touchedMode.current = true
    setApplicationMode(m)
  }, [])

  const setListLoadMode = useCallback((next: ListLoadMode) => {
    touchedLoadMode.current = true
    setListLoadModeState(normalizeListLoadMode(next))
  }, [])

  const syncResourceTypeBadges = useCallback((show: boolean): void => {
    setShowResourceTypeBadges(show)
  }, [])

  useEffect(() => {
    if (document.documentElement?.dataset) {
      document.documentElement.dataset.coverMode = applicationMode
    }
  }, [applicationMode])

  useEffect(() => {
    if (document.documentElement?.dataset) {
      document.documentElement.dataset.coverSize = coverSize
    }
  }, [coverSize])

  return (
    <Ctx.Provider
      value={{
        mode: applicationMode,
        setMode,
        coverSize,
        setCoverSize,
        persistCoverSize,
        listLoadMode,
        setListLoadMode,
        listPageSize,
        setListPageSize,
        persistListPageSize,
        showResourceTypeBadges,
        syncResourceTypeBadges
      }}
    >
      {children}
    </Ctx.Provider>
  )
}
