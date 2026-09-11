import type { ScanAuditReadHeader } from '@shared/scanAuditReadTypes'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  LibraryScanEvent,
  ScanProgress,
  ScanCompletionResult
} from '@shared/libraryTypes'
import { api } from '../api'
import { matchesMediaLibraryScanRun } from '../mediaLibraryScanState'
import { invalidateAllLibraryQueries } from '../query/invalidateLibraryQueries'

export const mediaLibraryScanLatestKey = (libraryId: number): readonly unknown[] =>
  ['media-library-scan-header', libraryId] as const

export interface MediaLibraryScanController {
  latest: ScanAuditReadHeader | null
  latestRevision: number
  latestLoading: boolean
  latestError: string | null
  running: boolean
  cancelling: boolean
  activeRunId: string | null
  progress: ScanProgress | null
  result: ScanCompletionResult | null
  error: string | null
  start: () => Promise<void>
  cancel: () => Promise<void>
  refreshLatest: () => Promise<void>
}

export function useMediaLibraryScanController(
  libraryId: number,
  options?: { onSettled?: () => void | Promise<void>; loadLatest?: boolean }
): MediaLibraryScanController {
  const queryClient = useQueryClient()
  const activeRunIdRef = useRef<string | null>(null)
  const handledRunIdsRef = useRef(new Set<string>())
  const onSettledRef = useRef(options?.onSettled)
  onSettledRef.current = options?.onSettled
  const [running, setRunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [result, setResult] = useState<ScanCompletionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loadLatest = options?.loadLatest ?? true
  const latestContextRef = useRef({ libraryId, loadLatest })
  latestContextRef.current = { libraryId, loadLatest }
  const latestRevisionRef = useRef(0)
  const latestQuery = useQuery({
    queryKey: loadLatest ? mediaLibraryScanLatestKey(libraryId) : ['media-library-scan-inactive', libraryId],
    enabled: loadLatest,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const latest = await api.scan.getAuditHeader(libraryId)
      signal.throwIfAborted()
      return { header: latest, revision: ++latestRevisionRef.current }
    }
  })

  const setRunId = useCallback((runId: string | null): void => {
    activeRunIdRef.current = runId
    setActiveRunId(runId)
  }, [])

  const invalidateAfterScan = useCallback(async (): Promise<void> => {
    invalidateAllLibraryQueries(queryClient)
    await queryClient.invalidateQueries({
      queryKey: mediaLibraryScanLatestKey(libraryId),
      exact: true
    })
    await onSettledRef.current?.()
  }, [libraryId, queryClient])

  const completeRun = useCallback(
    async (nextResult: ScanCompletionResult): Promise<void> => {
      if (handledRunIdsRef.current.has(nextResult.runId)) return
      if (!matchesMediaLibraryScanRun(libraryId, activeRunIdRef.current, nextResult)) return
      handledRunIdsRef.current.add(nextResult.runId)
      setResult(nextResult)
      setError(null)
      setProgress(null)
      setRunning(false)
      setCancelling(false)
      setRunId(null)
      await invalidateAfterScan()
    },
    [invalidateAfterScan, libraryId, setRunId]
  )

  const failRun = useCallback(
    async (event: Extract<LibraryScanEvent, { phase: 'failed' }>): Promise<void> => {
      if (handledRunIdsRef.current.has(event.runId)) return
      if (!matchesMediaLibraryScanRun(libraryId, activeRunIdRef.current, event)) return
      handledRunIdsRef.current.add(event.runId)
      setError(event.error)
      setProgress(null)
      setRunning(false)
      setCancelling(false)
      setRunId(null)
      await invalidateAfterScan()
    },
    [invalidateAfterScan, libraryId, setRunId]
  )

  useEffect(
    () =>
      api.scan.onProgress((event) => {
        if (!matchesMediaLibraryScanRun(libraryId, activeRunIdRef.current, event)) return
        if (activeRunIdRef.current == null) setRunId(event.runId)
        setRunning(true)
        setProgress(event.progress)
      }),
    [libraryId, setRunId]
  )

  useEffect(
    () =>
      api.scan.onStateChanged((event) => {
        if (event.libraryId !== libraryId) return
        if (event.phase === 'started') {
          if (activeRunIdRef.current != null && activeRunIdRef.current !== event.runId) return
          setRunId(event.runId)
          setRunning(true)
          setCancelling(false)
          setError(null)
          setProgress(null)
          return
        }
        if (!matchesMediaLibraryScanRun(libraryId, activeRunIdRef.current, event)) return
        if (event.phase === 'progress') {
          setProgress(event.progress)
          return
        }
        if (event.phase === 'completed') void completeRun(event.result)
        else void failRun(event)
      }),
    [completeRun, failRun, libraryId, setRunId]
  )

  const start = async (): Promise<void> => {
    if (running) return
    setRunning(true)
    setCancelling(false)
    setProgress(null)
    setResult(null)
    setError(null)
    try {
      const nextResult = await api.scan.run(libraryId)
      await completeRun(nextResult)
    } catch (scanError) {
      setError(String((scanError as Error).message ?? scanError))
      setRunning(false)
      setCancelling(false)
      setRunId(null)
      await invalidateAfterScan()
    }
  }

  const cancel = async (): Promise<void> => {
    const runId = activeRunIdRef.current
    if (!runId || cancelling) return
    setCancelling(true)
    try {
      const accepted = await api.scan.cancel(runId)
      if (!accepted) setCancelling(false)
    } catch (cancelError) {
      setCancelling(false)
      setError(String((cancelError as Error).message ?? cancelError))
    }
  }

  const refreshLatest = async (): Promise<void> => {
    if (latestContextRef.current.libraryId === libraryId && latestContextRef.current.loadLatest) await latestQuery.refetch()
    else await queryClient.invalidateQueries({queryKey: mediaLibraryScanLatestKey(libraryId), exact: true, refetchType: 'none'})
  }

  return {
    latest: loadLatest ? latestQuery.data?.header ?? null : null,
    latestRevision: loadLatest ? latestQuery.data?.revision ?? 0 : 0,
    latestLoading: loadLatest && latestQuery.isLoading,
    latestError: loadLatest && latestQuery.error ? latestQuery.error.message : null,
    running,
    cancelling,
    activeRunId,
    progress,
    result,
    error,
    start,
    cancel,
    refreshLatest
  }
}
