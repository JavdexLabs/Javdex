import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ScanAuditSnapshotIdentity, ScanAuditViewPage, ScanAuditViewQuery } from '@shared/scanAuditReadTypes'
import { api } from '../api'

/** A new request object is a generation, including A → B → A; only one page is retained. */
export function useScanAuditViewPage(
  snapshot: ScanAuditSnapshotIdentity,
  query: ScanAuditViewQuery,
  revision: number,
  onRefreshHistory: () => Promise<void>,
  enabled = true
) {
  const identity = JSON.stringify(snapshot)
  const session = useMemo(() => ({ identity }), [identity])
  const currentSession = useRef(session)
  currentSession.current = session
  const serial = useRef(0)
  const [refresh, setRefresh] = useState<{
    session: object; token: number; revision: number; state: 'waiting' | 'pending' | 'error'; error?: string
  }>()
  const ownRefresh = refresh?.session === session ? refresh : undefined
  const refreshing = ownRefresh?.state === 'pending' ||
    (ownRefresh?.state === 'waiting' && ownRefresh.revision === revision)
  const refreshError = ownRefresh?.state === 'error' && ownRefresh.revision === revision ? ownRefresh.error : undefined
  const key = JSON.stringify([snapshot, query, revision, ownRefresh?.token, refreshing, refreshError, enabled])
  const request = useMemo(() => ({ key, session }), [key, session])
  const [result, setResult] = useState<{ request: object; page?: ScanAuditViewPage; error?: string }>()

  useEffect(() => {
    let active = true
    // Drop the previous page, including its arrays, while the next request is in flight.
    setResult(undefined)
    if (!enabled || refreshing || refreshError) return
    const [requestedSnapshot, requestedQuery] = JSON.parse(request.key) as [ScanAuditSnapshotIdentity, ScanAuditViewQuery]
    void Promise.resolve().then(async () => {
      if (!active) return
      try {
        const page = await api.scan.getAuditViewPage(requestedSnapshot, requestedQuery)
        if (active) setResult({ request, page })
      } catch (error) {
        if (active) setResult({ request, error: String((error as Error).message ?? error) })
      }
    })
    return () => { active = false }
  }, [request, refreshing, refreshError, enabled])

  const retry = useCallback(async (): Promise<void> => {
    const token = ++serial.current
    setRefresh({ session, token, revision, state: 'pending' })
    try {
      await onRefreshHistory()
      // Header observers may notify after refetch resolves: wait for a new revision too.
      // Completion from an abandoned session cannot alter B or a new A session.
      if (currentSession.current !== session) return
      setRefresh(previous => previous?.session === session && previous.token === token
        ? { session, token, revision, state: 'waiting' } : previous)
    } catch (error) {
      if (currentSession.current !== session) return
      setRefresh(previous => previous?.session === session && previous.token === token
        ? { session, token, revision, state: 'error', error: String((error as Error).message ?? error) } : previous)
    }
  }, [session, revision, onRefreshHistory])
  const current = result?.request === request ? result : undefined
  const error = refreshError ?? current?.error
  return { page: current?.page, error, loading: !error && !current?.page, retry, request }
}
