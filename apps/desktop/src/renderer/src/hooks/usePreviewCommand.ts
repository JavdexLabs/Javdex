import { useCallback, useEffect, useRef, useState } from 'react'

interface PreviewCommandOptions<TImpact, TResult> {
  loadImpact: () => Promise<TImpact>
  command: () => Promise<TResult>
  canExecute?: (impact: TImpact) => boolean
  onCompleted: (result: TResult) => void | Promise<void>
  completionErrorMessage: string
}

export function usePreviewCommand<TImpact, TResult>({
  loadImpact,
  command,
  canExecute = () => true,
  onCompleted,
  completionErrorMessage
}: PreviewCommandOptions<TImpact, TResult>): {
  impact: TImpact | null
  error: string | null
  running: boolean
  execute: () => Promise<void>
} {
  const [impact, setImpact] = useState<TImpact | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const requestSequence = useRef(0)

  const refreshImpact = useCallback(
    async (clearError = true): Promise<void> => {
      const sequence = requestSequence.current + 1
      requestSequence.current = sequence
      setImpact(null)
      if (clearError) setError(null)
      try {
        const nextImpact = await loadImpact()
        if (requestSequence.current === sequence) setImpact(nextImpact)
      } catch (loadError) {
        if (requestSequence.current === sequence) {
          setError(String((loadError as Error).message ?? loadError))
        }
      }
    },
    [loadImpact]
  )

  useEffect(() => {
    void refreshImpact()
    return () => {
      requestSequence.current += 1
    }
  }, [refreshImpact])

  const execute = async (): Promise<void> => {
    if (!impact || running || !canExecute(impact)) return
    setRunning(true)
    setError(null)
    let result: TResult
    try {
      result = await command()
    } catch (commandError) {
      setError(String((commandError as Error).message ?? commandError))
      await refreshImpact(false)
      setRunning(false)
      return
    }
    setRunning(false)
    try {
      await onCompleted(result)
    } catch (completionError) {
      console.error(completionErrorMessage, completionError)
    }
  }

  return { impact, error, running, execute }
}
