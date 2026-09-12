import { useCallback, useEffect, useRef, useState } from 'react'

export type AsyncMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false }

type ErrorReporter = (message: string) => void

export default function useAsyncMutation(reportError: ErrorReporter): {
  isBusy: (key: string) => boolean
  run: <T>(
    key: string,
    operation: () => Promise<T>,
    fallbackMessage: string
  ) => Promise<AsyncMutationResult<T>>
} {
  const activeKeysRef = useRef(new Set<string>())
  const mountedRef = useRef(true)
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const run = useCallback(async <T,>(
    key: string,
    operation: () => Promise<T>,
    fallbackMessage: string
  ): Promise<AsyncMutationResult<T>> => {
    if (activeKeysRef.current.has(key)) return { ok: false }

    activeKeysRef.current.add(key)
    setBusyKeys(new Set(activeKeysRef.current))
    try {
      return { ok: true, value: await operation() }
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error || fallbackMessage))
      return { ok: false }
    } finally {
      activeKeysRef.current.delete(key)
      if (mountedRef.current) setBusyKeys(new Set(activeKeysRef.current))
    }
  }, [reportError])

  const isBusy = useCallback((key: string) => busyKeys.has(key), [busyKeys])
  return { isBusy, run }
}
