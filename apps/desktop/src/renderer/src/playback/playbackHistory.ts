import type { PlaybackControl, PlaybackSnapshot } from '@shared/desktop/playback'
import type { OverlayHistory } from '../interaction/overlayHistory'

/** Viewing history belongs to the stable app shell, not the decoder or a route. */
export function createPlaybackHistory(history: OverlayHistory, command: (id: string, value: PlaybackControl) => void, optionsChanged: (open: boolean) => void) {
  let state: PlaybackSnapshot | null = null
  let expanded: string | null = null, fullscreen: string | null = null, options: string | null = null
  function closeOptions(): void {
    if (options) history.close(options)
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
      if (value.presentation !== 'fullscreen' && fullscreen) history.close(fullscreen)
      if (!expanded) expanded = history.open('playback-expanded', () => {
        expanded = null
        const current = state
        if (!current || current.presentation === 'docked') return
        command(current.sessionId, current.phase === 'error' ? { kind: 'stop' } : { kind: 'presentation', value: 'docked' })
      })
      if (value.presentation === 'fullscreen' && !fullscreen) fullscreen = history.open('playback-fullscreen', () => {
        fullscreen = null
        if (state?.presentation === 'fullscreen') command(state.sessionId, { kind: 'presentation', value: 'expanded' })
      })
    },
    setOptions(value: boolean): void {
      if (!value) { closeOptions(); return }
      if (options || !state || state.presentation !== 'expanded' || state.phase === 'error') return
      options = history.open('playback-options', () => { options = null; optionsChanged(false) })
      optionsChanged(true)
    },
    /** Effect cleanup can release ownership, but never back/push or control a session. */
    abandon(): void {
      for (const token of [options, fullscreen, expanded]) if (token) history.abandon(token)
      options = null; fullscreen = null; expanded = null
    }
  }
}
