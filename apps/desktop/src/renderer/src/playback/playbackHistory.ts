import type { PlaybackControl, PlaybackSnapshot } from '@shared/desktop/playback'
import type { OverlayHistory } from '../interaction/overlayHistory'

/** Viewing history belongs to the stable app shell, not the decoder or a route. */
export function createPlaybackHistory(history: OverlayHistory, command: (id: string, value: PlaybackControl) => void, optionsChanged: (open: boolean) => void) {
  let state: PlaybackSnapshot | null = null
  let expanded: string | null = null
  let options = false
  let closingForNavigation = false
  function closeOptions(): void {
    if (!options) return
    options = false
    optionsChanged(false)
  }
  return {
    observe(value: PlaybackSnapshot | null, initial = false): void {
      const previous = state
      state = value
      const transition = previous?.sessionId !== value?.sessionId || previous?.presentation !== value?.presentation || previous?.phase !== value?.phase && value?.phase === 'error'
      if (!transition || initial) return
      closeOptions()
      if (!value || value.presentation === 'docked') {
        if (expanded) history.close(expanded)
        return
      }
      // Fullscreen and settings share one viewing entry; system Back always docks.
      if (!expanded) expanded = history.open('playback-expanded', () => {
        expanded = null
        closeOptions()
        const current = state
        if (closingForNavigation || !current || current.presentation === 'docked') return
        command(current.sessionId, current.phase === 'error' ? { kind: 'stop' } : { kind: 'presentation', value: 'docked' })
      })
    },
    setOptions(value: boolean): void {
      if (!value) { closeOptions(); return }
      if (options || !state || state.presentation === 'docked' || state.phase === 'error') return
      options = true
      optionsChanged(true)
    },
    /** Docking is acknowledged; consume layers even if its state event has not arrived. */
    closeForNavigation(): void {
      closingForNavigation = true
      try {
        closeOptions()
        if (expanded) history.close(expanded)
      } finally { closingForNavigation = false }
    },
    /** Effect cleanup can release ownership, but never back/push or control a session. */
    abandon(): void {
      if (expanded) history.abandon(expanded)
      options = false; expanded = null
    }
  }
}
