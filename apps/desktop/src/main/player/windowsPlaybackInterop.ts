import { app } from 'electron'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { PLAYBACK_HOST_INITIALIZATION_TIMEOUT_MS } from './playbackHostPreload'

export interface WindowsPlaybackInterop {
  acquire(pointer: Buffer, pid: number): Buffer
  release(pointer: Buffer): void
}
interface PendingLoad {
  file: string
  promise: Promise<WindowsPlaybackInterop>
  claimed: boolean
  claim(): void
  cancel(reason: string): void
}
let cached: { file: string; api: WindowsPlaybackInterop } | undefined
let pending: PendingLoad | undefined
let retiring: Promise<void> | undefined

export function getWindowsPlaybackInterop(file: string): WindowsPlaybackInterop | undefined {
  return cached?.file === file ? cached.api : undefined
}

function retire(worker: Worker): void {
  // A native DLL load may still be returning on the worker. Don't wait on the
  // main thread or start another worker until this one has exited.
  const finished = worker.terminate().then(() => {}, () => {})
  // terminate() refs its exit handle; it must not pin the app event loop.
  worker.unref()
  retiring = finished
  void finished.then(() => { if (retiring === finished) retiring = undefined })
}

function load(file: string, claimed: boolean): Promise<WindowsPlaybackInterop> {
  const existing = getWindowsPlaybackInterop(file)
  if (existing) return Promise.resolve(existing)
  if (pending?.file === file) {
    if (claimed) pending.claim()
    return pending.promise
  }
  pending?.cancel('runtime-changed')
  let resolve!: (api: WindowsPlaybackInterop) => void, reject!: (error: Error) => void
  const promise = new Promise<WindowsPlaybackInterop>((yes, no) => { resolve = yes; reject = no })
  const started = performance.now()
  let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined, deadline = 0
  const expired = (): boolean => performance.now() >= deadline
  const arm = (): void => {
    clearTimeout(timer)
    deadline = performance.now() + PLAYBACK_HOST_INITIALIZATION_TIMEOUT_MS
    timer = setTimeout(() => entry.cancel('module-load-timeout'), PLAYBACK_HOST_INITIALIZATION_TIMEOUT_MS)
    timer.unref()
  }
  const settle = (): boolean => {
    if (pending !== entry) return false
    pending = undefined; clearTimeout(timer)
    if (worker) retire(worker)
    return true
  }
  const entry: PendingLoad = {
    file, promise, claimed,
    claim() { if (!entry.claimed) { entry.claimed = true; arm() } },
    cancel(reason) {
      if (!settle()) return
      if (reason !== 'cancelled') console.warn('[playback-interop-preload]', reason)
      reject(new Error(`Windows playback interop: ${reason}`))
    }
  }
  pending = entry; arm()
  const start = (): void => {
    if (pending !== entry) return
    if (expired()) { entry.cancel('module-load-timeout'); return }
    try {
      worker = new Worker(path.join(app.getAppPath(), 'out/main/playbackInteropWorker.js'), {
        workerData: file, execArgv: [], name: 'Javdex Playback Interop'
      })
      worker.on('error', () => entry.cancel('worker-load-failed'))
      worker.once('exit', () => entry.cancel('worker-exited'))
      worker.once('message', value => {
        if (pending !== entry) return
        if (expired()) { entry.cancel('module-load-timeout'); return }
        if (value !== 'ready') { entry.cancel('unexpected-worker-message'); return }
        try {
          // Same process, same DLL path: the worker still owns the mapped
          // image. Bind main's Node-API exports before retiring the worker.
          const bindStarted = performance.now()
          const api = createRequire(path.join(app.getAppPath(), 'package.json'))(file) as WindowsPlaybackInterop
          if (typeof api?.acquire !== 'function' || typeof api?.release !== 'function') throw new Error('Invalid interop exports')
          const mainBindMs = performance.now() - bindStarted
          if (expired()) { entry.cancel('module-load-timeout'); return }
          cached = { file, api }
          if (settle()) resolve(api)
          console.info('[playback-interop-preload]', 'ready', { elapsedMs: Math.round(performance.now() - started), mainBindMs })
        } catch { entry.cancel('main-binding-failed') }
      })
      worker.unref()
      console.info('[playback-interop-preload]', 'loading', { background: !entry.claimed })
    } catch { entry.cancel('worker-launch-failed') }
  }
  if (retiring) void retiring.then(start)
  else start()
  return promise
}

export function preloadWindowsPlaybackInterop(file: string): void {
  if (process.platform === 'win32') void load(file, false).catch(() => {})
}

export function loadWindowsPlaybackInterop(file: string): Promise<WindowsPlaybackInterop> {
  return load(file, true)
}

export function cancelWindowsPlaybackInteropPreload(): void {
  if (pending && !pending.claimed) pending.cancel('cancelled')
}

export function disposeWindowsPlaybackInterop(): void {
  pending?.cancel('cancelled')
}
