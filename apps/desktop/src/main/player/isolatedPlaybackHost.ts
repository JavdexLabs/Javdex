import { app, utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { channel as diagnosticsChannel } from 'node:diagnostics_channel'
import type { HostBounds, HostFrame, HostRequest, HostResponse } from './playbackHostProtocol'
import type { NativePlaybackState } from './nativePlayback'
import { graphicsPlaybackFailure } from './playbackGraphicsFailure'

interface Interop {
  acquire?(pointer: Buffer, pid: number): Buffer
  acquireSurface?(channel: string, sequence: number): Buffer
  createChannel?(channel: string): void
  closeChannel?(channel: string): void
  release(pointer: Buffer): void
}
interface Resource { id: number; slot: number; pointer: Buffer; frames: number; retired: boolean }
/** Main-owned proxy. The only native library here duplicates/imports OS
 * resources; it cannot decode, create a graphics context or render a frame. */
export function createIsolatedPlaybackHost(runtime: string, mode: 'gpu' | 'cpu') {
  let child: UtilityProcess | null = null, ready = false, stopped = true
  let failure: Error | undefined, state: NativePlaybackState = { alive: false }
  let wakeup: (() => void) | null = null, heartbeat: ReturnType<typeof setInterval> | undefined
  let lastHeartbeat = 0, channel = '', interop: Interop | undefined
  let lastSequence = 0, requestsPending = 0
  const queued: HostRequest[] = [], frames: HostFrame[] = []
  // A resource can outlive its producer. This map is captured by that bridge's
  // release callbacks and never recycled by a later playback-host generation.
  const resources = new Map<number, Resource>()
  const cache = new Map<number, Resource>(), slots = new Map<number, Resource>()
  const dispose = (resource: Resource): void => {
    if (resource.frames || !resource.retired) return
    cache.delete(resource.id); interop!.release(resource.pointer)
  }
  const statistics = diagnosticsChannel('javdex.playback.host.statistics')
  const controls = diagnosticsChannel('javdex.playback.host.control')
  const report = (value: unknown): void => {
    if (value && typeof value === 'object') {
      try { Object.assign(value, { [mode]: { ...state, pid: child?.pid,
        outstandingSurfaces: resources.size, queuedFrames: frames.length } }) } catch { /* Read-only diagnostics. */ }
    }
  }
  const control = (value: unknown): void => {
    const request = value as { mode?: string; operation?: string } | null
    if (request?.mode !== mode || !child || stopped) return
    if (request.operation === 'kill') child.kill()
    if (request.operation === 'stall') child.postMessage({ type: 'stall' })
  }
  const unsubscribe = (): void => {
    if (!stopped || resources.size) return
    statistics.unsubscribe(report); controls.unsubscribe(control)
  }
  const post = (message: HostRequest): void => {
    if (failure) throw failure
    if (stopped || !child) throw new Error('播放进程未启动')
    const abort = (code: string): never => { fail(code); throw failure }
    if (ready) {
      if (requestsPending >= 64) abort('HELPER_HEARTBEAT_TIMEOUT')
      try { child.postMessage(message); requestsPending++ } catch { abort('FRAME_CHANNEL_FAILED') }
    }
    else {
      if (queued.length >= 64) abort('HELPER_HEARTBEAT_TIMEOUT')
      queued.push(message)
    }
  }
  const releaseFrame = (sequence: number): void => {
    const resource = resources.get(sequence)
    if (resource) { resources.delete(sequence); resource.frames--; dispose(resource) }
    if (!stopped && child && !failure) post({ type: 'release', sequence })
    unsubscribe()
  }
  const discard = (): void => { for (const frame of frames.splice(0)) releaseFrame(frame.sequence) }
  const destroy = (): void => {
    if (stopped) return
    stopped = true; clearInterval(heartbeat)
    const previous = child; child = null
    try {
      discard()
      for (const resource of cache.values()) { resource.retired = true; dispose(resource) }
      slots.clear()
      if (channel) { interop?.closeChannel?.(channel); channel = '' }
    } finally {
      // Interop cleanup may fail after a driver crash. It must not leave a
      // native child alive or delay independent CPU recovery.
      queued.length = 0; state = { alive: false }; wakeup = null
      unsubscribe()
      if (previous) {
        try { if (ready) previous.postMessage({ type: 'destroy' } satisfies HostRequest) } catch { /* The child may already have exited. */ }
        const timer = setTimeout(() => previous.kill(), 1000); timer.unref()
        previous.once('exit', () => clearTimeout(timer))
      }
    }
  }
  const fail = (code: string): void => {
    if (stopped) return
    const callback = wakeup
    console.warn('[playback-host-failure]', mode, code)
    // Consumer-held imports remain in resources until final release. Cleanup
    // cannot erase the original fault or throw out of an IPC/timer callback.
    failure = mode === 'gpu' ? graphicsPlaybackFailure(code) : new Error('CPU 播放进程已退出或未响应，请重新打开影片')
    try { destroy() } catch { console.warn('[playback] failed host resources retained until exit') }
    callback?.()
  }
  const snapshot = (): NativePlaybackState => { if (failure) throw failure; return { ...state } }
  return {
    create(bounds: HostBounds): void {
      if (!stopped || resources.size) throw new Error('播放进程资源仍在使用')
      ready = false; failure = undefined; stopped = false
      lastSequence = requestsPending = 0
      state = { alive: true, generatedSubtitleOverlayVersion: 1, generatedSubtitleCommandsPending: 0,
        generatedSubtitleCommandErrors: 0, generatedSubtitleCommandReplies: 0 }
      try {
        statistics.subscribe(report)
        if (process.env.JAVDEX_PLAYBACK_DIAGNOSTICS === '1') controls.subscribe(control)
        const interopFile = path.join(path.dirname(runtime), 'playback-interop.node')
        if (mode === 'gpu') {
          interop = createRequire(path.join(app.getAppPath(), 'package.json'))(interopFile) as Interop
          if (process.platform === 'darwin') { channel = 'org.javdex.playback.' + randomUUID(); interop.createChannel!(channel) }
        }
        const launched = utilityProcess.fork(path.join(app.getAppPath(), 'out/main/playbackHost.js'), [runtime, mode, channel, interopFile],
          { serviceName: 'Javdex Playback', stdio: 'pipe', ...(process.platform === 'darwin' ? { allowLoadingUnsignedLibraries: true } : {}) })
        child = launched; lastHeartbeat = performance.now()
        launched.stderr?.on('data', (data: Buffer) => console.warn('[playback-host]', data.toString('utf8').slice(0, 2048)))
        launched.on('message', (message: HostResponse) => {
          if (stopped || child !== launched) return
          try {
            if (message.type === 'ready') {
              if (ready) throw new Error('Duplicate playback host initialization')
              ready = true; for (const message of queued.splice(0)) post(message)
            } else if (message.type === 'state') { state = message.state; lastHeartbeat = performance.now(); wakeup?.() }
            else if (message.type === 'ack') requestsPending = Math.max(0, requestsPending - 1)
            else if (message.type === 'failed') fail('GPU_RUNTIME_FAILED')
            else if (message.type === 'frame') {
              const frame = message.frame
              if (frames.length >= (mode === 'gpu' ? 3 : 2) || !Number.isSafeInteger(frame.sequence) || frame.sequence <= lastSequence
                || mode === 'gpu' && resources.size >= 3) throw new Error('Playback host frame budget exceeded')
              lastSequence = frame.sequence
              if (mode === 'gpu') {
                if (!Number.isSafeInteger(frame.resourceId) || frame.resourceId! < 1 || !Number.isSafeInteger(frame.slot) || frame.slot! < 0 || frame.slot! > 2)
                  throw new Error('Invalid playback host resource identity')
                let resource = cache.get(frame.resourceId!)
                if (!resource) {
                  const previous = slots.get(frame.slot!)
                  if (previous) { previous.retired = true; dispose(previous) }
                  const pointer = process.platform === 'win32'
                    ? interop!.acquire!(Buffer.from(frame.ntHandle!), launched.pid!) : interop!.acquireSurface!(channel, frame.sequence)
                  resource = { id: frame.resourceId!, slot: frame.slot!, pointer, frames: 0, retired: false }
                  cache.set(resource.id, resource); slots.set(resource.slot, resource)
                }
                if (resource.retired || resource.slot !== frame.slot || resource.frames !== 0) throw new Error('Invalid playback resource generation')
                resource.frames++
                resources.set(frame.sequence, resource)
                if (process.platform === 'win32') frame.ntHandle = resource.pointer; else frame.ioSurface = resource.pointer
              } else if (frame.pixels) frame.pixels = Buffer.from(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength)
              frames.push(frame); wakeup?.()
            }
          } catch (error) { console.warn('[playback-host-channel]', error); fail('FRAME_CHANNEL_FAILED') }
        })
        launched.once('exit', () => { if (!stopped && child === launched) fail('PLAYBACK_HOST_EXITED') })
        heartbeat = setInterval(() => { if (performance.now() - lastHeartbeat > 5000) fail('HELPER_HEARTBEAT_TIMEOUT') }, 250)
        heartbeat.unref(); post({ type: 'create', bounds })
      } catch { fail('GPU_INITIALIZATION_FAILED'); throw failure }
    },
    setBounds(bounds: HostBounds): void { post({ type: 'bounds', bounds }) },
    setVisible(value: boolean): void { post({ type: 'visible', value }) },
    setWakeup(value: (() => void) | null): void { wakeup = value },
    nextFrame(writable = true): HostFrame | undefined { if (failure) throw failure; return mode === 'cpu' && !writable ? undefined : frames.shift() },
    releaseFrame,
    resetTiming(timeline: number): void { discard(); post({ type: 'timing', timeline }) },
    setRenderBudget(milliseconds: number): void { post({ type: 'budget', milliseconds }) },
    requestSelfTest(): void { discard(); post({ type: 'probe' }) },
    command(args: string[], generated = false): void { post({ type: 'command', args, generated }) },
    generatedSubtitles(operation: 'update' | 'visible' | 'clear', document: string, visible: boolean, revision: number): void {
      post({ type: 'subtitles', operation, document, visible, revision })
    },
    state: snapshot, inspect: snapshot, destroy
  }
}
