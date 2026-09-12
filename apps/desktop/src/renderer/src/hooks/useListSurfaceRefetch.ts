import { useEffect, useRef } from 'react'

/** When a list surface becomes visible again (detail closed), run a silent refetch. */
export function useListSurfaceRefetch(detailOpen: boolean, refetch: () => void): void {
  const wasDetailRef = useRef(false)

  useEffect(() => {
    if (wasDetailRef.current && !detailOpen) {
      refetch()
    }
    wasDetailRef.current = detailOpen
  }, [detailOpen, refetch])
}
