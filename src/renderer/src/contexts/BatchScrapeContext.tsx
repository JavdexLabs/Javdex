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

export type BatchScrapeContextValue = {
  videoBatch: BatchProgress | null
  actressBatch: BatchProgress | null
  videoBatchActive: boolean
  actressBatchActive: boolean
  anyBatchActive: boolean
}

const BatchScrapeContext = createContext<BatchScrapeContextValue | null>(null)

function isActive(batch: BatchProgress | null): boolean {
  return Boolean(batch && batch.status !== 'idle')
}

export function BatchScrapeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [videoBatch, setVideoBatch] = useState<BatchProgress | null>(null)
  const [actressBatch, setActressBatch] = useState<BatchProgress | null>(null)

  useEffect(() => {
    api.batchScrape
      .getState()
      .then((state) => {
        if (!state.progress || state.progress.status === 'idle') return
        if (state.kind === 'video') setVideoBatch(state.progress)
        if (state.kind === 'actress') setActressBatch(state.progress)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const offVideo = api.scrape.onVideoBatchProgress((progress) => setVideoBatch(progress))
    const offActress = api.actressScrape.onBatchProgress((progress) => setActressBatch(progress))
    return () => {
      offVideo()
      offActress()
    }
  }, [])

  const value = useMemo<BatchScrapeContextValue>(
    () => ({
      videoBatch,
      actressBatch,
      videoBatchActive: isActive(videoBatch),
      actressBatchActive: isActive(actressBatch),
      anyBatchActive: isActive(videoBatch) || isActive(actressBatch)
    }),
    [videoBatch, actressBatch]
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
