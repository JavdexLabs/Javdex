import { useEffect, useRef } from 'react'

/**
 * Runs `dismiss` when the navigation `signal` changes (e.g. location.pathname).
 * Skips the initial mount so overlays are not cleared on first render.
 */
export function useDismissOverlaysOnNavigate(
  dismiss: () => void,
  signal: unknown
): void {
  const isInitialMount = useRef(true)

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false
      return
    }
    dismiss()
  }, [dismiss, signal])
}
