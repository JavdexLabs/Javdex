import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { useDesktopSession } from '../desktop/DesktopSessionContext'
import { videoKeys } from '../query/queryKeys'

export function useRecentPlayback() {
  const { session } = useDesktopSession()
  const { data, error, refetch } = useQuery({
    queryKey: [...videoKeys.all, 'recent-playback', session.mode, session.serverId, session.catalogId, session.generation],
    queryFn: () => api.recentPlayback.metadata(),
    enabled: Boolean(api.recentPlayback),
    staleTime: 0,
    gcTime: 0,
    retry: false
  })
  useEffect(() => api.recentPlayback?.onChanged(() => { void refetch() }), [refetch])
  return { metadata: data ?? null, error: error?.message ?? null, reload: refetch }
}
