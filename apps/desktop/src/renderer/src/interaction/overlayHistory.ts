export type OverlayHistoryKind = 'image-preview' | 'playback-expanded' | 'playback-fullscreen' | 'playback-options'
export type OverlayCloseSource = 'history' | 'action' | 'route'
export const OVERLAY_HISTORY_KEY = 'avOverlay'
export const IMAGE_PREVIEW_HISTORY_KEY = 'avImagePreview'
export interface OverlayHistoryMarker { token: string; kind: OverlayHistoryKind }
export interface OverlayHistoryPort {
  read(): { state: unknown; url: string }
  push(state: Record<string, unknown>, url: string): void
  go(delta: number): void
  later(callback: () => void): () => void
  token(): string
}
const kinds: OverlayHistoryKind[] = ['image-preview', 'playback-expanded', 'playback-fullscreen', 'playback-options']
export function readOverlayHistoryMarker(state: unknown): OverlayHistoryMarker | null {
  if (!state || typeof state !== 'object') return null
  const record = state as Record<string, unknown>
  const value = record[OVERLAY_HISTORY_KEY] ?? record[IMAGE_PREVIEW_HISTORY_KEY]
  if (!value || typeof value !== 'object') return null
  const marker = value as Record<string, unknown>
  return typeof marker.token === 'string' && kinds.includes(marker.kind as OverlayHistoryKind)
    ? { token: marker.token, kind: marker.kind as OverlayHistoryKind } : null
}
export function withOverlayHistoryMarker(state: unknown, marker: OverlayHistoryMarker): Record<string, unknown> {
  const next = { ...(state && typeof state === 'object' ? state : {}) } as Record<string, unknown>
  delete next[OVERLAY_HISTORY_KEY]
  delete next[IMAGE_PREVIEW_HISTORY_KEY]
  const value = { kind: marker.kind, token: marker.token }
  next[OVERLAY_HISTORY_KEY] = value
  // Keep the existing image marker readable without carrying it into unrelated layers.
  if (marker.kind === 'image-preview') next[IMAGE_PREVIEW_HISTORY_KEY] = value
  return next
}
interface Entry extends OverlayHistoryMarker {
  url: string
  pushed: boolean
  closing: boolean
  close(source: OverlayCloseSource): void
}

/** One writer for temporary viewing layers. No React lifetime owns a traversal. */
export function createOverlayHistory(port: OverlayHistoryPort) {
  let entries: Entry[] = []
  let pending: { from: string; cancelFallback: () => void } | null = null
  const settled = new Set<() => void>()
  function finish(entry: Entry, source: OverlayCloseSource): void {
    if (entry.closing) return
    entry.closing = true
    entry.close(source)
  }
  function flush(): void {
    if (pending) return
    const pushed = entries.filter(entry => entry.pushed)
    const top = pushed.at(-1)
    if (top?.closing && readOverlayHistoryMarker(port.read().state)?.token === top.token) {
      let count = 0
      for (const entry of [...pushed].reverse()) { if (!entry.closing) break; count++ }
      pending = { from: top.token, cancelFallback: () => {} }
      pending.cancelFallback = port.later(() => {
        if (pending && readOverlayHistoryMarker(port.read().state)?.token !== pending.from) pop(port.read().state)
      })
      port.go(-count)
      return
    }
    entries = entries.filter(entry => !entry.closing)
    for (const entry of [...entries]) {
      if (entry.pushed) continue
      const current = port.read()
      if (entry.url !== current.url) {
        entries = entries.filter(value => value !== entry)
        finish(entry, 'route')
      } else {
        port.push(withOverlayHistoryMarker(current.state, entry), current.url)
        entry.pushed = true
      }
    }
    if (!pending) for (const action of [...settled]) { settled.delete(action); action() }
  }
  function pop(state: unknown): void {
    const marker = readOverlayHistoryMarker(state)
    const cursor = readOverlayHistoryMarker(port.read().state)
    // A fallback may already have settled this event and pushed the next layer.
    // Only the current cursor can acknowledge a traversal or close live layers.
    if (marker?.token !== cursor?.token || marker?.kind !== cursor?.kind) return
    if (pending) {
      if (marker?.token === pending.from) return
      pending.cancelFallback()
      pending = null
    }
    const pushed = entries.filter(entry => entry.pushed)
    const index = pushed.findIndex(entry => entry.token === marker?.token)
    const removed = pushed.slice(index + 1)
    entries = entries.filter(entry => !removed.includes(entry))
    for (const entry of removed.reverse()) finish(entry, 'history')
    flush()
  }
  return {
    open(kind: OverlayHistoryKind, close: Entry['close']): string {
      const token = port.token()
      entries.push({ token, kind, close, pushed: false, closing: false, url: port.read().url })
      // An old asynchronous back must settle before a new marker is pushed.
      flush()
      return token
    },
    close(token: string): void {
      const index = entries.findIndex(entry => entry.token === token)
      if (index < 0) return
      const removed = entries.slice(index)
      for (const entry of removed.reverse()) finish(entry, 'action')
      flush()
    },
    pop,
    isTraversing: (): boolean => pending !== null,
    afterTraversal(action: () => void): () => void {
      if (pending) settled.add(action)
      else action()
      return () => { settled.delete(action) }
    },
    /** Route/lifetime abandonment never navigates or invokes an obsolete callback. */
    abandon(token: string): void { entries = entries.filter(entry => entry.token !== token) },
    route(): void {
      const removed = entries.filter(entry => entry.url !== port.read().url)
      entries = entries.filter(entry => !removed.includes(entry))
      for (const entry of removed.reverse()) finish(entry, 'route')
    }
  }
}
export type OverlayHistory = ReturnType<typeof createOverlayHistory>
