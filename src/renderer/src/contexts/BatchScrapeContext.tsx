import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import type { BatchProgress } from '@shared/types'
import { api } from '../api'
import { isBatchScrapeActive } from './batchScrapeActivity'

export type BatchScrapeContextValue = {
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
  const [videoBatch, setVideoBatch] = useState<BatchProgress | null>(null)
  const [actressBatch, setActressBatch] = useState<BatchProgress | null>(null)
  const [actressBatchRecoverable, setActressBatchRecoverable] = useState(true)
  const [actressBatchUnrecoverableReason, setActressBatchUnrecoverableReason] = useState<
    string | null
  >(null)

  useEffect(() => {
    api.batchScrape
      .getState()
      .then((state) => {
        if (!state.progress || state.progress.status === 'idle') return
        if (state.kind === 'video') setVideoBatch(state.progress)
        if (state.kind === 'actress') {
          setActressBatch(state.progress)
          setActressBatchRecoverable(state.recoverable)
          setActressBatchUnrecoverableReason(state.unrecoverableReason ?? null)
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const offVideo = api.scrape.onVideoBatchProgress((progress) => setVideoBatch(progress))
    const offActress = api.actressScrape.onBatchProgress((progress) => {
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
      videoBatch,
      actressBatch,
      actressBatchRecoverable,
      actressBatchUnrecoverableReason,
      videoBatchActive: isBatchScrapeActive(videoBatch),
      actressBatchActive: isBatchScrapeActive(actressBatch),
      anyBatchActive: isBatchScrapeActive(videoBatch) || isBatchScrapeActive(actressBatch)
    }),
    [videoBatch, actressBatch, actressBatchRecoverable, actressBatchUnrecoverableReason]
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
