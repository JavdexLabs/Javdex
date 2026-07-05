import { useEffect, useRef } from 'react'
import type { BatchProgress } from '@shared/types'

export type BatchProgressPhase = 'advance' | 'finish'

function detectBatchProgressPhase(
  batch: BatchProgress,
  prev: { current: number; status: BatchProgress['status'] } | null
): BatchProgressPhase | null {
  const finished =
    prev != null &&
    prev.status !== 'idle' &&
    (batch.status === 'idle' || batch.status === 'done' || batch.status === 'cancelled')
  if (finished) return 'finish'

  const advanced =
    batch.status !== 'idle' &&
    (prev?.current !== batch.current || prev?.status !== batch.status)
  if (advanced) return 'advance'

  return null
}

export type BatchProgressRefreshHandlers = {
  onVideoBatch?: (phase: BatchProgressPhase) => void
  onActressBatch?: (phase: BatchProgressPhase) => void
}

/** Run handlers when batch scrape advances or finishes. */
export function useBatchProgressRefresh(
  videoBatch: BatchProgress | null,
  actressBatch: BatchProgress | null,
  handlers: BatchProgressRefreshHandlers
): void {
  const videoProgressRef = useRef<{ current: number; status: BatchProgress['status'] } | null>(null)
  const actressProgressRef = useRef<{ current: number; status: BatchProgress['status'] } | null>(
    null
  )

  useEffect(() => {
    if (!videoBatch) return
    const prev = videoProgressRef.current
    const phase = detectBatchProgressPhase(videoBatch, prev)
    videoProgressRef.current = { current: videoBatch.current, status: videoBatch.status }
    if (phase) handlers.onVideoBatch?.(phase)
  }, [videoBatch?.current, videoBatch?.status, handlers.onVideoBatch])

  useEffect(() => {
    if (!actressBatch) return
    const prev = actressProgressRef.current
    const phase = detectBatchProgressPhase(actressBatch, prev)
    actressProgressRef.current = { current: actressBatch.current, status: actressBatch.status }
    if (phase) handlers.onActressBatch?.(phase)
  }, [actressBatch?.current, actressBatch?.status, handlers.onActressBatch])
}

/** Refresh overview counters while batch scrape advances or finishes. */
export function useOverviewStatsBatchRefresh(
  videoBatch: BatchProgress | null,
  actressBatch: BatchProgress | null,
  refresh: () => void
): void {
  useBatchProgressRefresh(videoBatch, actressBatch, {
    onVideoBatch: () => refresh(),
    onActressBatch: () => refresh()
  })
}
