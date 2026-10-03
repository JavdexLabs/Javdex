import { createContext, useCallback, useContext, useEffect, useId, useRef, type ReactNode } from 'react'
import { UNSAFE_DataRouterContext, useBlocker, useLocation, useNavigate, type Location, type NavigationType } from 'react-router-dom'
import { useOverlayHistory } from './OverlayHistoryContext'

export interface NavigationDecision { proceed(): void; reset(): void }
interface Guard { enabled(): boolean; blocked(decision: NavigationDecision): void }
const Context = createContext<Map<string, Guard> | null>(null)
interface NavigationIntent {
  location: Location
  action: NavigationType
  index: number | null
  approved: Set<string>
  prompting: string | null
  cancelWait?: () => void
}
function historyIndex(): number | null {
  const index: unknown = window.history?.state?.idx
  return typeof index === 'number' ? index : null
}
function matchesIntent(intent: NavigationIntent, location: Location, action: NavigationType): boolean {
  return intent.action === action && (action === 'POP' ? intent.location.key === location.key :
    intent.location.pathname === location.pathname && intent.location.search === location.search && intent.location.hash === location.hash)
}

/** The data router supports one blocker. Compose real leave guards without history traps. */
export function NavigationGuardProvider({ children }: { children: ReactNode }): JSX.Element {
  const guards = useRef(new Map<string, Guard>()).current
  const history = useOverlayHistory()
  const location = useLocation()
  const navigate = useNavigate()
  // A raw overlay POP can reset router.state before React renders useBlocker's new value.
  const { router } = useContext(UNSAFE_DataRouterContext)!
  const pending = useRef<NavigationIntent | null>(null)
  const replay = useRef<NavigationIntent | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    history.route()
    if (replay.current && matchesIntent(replay.current, location, router.state.historyAction)) replay.current = null
  }, [history, location, router])
  const blocker = useBlocker(({ currentLocation, nextLocation, historyAction }) => {
    if (currentLocation.pathname === nextLocation.pathname && currentLocation.search === nextLocation.search) return false
    const resumed = replay.current && matchesIntent(replay.current, nextLocation, historyAction) ? replay.current : null
    pending.current?.cancelWait?.()
    pending.current = null
    replay.current = null
    if (!history.isTraversing() && ![...guards].some(([id, guard]) => !resumed?.approved.has(id) && guard.enabled())) return false
    pending.current = resumed ?? {
      location: nextLocation, action: historyAction, index: historyAction === 'POP' ? historyIndex() : null,
      approved: new Set(), prompting: null
    }
    return true
  })
  const advance = useCallback((): void => {
    const intent = pending.current
    if (!mounted.current || !intent || intent.prompting) return
    if (history.isTraversing()) {
      if (!intent.cancelWait) intent.cancelWait = history.afterTraversal(() => { intent.cancelWait = undefined; advance() })
      return
    }
    const entry = [...guards].find(([id, guard]) => !intent.approved.has(id) && guard.enabled())
    if (entry) {
      const [id, guard] = entry
      intent.prompting = id
      guard.blocked({
        proceed: () => {
          if (!mounted.current || pending.current !== intent || intent.prompting !== id) return
          intent.prompting = null; intent.approved.add(id); advance()
        },
        reset: () => {
          if (pending.current !== intent || intent.prompting !== id) return
          pending.current = null; intent.cancelWait?.()
          const current = [...router.state.blockers.values()].find(value => value.state === 'blocked' && value.location.key === intent.location.key)
          if (current?.state === 'blocked') current.reset()
        }
      })
      return
    }
    const current = [...router.state.blockers.values()].find(value => value.state === 'blocked' && value.location.key === intent.location.key)
    pending.current = null
    // Approval belongs to the intent, including the router's asynchronous POP rollback.
    replay.current = intent
    if (current?.state === 'blocked') { current.proceed(); return }
    if (intent.action === 'POP') {
      const index = historyIndex()
      if (index !== null && intent.index !== null && index !== intent.index) void navigate(intent.index - index)
      else replay.current = null
    } else {
      void navigate({ pathname: intent.location.pathname, search: intent.location.search, hash: intent.location.hash },
        { state: intent.location.state, replace: intent.action === 'REPLACE' })
    }
  }, [guards, history, navigate, router])
  useEffect(() => { advance() }, [advance, blocker])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; pending.current?.cancelWait?.(); pending.current = null; replay.current = null }
  }, [])
  return <Context.Provider value={guards}>{children}</Context.Provider>
}
export function useNavigationGuard(enabled: () => boolean, blocked: Guard['blocked']): void {
  const guards = useContext(Context)
  if (!guards) throw new Error('useNavigationGuard must be used inside NavigationGuardProvider')
  const id = useId()
  const current = useRef({ enabled, blocked })
  current.current = { enabled, blocked }
  useEffect(() => {
    guards.set(id, { enabled: () => current.current.enabled(), blocked: decision => current.current.blocked(decision) })
    return () => { guards.delete(id) }
  }, [guards, id])
}
