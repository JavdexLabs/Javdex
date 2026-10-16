import type { PlaybackControl, PlaybackSnapshot, PlaybackObservation } from '@shared/desktop/playback'
import type { OverlayHistory } from '../interaction/overlayHistory'

export interface PlaybackViewState {
  snapshot: PlaybackSnapshot | null
  activation: { key: string; restoring: boolean } | null
}
interface PlaybackStateSource {
  observation(): Promise<PlaybackObservation>
  onChanged(listener: (value: PlaybackSnapshot | null, revision: number) => void): () => void
}

/** Viewing history belongs to the stable app shell, not the decoder or a route. */
export function createPlaybackHistory(history: OverlayHistory, command: (id: string, value: PlaybackControl) => void, optionsChanged: (open: boolean) => void) {
  let state: PlaybackSnapshot | null = null
  let expanded: string | null = null
  let receivedInitial = false
  let options = false
  let closingForNavigation = false
  let activation: PlaybackViewState['activation'] = null
  let disconnect: (() => void) | null = null
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
  /** true restores layer order, false is a new action, undefined retains the current order. */
  function observe(value: PlaybackSnapshot | null, initial = false): boolean | undefined {
    const previous = state
    state = value
    const transition = previous?.sessionId !== value?.sessionId || previous?.presentation !== value?.presentation || previous?.phase !== value?.phase && value?.phase === 'error'
    if (initial) {
      receivedInitial = true
      if (expanded && (!value || value.presentation === 'docked')) {
        history.abandon(expanded)
        expanded = null
      }
      if (value && value.presentation !== 'docked' && !expanded) expanded = history.adopt('playback-expanded', closeViewing)
      return true
    }
    if (!transition) return
    closeOptions()
    if (!value || value.presentation === 'docked') {
      if (expanded) history.close(expanded)
      return
    }
    if (expanded && previous && previous.sessionId !== value.sessionId) {
      history.abandon(expanded)
      expanded = null
    }
    // Only an event without a mount baseline may be a surviving first clock.
    const restored = !expanded && previous === null && !receivedInitial ? history.adopt('playback-expanded', closeViewing) : null
    if (restored) expanded = restored
    // Fullscreen and settings share one viewing entry; system Back always docks.
    if (!expanded) expanded = history.open('playback-expanded', closeViewing)
    if (previous?.sessionId !== value.sessionId || previous?.presentation === 'docked') return Boolean(restored)
  }
  function update(value: PlaybackSnapshot | null, initial = false): void {
    const restoring = observe(value, initial)
    if (!value || value.presentation === 'docked') activation = null
    else if (restoring !== undefined || !activation) {
      activation = { key: expanded ?? value.sessionId, restoring: restoring ?? true }
    }
  }
  function abandon(): void {
    if (expanded) history.abandon(expanded)
    closeOptions()
    expanded = null; state = null; receivedInitial = false; activation = null
  }
  return {
    observe: update,
    view: (): PlaybackViewState => ({ snapshot: state, activation }),
    /** Reconcile the initial RPC and live notifications in the same owner as the viewing token. */
    connect(source: PlaybackStateSource, changed: (value: PlaybackViewState) => void): () => void {
      disconnect?.()
      let disposed = false
      let initialized = false
      let snapshotFailed = false
      let appliedRevision = -1
      const notifications: PlaybackObservation[] = []
      const publish = (value: PlaybackSnapshot | null, initial = false): void => {
        update(value, initial)
        changed({ snapshot: state, activation })
      }
      const initialize = (value: PlaybackObservation): void => {
        publish(value.snapshot, true)
        appliedRevision = value.revision
        initialized = true
        for (const notification of notifications) {
          if (notification.revision <= appliedRevision) continue
          publish(notification.snapshot)
          appliedRevision = notification.revision
        }
        notifications.length = 0
      }
      const off = source.onChanged((value, revision) => {
        if (disposed) return
        if (initialized) {
          if (revision <= appliedRevision) return
          publish(value)
          appliedRevision = revision
        }
        else {
          const previous = notifications.at(-1)
          if (previous && revision <= previous.revision) return
          const notification = { snapshot: value, revision }
          // Compact clock updates, retaining every session/presentation transition.
          if (previous && previous.snapshot?.sessionId === value?.sessionId
            && previous.snapshot?.presentation === value?.presentation && previous.snapshot?.phase === value?.phase) notifications[notifications.length - 1] = notification
          else notifications.push(notification)
          // A provisional clock can reclaim a surviving marker, but cannot invent one.
          publish(value, true)
          if (snapshotFailed) initialize(notification)
        }
      })
      void source.observation().then(value => {
        if (!disposed) initialize(value)
      }, () => {
        if (disposed) return
        snapshotFailed = true
        if (notifications.length) initialize(notifications[0])
      })
      const dispose = (): void => {
        if (disposed) return
        disposed = true
        off()
        notifications.length = 0
        if (disconnect === dispose) { disconnect = null; abandon() }
      }
      disconnect = dispose
      return dispose
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
    abandon: () => { if (disconnect) disconnect(); else abandon() }
  }
}
