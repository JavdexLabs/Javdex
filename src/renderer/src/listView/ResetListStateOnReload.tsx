import { useEffect } from 'react'
import { clearAllListViewMemory } from './listViewMemory'

/**
 * Scroll snapshots are session-only. A full reload clears measurements while the
 * URL remains authoritative for the current list, filters, and detail stack.
 */
export default function ResetListStateOnReload(): null {
  useEffect(() => {
    const entry = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined
    if (entry?.type !== 'reload') return

    clearAllListViewMemory()
  }, [])

  return null
}
