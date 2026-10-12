import { useCallback, useEffect, useRef, useState } from 'react'
import type { RecentPlaybackMetadata } from '@shared/desktop/recentPlayback'
import { api } from '../api'
import { useDesktopSession } from '../desktop/DesktopSessionContext'

export function useRecentPlayback() {
  const { session } = useDesktopSession()
  const scope = JSON.stringify([session.mode, session.serverId, session.catalogId, session.generation])
  const sequence = useRef(0)
  const invalidate = useCallback(() => { sequence.current++ }, [])
  const [value, setValue] = useState<{ scope: string; metadata: RecentPlaybackMetadata | null; error: string | null }>({ scope, metadata: null, error: null })
  const reload = useCallback(async () => {
    if (!api.recentPlayback) return
    const ticket = ++sequence.current
    try {
      const metadata = await api.recentPlayback.metadata()
      if (ticket === sequence.current) setValue({ scope, metadata, error: null })
    } catch (error) {
      if (ticket === sequence.current) setValue(old => ({ scope, metadata: old.scope === scope ? old.metadata : null, error: (error as Error).message }))
    }
  }, [scope])
  useEffect(() => {
    void reload()
    const unsubscribe = api.recentPlayback?.onChanged(() => { void reload() })
    return () => { invalidate(); unsubscribe?.() }
  }, [reload, invalidate])
  return { metadata: value.scope === scope ? value.metadata : null, error: value.scope === scope ? value.error : null, reload }
}
