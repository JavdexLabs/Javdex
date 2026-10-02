import { useEffect, useState } from 'react'
import { createBrowseSession } from './browseSession'

export function useBrowseSession(scope: string, enabled = true) {
  const [session] = useState(() => createBrowseSession(scope))
  session.setScope(scope)
  session.setActive(enabled)
  useEffect(() => {
    session.setActive(enabled)
    return () => session.setActive(false)
  }, [enabled, session])
  return session
}
