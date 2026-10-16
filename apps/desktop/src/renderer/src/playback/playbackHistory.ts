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
  function closeViewing(): void {
    expanded = null
    closeOptions()
    const current = state
    if (closingForNavigation || !current || current.presentation === 'docked') return
    command(current.sessionId, current.phase === 'error' ? { kind: 'stop' } : { kind: 'presentation', value: 'docked' })
  }
  return {
    /** true restores layer order, false is a new action, undefined retains the current order. */
    observe(value: PlaybackSnapshot | null, initial = false): boolean | undefined {
      const previous = state
      state = value
      const transition = previous?.sessionId !== value?.sessionId || previous?.presentation !== value?.presentation || previous?.phase !== value?.phase && value?.phase === 'error'
      if (initial) {
        if (value && value.presentation !== 'docked' && !expanded) expanded = history.adopt('playback-expanded', closeViewing)
        return true
      }
      if (!transition) return
      closeOptions()
      if (!value || value.presentation === 'docked') {
        if (expanded) history.close(expanded)
        return
      }
      // The native clock can beat the initial snapshot RPC after a reload.
      const restored = !expanded && previous === null ? history.adopt('playback-expanded', closeViewing) : null
      if (restored) expanded = restored
      // Fullscreen and settings share one viewing entry; system Back always docks.
      if (!expanded) expanded = history.open('playback-expanded', closeViewing)
      if (previous?.sessionId !== value.sessionId || previous?.presentation === 'docked') return Boolean(restored)
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
      closeOptions()
      expanded = null; state = null
    }
  }
}
