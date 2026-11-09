import {
  createContext,
  useCallback,
  useRef,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import type { BatchProgress } from '@shared/batchScrapeTypes'
import { api } from '../api'
import { isBatchScrapeActive } from './batchScrapeActivity'

export type BatchScrapeContextValue = {
  refresh?: () => Promise<void>
  loading?: boolean
  error?: string | null
  videoBatch: BatchProgress | null
  actressBatch: BatchProgress | null
  actressBatchRecoverable: boolean
  actressBatchUnrecoverableReason: string | null
  videoBatchActive: boolean
  actressBatchActive: boolean
  anyBatchActive: boolean
}

const BatchScrapeContext = createContext<BatchScrapeContextValue | null>(null)

export function BatchScrapeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [videoBatch, setVideoBatch] = useState<BatchProgress | null>(null)
  const [actressBatch, setActressBatch] = useState<BatchProgress | null>(null)
  const [actressBatchRecoverable, setActressBatchRecoverable] = useState(true)
  const [actressBatchUnrecoverableReason, setActressBatchUnrecoverableReason] = useState<
    string | null
  >(null)

  const revision = useRef(0)
  const mounted = useRef(true)
  const refreshing = useRef(false)
  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing.current) return
    refreshing.current = true
    const request = revision.current
    setLoading(true)
    try {
      const state = await api.batchScrape.getState()
      if (!mounted.current || request !== revision.current) return
      setError(null)
      // Reconcile missed terminal events without discarding recent finished results.
      if (state.kind !== 'video' || !state.progress || state.progress.status === 'idle')
        setVideoBatch(previous => isBatchScrapeActive(previous) ? null : previous)
      if (state.kind !== 'actress' || !state.progress || state.progress.status === 'idle')
        setActressBatch(previous => isBatchScrapeActive(previous) ? null : previous)
      if (!state.progress || state.progress.status === 'idle') return
      if (state.kind === 'video') setVideoBatch(state.progress)
      if (state.kind === 'actress') {
        setActressBatch(state.progress)
        setActressBatchRecoverable(state.recoverable)
        setActressBatchUnrecoverableReason(state.unrecoverableReason ?? null)
      }
    } catch (cause) {
      if (mounted.current && request === revision.current) setError(cause instanceof Error ? cause.message : '刮削任务读取失败')
    } finally {
      refreshing.current = false
      if (mounted.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
  }, [refresh])

  useEffect(() => {
    const offVideo = api.scrape.onVideoBatchProgress((progress) => { revision.current++; setError(null); setVideoBatch(progress) })
    const offActress = api.actressScrape.onBatchProgress((progress) => {
      revision.current++
      setError(null)
      setActressBatch(progress)
      if (progress.status === 'idle' || progress.status === 'done' || progress.status === 'cancelled') {
        setActressBatchRecoverable(true)
        setActressBatchUnrecoverableReason(null)
      }
    })
    return () => {
      offVideo()
      offActress()
    }
  }, [])

  const value = useMemo<BatchScrapeContextValue>(
    () => ({
      refresh,
      loading,
      error,
      videoBatch,
      actressBatch,
      actressBatchRecoverable,
      actressBatchUnrecoverableReason,
      videoBatchActive: isBatchScrapeActive(videoBatch),
      actressBatchActive: isBatchScrapeActive(actressBatch),
      anyBatchActive: isBatchScrapeActive(videoBatch) || isBatchScrapeActive(actressBatch)
    }),
    [videoBatch, actressBatch, actressBatchRecoverable, actressBatchUnrecoverableReason, loading, error, refresh]
  )

  return <BatchScrapeContext.Provider value={value}>{children}</BatchScrapeContext.Provider>
}

export function useBatchScrapeActivity(): BatchScrapeContextValue {
  const context = useContext(BatchScrapeContext)
  if (!context) {
    throw new Error('useBatchScrapeActivity must be used within BatchScrapeProvider')
  }
  return context
}
