import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { createOverlayHistory, type OverlayHistory } from './overlayHistory'

const Context = createContext<OverlayHistory | null>(null)
export function OverlayHistoryProvider({ children }: { children: ReactNode }): JSX.Element {
  const history = useRef<OverlayHistory>()
  if (!history.current) history.current = createOverlayHistory({
    read: () => ({ state: window.history.state, url: window.location.href }),
    push: (state, url) => window.history.pushState(state, '', url),
    go: delta => window.history.go(delta),
    later: callback => { const timer = window.setTimeout(callback, 300); return () => window.clearTimeout(timer) },
    token: () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  })
  const coordinator = history.current
  useEffect(() => {
    const pop = (event: PopStateEvent): void => coordinator.pop(event.state)
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [coordinator])
  return <Context.Provider value={coordinator}>{children}</Context.Provider>
}
export function useOverlayHistory(): OverlayHistory {
  const history = useContext(Context)
  if (!history) throw new Error('useOverlayHistory must be used inside OverlayHistoryProvider')
  return history
}
