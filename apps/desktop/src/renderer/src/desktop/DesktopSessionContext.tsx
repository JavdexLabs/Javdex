import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  ASSUMED_LOCAL_SESSION,
  sessionAllowsCatalogReads,
  type DesktopSession,
  type DesktopSessionSnapshot,
  type DesktopWriterClaimRequest,
  type DesktopWriterClaimResult
} from '@shared/desktop/session'
import type { DesktopCapabilityMap } from '@shared/desktop/capabilities'
import { DESKTOP_CAPABILITY_ACTIONS } from '@shared/desktop/capabilities'
import { queryClient } from '../query/queryClient'

function assumedLocalCapabilities(): DesktopCapabilityMap {
  return Object.fromEntries(
    DESKTOP_CAPABILITY_ACTIONS.map((action) => [
      action,
      {
        action,
        allowed: action !== 'playRemoteFile',
        reason: action === 'playRemoteFile' ? 'localMode' : 'available'
      }
    ])
  ) as DesktopCapabilityMap
}

const FALLBACK_CAPABILITIES = assumedLocalCapabilities()

interface DesktopSessionContextValue {
  session: DesktopSession
  capabilities: DesktopCapabilityMap
  catalogReadsEnabled: boolean
  reconnect: () => Promise<void>
  claimWriter: (input: DesktopWriterClaimRequest) => Promise<DesktopWriterClaimResult>
}

export const DesktopSessionContext = createContext<DesktopSessionContextValue>({
  session: ASSUMED_LOCAL_SESSION,
  capabilities: FALLBACK_CAPABILITIES,
  catalogReadsEnabled: true,
  reconnect: async () => undefined,
  claimWriter: async () => {
    throw new Error('当前环境不能领取写入凭据')
  }
})

export function DesktopSessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<DesktopSession>(ASSUMED_LOCAL_SESSION)
  const [capabilities, setCapabilities] = useState<DesktopCapabilityMap>(FALLBACK_CAPABILITIES)
  const identityRef = useRef({ catalogId: ASSUMED_LOCAL_SESSION.catalogId, generation: ASSUMED_LOCAL_SESSION.generation })

  const applySnapshot = useCallback((snapshot: DesktopSessionSnapshot) => {
    const previous = identityRef.current
    if (
      previous.catalogId !== snapshot.session.catalogId ||
      previous.generation !== snapshot.session.generation
    ) {
      queryClient.clear()
    }
    identityRef.current = {
      catalogId: snapshot.session.catalogId,
      generation: snapshot.session.generation
    }
    setSession(snapshot.session)
    setCapabilities(snapshot.capabilities)
  }, [])

  useEffect(() => {
    const desktop = window.api?.desktop
    if (!desktop?.getSession) return
    let cancelled = false
    void desktop.getSession().then((snapshot) => {
      if (!cancelled) applySnapshot(snapshot)
    })
    const unsubscribe = desktop.onSessionChanged?.(applySnapshot)
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [applySnapshot])

  const reconnect = useCallback(async () => {
    applySnapshot(await window.api.desktop.reconnect())
  }, [applySnapshot])

  const claimWriter = useCallback(
    async (input: DesktopWriterClaimRequest) => {
      const result = await window.api.desktop.claimWriter(input)
      applySnapshot(await window.api.desktop.getSession())
      return result
    },
    [applySnapshot]
  )

  const value = useMemo(
    () => ({
      session,
      capabilities,
      catalogReadsEnabled: sessionAllowsCatalogReads(session),
      reconnect,
      claimWriter
    }),
    [session, capabilities, reconnect, claimWriter]
  )

  return <DesktopSessionContext.Provider value={value}>{children}</DesktopSessionContext.Provider>
}

export function useDesktopSession(): DesktopSessionContextValue {
  return useContext(DesktopSessionContext)
}
