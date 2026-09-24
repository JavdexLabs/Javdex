import { useCallback, useEffect, useRef, useState } from 'react'

export interface LatestAsyncLabelController {
  label: string
  refresh: (load: () => Promise<number>, format: (value: number) => string) => Promise<void>
  reset: () => void
}

export default function useLatestAsyncLabel(fallback: string): LatestAsyncLabelController {
  const [label, setLabel] = useState(fallback)
  const requestIdRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestIdRef.current += 1
    }
  }, [])

  const refresh = useCallback(async (
    load: () => Promise<number>,
    format: (value: number) => string
  ): Promise<void> => {
    const requestId = ++requestIdRef.current
    setLabel(fallback)
    try {
      const value = await load()
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLabel(format(value))
      }
    } catch {
      if (mountedRef.current && requestId === requestIdRef.current) setLabel(fallback)
    }
  }, [fallback])

  const reset = useCallback(() => {
    requestIdRef.current += 1
    setLabel(fallback)
  }, [fallback])

  return { label, refresh, reset }
}
