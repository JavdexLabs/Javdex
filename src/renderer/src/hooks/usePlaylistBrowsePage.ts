import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PlaylistListPage, PlaylistListQuery } from '@shared/playlistTypes'
import { api } from '../api'

/** Exactly one page; each A→B→A query transition creates a fresh request identity. */
export function usePlaylistBrowsePage(query: PlaylistListQuery, enabled = true) {
  const key = JSON.stringify([enabled,query.search ?? '',query.offset ?? 0,query.limit ?? 60,query.videoId,query.locale])
  const identity = useMemo(() => ({ key }), [key])
  const current = useRef(identity)
  current.current = identity
  const sequence = useRef(0)
  const mounted = useRef(true)
  const [snapshot,setSnapshot] = useState<{ identity: typeof identity; loading: boolean; data?: PlaylistListPage; error?: string }>()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const reload = useCallback(async () => {
    if (!enabled || current.current !== identity || !mounted.current) return
    const request = ++sequence.current
    const [,search,offset,limit,videoId,locale] = JSON.parse(identity.key)
    setSnapshot({ identity,loading:true })
    try {
      const data = await api.playlists.listPage({search,offset,limit,...(videoId === null ? {} : {videoId}),...(locale === null ? {} : {locale})})
      if (mounted.current && current.current === identity && request === sequence.current) setSnapshot({ identity,loading:false,data })
    } catch (error) {
      if (mounted.current && current.current === identity && request === sequence.current) setSnapshot({ identity,loading:false,error:error instanceof Error ? error.message : String(error) })
    }
  }, [enabled,identity])
  useEffect(() => { void reload() }, [reload])
  const matched = enabled && snapshot?.identity === identity ? snapshot : undefined
  return { data: matched?.data, loading: enabled && (!matched || matched.loading), error: matched?.error, reload }
}
