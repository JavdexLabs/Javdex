import { useCallback, useEffect, useRef } from 'react'
import { fallbackPointerTiming, type PointerTiming } from '@shared/desktop/input'
import type { PlaybackSnapshot } from '@shared/desktop/playback'
import { api } from '../api'

interface PendingClick { action: () => void; timer: number | null }

/** Owns gesture ambiguity only; command dispatch and playback state stay in the panel. */
export function usePlaybackPointerGestures(state: Pick<PlaybackSnapshot, 'sessionId' | 'sharedTextureSurface' | 'presentation' | 'phase'> | null) {
  const pending = useRef<PendingClick | null>(null)
  const timing = useRef<Promise<PointerTiming>>(Promise.resolve(fallbackPointerTiming))
  const cancel = useCallback(() => {
    if (pending.current?.timer != null) window.clearTimeout(pending.current.timer)
    pending.current = null
  }, [])
  const flush = useCallback(() => {
    const action = pending.current?.action
    cancel()
    action?.()
  }, [cancel])
  useEffect(() => {
    const refresh = (): void => {
      timing.current = api.desktop.pointerTiming().catch(() => fallbackPointerTiming)
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  const failed = state?.phase === 'error'
  useEffect(() => cancel, [state?.sessionId, state?.sharedTextureSurface, state?.presentation, failed, cancel])

  const onMouseDown = useCallback((event: { button: number; detail: number }): void => {
    if (event.button !== 0) return
    // Chromium knows the count on press, including a held second press. A new
    // independent press confirms the previous single rather than dropping it.
    if (event.detail === 1) flush()
    else if (event.detail > 1) cancel()
  }, [cancel, flush])
  const click = useCallback((detail: number, delayed: boolean, action: () => void): void => {
    if (detail === 1) flush()
    else cancel()
    if (!delayed || detail === 0) { action(); return }
    if (detail !== 1) return
    const current: PendingClick = { action, timer: null }
    pending.current = current
    const started = performance.now()
    // Wait for the platform response even on the first click. A cancellation
    // while it is in flight must not schedule a stale timer when it completes.
    void timing.current.then(({ doubleClickMs }) => {
      if (pending.current !== current) return
      const delay = Math.max(0, doubleClickMs + 50 - (performance.now() - started))
      current.timer = window.setTimeout(() => {
        if (pending.current === current) flush()
      }, delay)
    })
  }, [cancel, flush])
  return { cancel, onMouseDown, click }
}
