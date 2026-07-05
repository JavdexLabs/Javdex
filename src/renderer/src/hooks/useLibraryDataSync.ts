import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useBatchScrapeActivity } from '../contexts/BatchScrapeContext'
import { useBatchProgressRefresh } from './useOverviewStatsBatchRefresh'
import { shouldRefetchLibraryOnRouteChange } from '../lib/librarySurfacePaths'
import {
  invalidateActressLibraryQueries,
  invalidateVideoLibraryQueries,
  refetchStaleLibraryQueries
} from '../query/invalidateLibraryQueries'

const BATCH_INVALIDATE_DEBOUNCE_MS = 1000

function useDebouncedLibraryInvalidation(
  invalidate: () => void,
  delayMs: number
): (phase: 'advance' | 'finish') => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const invalidateRef = useRef(invalidate)
  invalidateRef.current = invalidate

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return useCallback(
    (phase: 'advance' | 'finish') => {
      if (phase === 'finish') {
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        invalidateRef.current()
        return
      }

      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        invalidateRef.current()
      }, delayMs)
    },
    [delayMs]
  )
}

/**
 * Root-level sync: batch scrape IPC → invalidate library queries, and refetch stale
 * data when entering a list root from outside (Settings → Library, detail close → `/`).
 */
export function useLibraryDataSync(): void {
  const queryClient = useQueryClient()
  const location = useLocation()
  const previousPathnameRef = useRef<string | null>(null)
  const { videoBatch, actressBatch } = useBatchScrapeActivity()

  const syncVideoLibrary = useCallback(() => {
    invalidateVideoLibraryQueries(queryClient)
  }, [queryClient])

  const syncActressLibrary = useCallback(() => {
    invalidateActressLibraryQueries(queryClient)
  }, [queryClient])

  const handleVideoBatch = useDebouncedLibraryInvalidation(
    syncVideoLibrary,
    BATCH_INVALIDATE_DEBOUNCE_MS
  )
  const handleActressBatch = useDebouncedLibraryInvalidation(
    syncActressLibrary,
    BATCH_INVALIDATE_DEBOUNCE_MS
  )

  useBatchProgressRefresh(videoBatch, actressBatch, {
    onVideoBatch: handleVideoBatch,
    onActressBatch: handleActressBatch
  })

  useEffect(() => {
    const previousPathname = previousPathnameRef.current
    previousPathnameRef.current = location.pathname

    if (previousPathname === null) return
    if (!shouldRefetchLibraryOnRouteChange(previousPathname, location.pathname)) return

    refetchStaleLibraryQueries(queryClient)
  }, [location.pathname, queryClient])
}
