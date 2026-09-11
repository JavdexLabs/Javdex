import { useEffect, useMemo, useState } from 'react'
import type { PendingAuditIds } from '@shared/libraryTypes'
import { api } from '../api'

/** One displayed page, one result snapshot. Old IPC work is not cancelled, but cannot publish. */
export function usePendingAuditPresence(libraryId: number, ids: PendingAuditIds, scope: string) {
  const [attempt, setAttempt] = useState(0)
  const [snapshot, setSnapshot] = useState<{ request: object; state: 'ready' | 'error'; ids: Set<string> }>()
  const normalize = (values: number[]) => [...new Set(values)].sort((a,b) => a-b)
  const normalized = {groupIds:normalize(ids.groupIds),identityIds:normalize(ids.identityIds),scrapeIds:normalize(ids.scrapeIds)}
  const empty = !normalized.groupIds.length && !normalized.identityIds.length && !normalized.scrapeIds.length
  const key = JSON.stringify([libraryId,scope,normalized,attempt])
  const request = useMemo(() => ({ key }), [key])
  useEffect(() => {
    const [requestedLibrary, , requested] = JSON.parse(request.key) as [number, string, PendingAuditIds, number]
    let active = true
    if (!requested.groupIds.length && !requested.identityIds.length && !requested.scrapeIds.length) return
    void Promise.resolve().then(() => api.scan.pendingAuditPresence(requestedLibrary, requested)).then(
      existing => { if (active) setSnapshot({request, state:'ready', ids:new Set([...existing.groupIds.map(id => `scan:${id}`), ...existing.identityIds.map(id => `scan:identity-${id}`), ...existing.scrapeIds.map(id => `scrape:${id}`)])}) },
      () => { if (active) setSnapshot({request, state:'error', ids:new Set()}) }
    )
    return () => { active = false }
  }, [request])
  return {
    state: empty ? 'ready' as const : snapshot?.request === request ? snapshot.state : 'loading' as const,
    ids: snapshot?.request === request ? snapshot.ids : new Set<string>(),
    retry: () => setAttempt(value => value + 1)
  }
}
