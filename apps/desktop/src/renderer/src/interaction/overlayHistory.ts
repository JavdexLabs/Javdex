export type OverlayHistoryKind = 'image-preview' | 'playback-expanded' | 'playback-fullscreen' | 'playback-options'
export type OverlayCloseSource = 'history' | 'action' | 'route'
export const OVERLAY_HISTORY_KEY = 'avOverlay'
const OVERLAY_PARENTS_KEY = 'avOverlayParents'
export const IMAGE_PREVIEW_HISTORY_KEY = 'avImagePreview'
export interface OverlayHistoryMarker { token: string; kind: OverlayHistoryKind }
export interface OverlayHistoryPort {
  read(): { state: unknown; url: string }
  push(state: Record<string, unknown>, url: string): void
  replace(state: Record<string, unknown>, url: string): void
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
function readHistoryTrail(state: unknown): OverlayHistoryMarker[] {
  const current = readOverlayHistoryMarker(state)
  if (!current) return []
  const parents = (state as Record<string, unknown>)[OVERLAY_PARENTS_KEY]
  if (!Array.isArray(parents) || parents.length > 64) return [current]
  const trail: OverlayHistoryMarker[] = []
  const tokens = new Set([current.token])
  for (const value of parents) {
    const marker = readOverlayHistoryMarker({ [OVERLAY_HISTORY_KEY]: value })
    if (!marker || tokens.has(marker.token)) return [current]
    tokens.add(marker.token); trail.push(marker)
  }
  return [...trail, current]
}
export function withOverlayHistoryMarker(state: unknown, marker: OverlayHistoryMarker, parents: OverlayHistoryMarker[] = []): Record<string, unknown> {
  const next = { ...(state && typeof state === 'object' ? state : {}) } as Record<string, unknown>
  delete next[OVERLAY_HISTORY_KEY]
  delete next[IMAGE_PREVIEW_HISTORY_KEY]
  delete next[OVERLAY_PARENTS_KEY]
  const value = { kind: marker.kind, token: marker.token }
  next[OVERLAY_HISTORY_KEY] = value
  if (parents.length) next[OVERLAY_PARENTS_KEY] = parents.map(({ kind, token }) => ({ kind, token }))
  // Keep the existing image marker readable without carrying it into unrelated layers.
  if (marker.kind === 'image-preview') next[IMAGE_PREVIEW_HISTORY_KEY] = value
  return next
}
interface Entry extends OverlayHistoryMarker {
  url: string
  pushed: boolean
  closing: boolean
  close?: (source: OverlayCloseSource) => void
}

/** One writer for temporary viewing layers. No React lifetime owns a traversal. */
export function createOverlayHistory(port: OverlayHistoryPort) {
  let entries: Entry[] = []
  let pending: { from: string; cancelFallback: () => void } | null = null
  const settled = new Set<() => void>()
  function recordPositions(current: ReturnType<OverlayHistoryPort['read']>): void {
    let next: Entry | undefined
    for (const position of readHistoryTrail(current.state).reverse()) {
      let entry = entries.find(value => value.token === position.token && value.url === current.url)
      if (!entry) {
        entry = { ...position, url: current.url, pushed: true, closing: false }
        entries.splice(next ? entries.indexOf(next) : entries.length, 0, entry)
      }
      next = entry
    }
  }
  function finish(entry: Entry, source: OverlayCloseSource): void {
    if (entry.closing) return
    entry.closing = true
    entry.close?.(source)
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
        const marker = readOverlayHistoryMarker(current.state)
        const occupied = marker && entries.some(value => value.pushed && value.close && value.token === marker.token && value.url === current.url)
        const parents = readHistoryTrail(current.state)
        // Forward may revisit a consumed viewing entry. Reuse that empty slot
        // instead of stacking a second placeholder above the business route.
        if (marker && !occupied) {
          entries = entries.filter(value => value.token !== marker.token)
          port.replace(withOverlayHistoryMarker(current.state, entry, parents.slice(0, -1)), current.url)
        } else port.push(withOverlayHistoryMarker(current.state, entry, parents), current.url)
        entry.pushed = true
      }
    }
    for (const action of [...settled]) {
      if (pending) break
      settled.delete(action); action()
    }
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
    // A reload may leave empty child positions above the restored visible view.
    // Consume those positions and that view as one user Back, never on mount.
    const exposed = pushed[index]
    let emptyParent = index
    if (removed.length && removed.every(entry => !entry.close) && exposed?.close && !exposed.closing) {
      finish(exposed, 'history')
      emptyParent--
    }
    // Reload and Forward may also leave an anonymous parent below the view.
    // Drain it only after a real close, stopping at the next live owner.
    if (removed.length) for (; emptyParent >= 0 && !pushed[emptyParent].close; emptyParent--) pushed[emptyParent].closing = true
    flush()
  }
  return {
    open(kind: OverlayHistoryKind, close: NonNullable<Entry['close']>): string {
      const token = port.token()
      const current = port.read()
      if (!pending) recordPositions(current)
      entries.push({ token, kind, close, pushed: false, closing: false, url: current.url })
      // An old asynchronous back must settle before a new marker is pushed.
      flush()
      return token
    },
    /** Reclaim a recorded position, including a parent beneath another view. */
    adopt(kind: OverlayHistoryKind, close: NonNullable<Entry['close']>): string | null {
      const current = port.read()
      const marker = readOverlayHistoryMarker(current.state)
      if (!marker) return null
      // Read persisted positions only when restoring a view. Retain any live
      // callbacks registered before the initial snapshot RPC completed.
      recordPositions(current)
      const cursor = entries.findIndex(entry => entry.token === marker.token && entry.url === current.url)
      const recorded = entries.slice(0, cursor + 1).reverse().find(entry => entry.kind === kind && entry.url === current.url)
      if (recorded) {
        // A closing child does not invalidate a surviving parent's ownership.
        // The closing entry itself remains unavailable until its traversal settles.
        if (recorded.close || recorded.closing) return null
        recorded.close = close
        return recorded.token
      }
      if (marker.kind !== kind) return null
      entries.push({ ...marker, close, url: current.url, pushed: true, closing: false })
      return marker.token
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
    abandon(token: string): void {
      const entry = entries.find(entry => entry.token === token)
      if (entry?.pushed) entry.close = undefined
      else entries = entries.filter(entry => entry.token !== token)
    },
    route(): void {
      const removed = entries.filter(entry => entry.url !== port.read().url)
      entries = entries.filter(entry => !removed.includes(entry))
      for (const entry of removed.reverse()) finish(entry, 'route')
    }
  }
}
export type OverlayHistory = ReturnType<typeof createOverlayHistory>
