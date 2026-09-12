import type { ActressFaceScanCache } from './cache'

interface ActressFaceScanSession {
  cache: ActressFaceScanCache
  needsScan: boolean
  running: boolean
  cancelRequested: boolean
  runSequence: number
  revision: number
}

const session: ActressFaceScanSession = {
  cache: new Map(),
  needsScan: true,
  running: false,
  cancelRequested: false,
  runSequence: 0,
  revision: 0
}

const listeners = new Set<() => void>()

export function getActressFaceScanSession(): Readonly<ActressFaceScanSession> {
  return session
}

export function updateActressFaceScanSession(
  patch: Partial<
    Pick<ActressFaceScanSession, 'needsScan' | 'running' | 'cancelRequested' | 'runSequence'>
  >
): void {
  let changed = false
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    const value = patch[key]
    if (value !== undefined && session[key] !== value) {
      Object.assign(session, { [key]: value })
      changed = true
    }
  }
  if (!changed) return
  session.revision += 1
  listeners.forEach((listener) => listener())
}

export function subscribeActressFaceScanSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getActressFaceScanSessionRevision(): number {
  return session.revision
}

/** @internal test helper */
export function resetActressFaceScanSession(): void {
  session.cache.clear()
  session.needsScan = true
  session.running = false
  session.cancelRequested = false
  session.runSequence = 0
  session.revision += 1
  listeners.forEach((listener) => listener())
}
