import { app, utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import type { HostResponse } from './playbackHostProtocol'

export const PLAYBACK_HOST_INITIALIZATION_TIMEOUT_MS = 60000
interface PreloadedHost {
  runtime: string
  mode: 'gpu' | 'cpu'
  child: UtilityProcess
  ready: boolean
  started: number
  detach(): void
}
let pending: PreloadedHost | undefined

export function disposePlaybackHostPreload(): void {
  const previous = pending
  pending = undefined
  if (!previous) return
  previous.detach()
  try { previous.child.kill() } catch { /* The idle child may have exited. */ }
}

/** Load the Windows addon and its DLLs only. No create command, interop module,
 * graphics discovery, media or display binding is involved. Retain one child. */
export function preloadPlaybackHost(runtime: string, mode: 'gpu' | 'cpu'): void {
  if (process.platform !== 'win32') return
  if (pending?.runtime === runtime && pending.mode === mode) return
  disposePlaybackHostPreload()
  const started = performance.now()
  try {
    const child = utilityProcess.fork(path.join(app.getAppPath(), 'out/main/playbackHost.js'),
      [runtime, mode, '', path.join(path.dirname(runtime), 'playback-interop.node')], { serviceName: 'Javdex Playback', stdio: 'pipe' })
    const timeout = setTimeout(() => failed('module-load-timeout'), PLAYBACK_HOST_INITIALIZATION_TIMEOUT_MS)
    timeout.unref()
    const host: PreloadedHost = { runtime, mode, child, ready: false, started, detach: () => {
      clearTimeout(timeout)
      child.off('message', message); child.off('exit', exited); child.off('error', error)
      child.stderr?.off('data', stderr)
    } }
    const failed = (reason: string): void => {
      if (pending !== host) return
      console.warn('[playback-preload]', mode, reason)
      disposePlaybackHostPreload()
    }
    const message = (value: HostResponse): void => {
      if (value?.type !== 'ready' || host.ready) { failed('unexpected-message'); return }
      if (performance.now() - started >= PLAYBACK_HOST_INITIALIZATION_TIMEOUT_MS) { failed('module-load-timeout'); return }
      host.ready = true; clearTimeout(timeout)
      console.info('[playback-preload]', mode, 'module-ready', { pid: child.pid, elapsedMs: Math.round(performance.now() - started) })
    }
    const exited = (code: number): void => {
      if (pending === host) { pending = undefined; host.detach(); console.warn('[playback-preload]', mode, 'process-exited', code) }
    }
    const error = (): void => failed('process-error')
    const stderr = (data: Buffer): void => console.warn('[playback-preload]', data.toString('utf8').slice(0, 2048))
    pending = host
    child.on('message', message); child.once('exit', exited); child.once('error', error); child.stderr?.on('data', stderr)
    console.info('[playback-preload]', mode, 'loading', { pid: child.pid })
  } catch { disposePlaybackHostPreload(); console.warn('[playback-preload]', mode, 'launch-failed') }
}

/** Handoff is synchronous: the caller installs its listeners before the next
 * IPC delivery. A child still loading is adopted too, without a second fork. */
export function takePreloadedPlaybackHost(runtime: string, mode: 'gpu' | 'cpu'): { child: UtilityProcess; ready: boolean } | undefined {
  const host = pending
  if (!host) return
  if (host.runtime !== runtime || host.mode !== mode || !host.ready && performance.now() - host.started >= PLAYBACK_HOST_INITIALIZATION_TIMEOUT_MS) {
    disposePlaybackHostPreload(); return
  }
  pending = undefined; host.detach()
  console.info('[playback-preload]', mode, 'adopted', { pid: host.child.pid, ready: host.ready })
  return { child: host.child, ready: host.ready }
}
