import { ipcRenderer, sharedTexture, type ReceivedSharedTextureData } from 'electron'
import { createCpuFramePortReceiver, type CpuPixelsPort } from './cpuFramePort'
import { createSharedTextureVideo, type SharedVideoSurface } from './sharedTextureVideo'

interface SurfaceBinding { surfaceToken: string; bindingToken: string }
interface FrameMetadata extends SurfaceBinding { cpuChannelId?: string; sequence: number; targetTime?: number; timeline?: number; diagnosePixels?: boolean; selfTest?: 'solid-v1' }
// The node preload compilation intentionally excludes the full DOM library.
// Keep this isolated-world display seam narrow instead of adding DOM globals.
interface ReceivedVideoFrame {
  displayWidth: number; displayHeight: number; close(): void; clone(): ReceivedVideoFrame
  allocationSize(options: { format: 'RGBA' }): number
  copyTo(data: Uint8Array, options: { format: 'RGBA' }): Promise<Array<{ offset: number; stride: number }>>
}
interface CanvasContext {
  globalCompositeOperation: 'copy'
  createImageData(width: number, height: number): { data: Uint8ClampedArray }
  putImageData(image: { data: Uint8ClampedArray }, x: number, y: number): void
  drawImage(frame: ReceivedVideoFrame, x: number, y: number): void
  clearRect(x: number, y: number, width: number, height: number): void
  getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray }
}
interface PlaybackDisplay {
  isConnected: boolean
  dataset: { playbackSurface?: string }
  getBoundingClientRect(): { width: number; height: number }
}
interface PlaybackCanvas extends PlaybackDisplay {
  width: number
  height: number
  getContext(kind: '2d', options: { alpha: boolean; colorSpace: 'srgb'; willReadFrequently?: boolean }): CanvasContext | null
}
declare const document: { querySelectorAll(selector: string): Iterable<PlaybackCanvas | PlaybackDisplay & SharedVideoSurface> }
declare const getComputedStyle: (surface: PlaybackDisplay) => { display: string; visibility: string; opacity: string }
declare const crypto: { randomUUID(): string }
interface MountedSurface extends SurfaceBinding {
  element: PlaybackDisplay
  canvas?: PlaybackCanvas
  context?: CanvasContext
  video?: ReturnType<typeof createSharedTextureVideo>
  sequence: number
  image?: { data: Uint8ClampedArray }
  timeline: number
  clockOffset?: number
  bestRtt: number
  clockSamples: number
  clockRequestedAt: number
  cancellations: Set<() => void>
}
const token = (value: unknown): value is string => typeof value === 'string' && /^(?:cpu:)?[\da-f-]{36}$/.test(value)

export function summarizePixels(data: Uint8Array | Uint8ClampedArray, width: number, height: number, stride: number, offset = 0) {
  let samples = 0, nonblack = 0, maximum = 0, opaque = 0
  for (let y = 0; y < height; y += Math.max(1, Math.ceil(height / 24))) {
    for (let x = 0; x < width; x += Math.max(1, Math.ceil(width / 32))) {
      const index = offset + y * stride + x * 4
      if (index + 3 >= data.length) continue
      const peak = Math.max(data[index], data[index + 1], data[index + 2])
      samples++; if (peak > 16) nonblack++; maximum = Math.max(maximum, peak)
      if (data[index + 3] === 255) opaque++
    }
  }
  return { samples, nonblack, maximum, opaque }
}

/** Runs in the isolated, sandboxed preload. Page code receives only a binding
 * function for its fixed player surface, never a VideoFrame, FD or Electron API. */
export function installSharedTextureReceiver(): (surfaceToken: string) => () => void {
  let mounted: MountedSurface | null = null
  let supported = ['linux', 'darwin', 'win32'].includes(process.platform) && process.isMainFrame
    && typeof sharedTexture?.setSharedTextureReceiver === 'function'
  // Monotonic-clock calibration: no wall clock, no synchronous renderer IPC.
  // Midpoint mapping has bounded RTT uncertainty; choose the best of 3 probes.
  const requestClock = (target: MountedSurface): void => {
    target.clockRequestedAt = performance.now()
    ipcRenderer.send('playback:frame-clock', {
      surfaceToken: target.surfaceToken, bindingToken: target.bindingToken, sentAt: target.clockRequestedAt
    })
  }
  ipcRenderer.on('playback:frame-clock', (_event, value: unknown) => {
    const target = mounted
    const v = value as SurfaceBinding & { sentAt: number; mainTime: number }
    if (!target || !v || v.surfaceToken !== target.surfaceToken || v.bindingToken !== target.bindingToken
      || !Number.isFinite(v.sentAt) || !Number.isFinite(v.mainTime)) return
    const current = performance.now(), rtt = current - v.sentAt
    if (rtt < 0 || rtt > 1000) return
    if (rtt < target.bestRtt) { target.bestRtt = rtt; target.clockOffset = (v.sentAt + current) / 2 - v.mainTime }
    if (++target.clockSamples < 3) requestClock(target)
  })
  const cancel = (target: MountedSurface): void => {
    for (const stop of target.cancellations) stop()
    target.cancellations.clear()
  }
  const retire = (target: MountedSurface): void => {
    cancel(target)
    try {
      cpuFrames.dispose(target)
      target.video?.dispose()
      if (target.canvas) target.context?.clearRect(0, 0, target.canvas.width, target.canvas.height)
    }
    finally {
      // Reset the backing store on direct rebind as well as effect cleanup.
      // clearRect alone can retain the last VideoFrame in a deferred display
      // list. Actual ticket release still waits for its consumer GPU callback.
      if (target.canvas) { target.canvas.width = 0; target.canvas.height = 0 }
      target.image = undefined
      ipcRenderer.send('playback:shared-texture-removed', {
        surfaceToken: target.surfaceToken, bindingToken: target.bindingToken
      })
    }
  }
  const delay = (target: MountedSurface, ms: number): Promise<void> => new Promise(resolve => {
    const stop = (): void => { clearTimeout(timer); target.cancellations.delete(stop); resolve() }
    const timer = setTimeout(stop, ms)
    target.cancellations.add(stop)
  })
  ipcRenderer.on('playback:frame-flush', (_event, value: unknown) => {
    const target = mounted, v = value as SurfaceBinding & { timeline: number }
    if (!target || !v || v.surfaceToken !== target.surfaceToken || v.bindingToken !== target.bindingToken
      || !Number.isSafeInteger(v.timeline) || v.timeline <= target.timeline) return
    target.timeline = v.timeline; cancel(target)
    try { target.video?.flush(); cpuFrames.flush() }
    catch { ipcRenderer.send('playback:shared-texture-failed', { surfaceToken: target.surfaceToken, bindingToken: target.bindingToken }) }
  })
  const current = (target: MountedSurface, metadata: FrameMetadata): boolean => mounted === target
    && (metadata.timeline ?? 0) === target.timeline && metadata.sequence > target.sequence
    && target.element.isConnected && target.element.dataset.playbackSurface === target.surfaceToken
  const waitForTarget = async (target: MountedSurface, metadata: FrameMetadata, arrivedAt: number): Promise<boolean> => {
    if (metadata.targetTime !== undefined && (!Number.isFinite(metadata.targetTime) || metadata.targetTime < 0)) throw new Error('Invalid target time')
    if (metadata.targetTime) {
      while (target.clockOffset === undefined || target.bestRtt > 20) {
        if (!current(target, metadata)) return false
        if (performance.now() - arrivedAt > 1000) throw new Error('Frame clock calibration failed')
        // A busy startup can make all initial probes uncertain. Retry at most
        // every 50ms across concurrent frames, retaining the same 20ms bound
        // and one-second deadline rather than failing forever on those samples.
        if (performance.now() - target.clockRequestedAt >= 50) requestClock(target)
        await delay(target, 2)
      }
      const due = metadata.targetTime + target.clockOffset
      if (due - performance.now() > 100) throw new Error('Frame target too far ahead')
      while (due - performance.now() > 0.5) {
        await delay(target, Math.max(1, due - performance.now()))
        if (!current(target, metadata)) return false
      }
    }
    return current(target, metadata)
  }
  const receive = async ({ importedSharedTexture }: ReceivedSharedTextureData, value: unknown): Promise<void> => {
    let frame: ReceivedVideoFrame | undefined
    const target = mounted
    const epoch = target?.timeline
    try {
      const metadata = value as FrameMetadata | null
      if (!target || !metadata || metadata.surfaceToken !== target.surfaceToken || metadata.bindingToken !== target.bindingToken
        || !metadata.selfTest && (metadata.timeline ?? 0) !== target.timeline
        || !Number.isSafeInteger(metadata.sequence) || metadata.sequence <= target.sequence
        || !target.element.isConnected || target.element.dataset.playbackSurface !== target.surfaceToken) return
      frame = importedSharedTexture.getVideoFrame() as ReceivedVideoFrame
      if (!frame.displayWidth || !frame.displayHeight) throw new Error('Empty video frame')
      if (metadata.selfTest === 'solid-v1') {
        // Exercise the actual mounted consumer. Video probes gate film writes
        // and reset the stream; Canvas probes clear synchronously before paint.
        let samples: number[] = []
        let probeFailure: string | undefined
        try {
          if (frame.displayWidth !== 640 || frame.displayHeight !== 360) throw new Error('Invalid self-test dimensions')
          if (target.video) samples = await target.video.selfTest(frame, () => mounted === target && target.timeline === epoch && target.element.isConnected)
          else {
            target.canvas!.width = 640; target.canvas!.height = 360
            target.context!.drawImage(frame, 0, 0)
            const pixels = target.context!.getImageData(0, 0, 640, 360).data
            for (const [x, y] of [[80, 45], [559, 45], [320, 180], [80, 314], [559, 314]])
              samples.push(...pixels.slice((y * 640 + x) * 4, (y * 640 + x) * 4 + 4))
          }
        } catch (error) {
          samples = []
          const message = error instanceof Error ? error.message : ''
          probeFailure = message === 'Video frame observation timed out' ? 'timeout'
            : message === 'Invalid video diagnostic dimensions' ? 'dimensions'
              : message === 'Video frame observation cancelled' ? 'cancelled' : 'consumer'
        }
        finally { if (!target.video) target.context?.clearRect(0, 0, 640, 360) }
        if (mounted !== target || target.timeline !== epoch) return
        target.sequence = Math.max(target.sequence, metadata.sequence)
        ipcRenderer.send('playback:shared-texture-self-test', { surfaceToken: target.surfaceToken,
          bindingToken: target.bindingToken, sequence: metadata.sequence, samples, ...(probeFailure ? { probeFailure } : {}) })
        return
      }
      const arrivedAt = performance.now()
      const timed = typeof metadata.targetTime === 'number' && metadata.targetTime > 0
      if (!await waitForTarget(target, metadata, arrivedAt)) return
      // Changing intrinsic size clears the context, so do it only on resize.
      const submissionStarted = performance.now()
      if (target.video) {
        if (!await target.video.submit(frame, () => current(target, metadata))) return
      } else {
        if (target.canvas!.width !== frame.displayWidth) target.canvas!.width = frame.displayWidth
        if (target.canvas!.height !== frame.displayHeight) target.canvas!.height = frame.displayHeight
        target.context!.globalCompositeOperation = 'copy'
        target.context!.drawImage(frame, 0, 0)
      }
      const submissionCompleted = performance.now()
      // Commit the submission before an opt-in asynchronous readback. A newer
      // frame/epoch may arrive while copyTo is pending; it must not be undone.
      target.sequence = metadata.sequence
      ipcRenderer.send('playback:shared-texture-submitted', {
        surfaceToken: target.surfaceToken, bindingToken: target.bindingToken, sequence: metadata.sequence,
        timeline: metadata.timeline ?? 0,
        ...(timed && target.clockOffset !== undefined ? {
          readyTime: arrivedAt - target.clockOffset, submissionStartedTime: submissionStarted - target.clockOffset,
          submittedTime: submissionCompleted - target.clockOffset
        } : {})
      })
      // Explicit, bounded synthetic-fixture diagnostic. Readback can change
      // synchronization/Canvas acceleration; it is never enabled by default.
      if (metadata.diagnosePixels === true && frame.displayWidth === 640 && frame.displayHeight === 360) {
        const result: Record<string, unknown> = { sequence: metadata.sequence, readbackPerturbsRendering: true }
        try {
          const data = target.video ? target.video.pixels(640, 360) : target.context!.getImageData(0, 0, 640, 360).data
          result.canvas = summarizePixels(data, 640, 360, 640 * 4)
          const rect = target.element.getBoundingClientRect(), style = getComputedStyle(target.element)
          result.geometry = { width: rect.width, height: rect.height, connected: target.element.isConnected,
            displayed: style.display !== 'none', visible: style.visibility === 'visible', opacity: Number(style.opacity) }
        } catch { result.canvasError = true }
        try {
          const options = { format: 'RGBA' as const }
          const size = frame.allocationSize(options)
          if (size > 4 * 1024 * 1024) throw new Error('Diagnostic frame too large')
          const data = new Uint8Array(size)
          const [layout] = await frame.copyTo(data, options)
          result.imported = summarizePixels(data, 640, 360, layout.stride, layout.offset)
        } catch { result.importedError = true }
        ipcRenderer.send('playback:shared-texture-pixel-diagnostic', {
          surfaceToken: target.surfaceToken, bindingToken: target.bindingToken, ...result
        })
      }
    } catch {
      if (target === mounted && target && target.timeline === epoch) ipcRenderer.send('playback:shared-texture-failed', {
        surfaceToken: target.surfaceToken, bindingToken: target.bindingToken
      })
    } finally {
      try { frame?.close() } finally { importedSharedTexture.release() }
    }
  }
  const receiveCpu = async (value: unknown): Promise<void> => {
    const target = mounted
    const epoch = target?.timeline
    const v = value as FrameMetadata & { width: number; height: number; stride: number; size: number; pixels: Uint8Array; pixelFormat?: unknown; renderStartUs?: number }
    if (!target || !v || v.surfaceToken !== target.surfaceToken || v.bindingToken !== target.bindingToken
      || !Number.isSafeInteger(v.sequence) || v.sequence <= target.sequence) return
    try {
      if (!target.video && (!target.canvas || !target.context)) throw new Error('CPU display unavailable')
      const arrivedAt = performance.now()
      if (v.targetTime !== undefined && (!Number.isFinite(v.targetTime) || v.targetTime < 0)) throw new Error('Invalid CPU target')
      if (v.targetTime && !await waitForTarget(target, v, arrivedAt)) return
      if (!current(target, v)) return
      if (![v.width, v.height, v.stride, v.size].every(Number.isSafeInteger)
        || v.width < 1 || v.width > 8192 || v.height < 1 || v.height > 8192
        || v.stride < v.width * 4 || v.stride > 32768 || v.size !== v.stride * v.height
        || v.size > 256 * 1024 * 1024 || !(v.pixels instanceof Uint8Array) || v.pixels.byteLength !== v.size
        || process.platform === 'linux' && v.pixelFormat !== 'rgbx')
        throw new Error('Invalid CPU pixels')
      let submissionStarted: number
      if (target.video) {
        submissionStarted = performance.now()
        if (v.renderStartUs !== undefined && (!Number.isFinite(v.renderStartUs) || v.renderStartUs < 0)) throw new Error('Invalid CPU render timestamp')
        // Keep VideoFrame in the producer's monotonic epoch, like GPU frames.
        // Only the delivery wait maps that epoch to renderer performance.now().
        const timestamp = Math.round(v.targetTime ? v.targetTime * 1000
          : v.renderStartUs ?? (submissionStarted - (target.clockOffset ?? 0)) * 1000)
        if (!await target.video.submitCpu({ pixels: v.pixels, width: v.width, height: v.height, stride: v.stride, timestamp, copyInput: process.platform === 'darwin' && !!v.cpuChannelId },
          () => current(target, v))) return
      } else {
        if (target.canvas!.width !== v.width) { target.canvas!.width = v.width; target.image = undefined }
        if (target.canvas!.height !== v.height) { target.canvas!.height = v.height; target.image = undefined }
        if (!target.image || target.image.data.length !== v.width * v.height * 4) target.image = target.context!.createImageData(v.width, v.height)
        const image = target.image
        for (let y = 0; y < v.height; y++) image.data.set(v.pixels.subarray(y * v.stride, y * v.stride + v.width * 4), y * v.width * 4)
        submissionStarted = performance.now()
        target.context!.putImageData(image, 0, 0)
      }
      const submissionCompleted = performance.now()
      target.sequence = v.sequence
      ipcRenderer.send('playback:shared-texture-submitted', { surfaceToken: target.surfaceToken, bindingToken: target.bindingToken, sequence: v.sequence,
        timeline: v.timeline ?? 0, ...(v.targetTime && target.clockOffset !== undefined ? { readyTime: arrivedAt - target.clockOffset,
          submissionStartedTime: submissionStarted - target.clockOffset, submittedTime: submissionCompleted - target.clockOffset } : {}) })
    } catch {
      if (target === mounted && target.timeline === epoch) ipcRenderer.send('playback:shared-texture-failed', {
        surfaceToken: target.surfaceToken, bindingToken: target.bindingToken
      })
    } finally {
      // The pixels were copied by main; video owns its transferred copy.
      // Consumption and discard both return CPU credit, not GPU completion.
      ipcRenderer.send('playback:cpu-frame-released', { surfaceToken: target.surfaceToken, bindingToken: target.bindingToken, sequence: v.sequence })
    }
  }
  const cpuFrames = createCpuFramePortReceiver({
    current: () => mounted,
    consume: receiveCpu,
    release: (binding, sequence) => ipcRenderer.send('playback:cpu-frame-released', { ...binding, sequence }),
    fail: binding => ipcRenderer.send('playback:shared-texture-failed', binding)
  })
  if (process.platform === 'darwin' && process.isMainFrame) {
    ipcRenderer.on('playback:cpu-frame-port', (event, value: unknown) => cpuFrames.attach(value, event.ports?.[0] as unknown as CpuPixelsPort))
  }
  ipcRenderer.on('playback:cpu-frame', (_event, value: unknown) => { if (!cpuFrames.frame(value)) void receiveCpu(value) })
  const nativeTransfer = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : null
  if (nativeTransfer && process.isMainFrame) ipcRenderer.on(`playback:${nativeTransfer}-texture-transfer`, (_event, value: unknown) => {
    const metadata = value as FrameMetadata & { transfer: Electron.SharedTextureTransfer }
    if (!metadata || typeof metadata.surfaceToken !== 'string' || typeof metadata.bindingToken !== 'string'
      || !Number.isSafeInteger(metadata.sequence) || metadata.sequence < 1) return
    let imported: Electron.SharedTextureImportedSubtle | undefined
    let released = false
    const acknowledge = (): void => ipcRenderer.send(`playback:${nativeTransfer}-texture-released`, {
      surfaceToken: metadata.surfaceToken, bindingToken: metadata.bindingToken, sequence: metadata.sequence
    })
    // A new Linux document must not acquire queued transfers from an old
    // binding. Discard before import; no consumer GPU reference exists here.
    // This also lets main safely retire a stopped producer after page reload,
    // including reloads that reuse the same RenderFrameHost.
    if (nativeTransfer === 'linux' && (!mounted || metadata.surfaceToken !== mounted.surfaceToken
      || metadata.bindingToken !== mounted.bindingToken || !mounted.element.isConnected)) {
      acknowledge(); return
    }
    try {
      imported = sharedTexture.subtle.finishTransferSharedTexture(metadata.transfer)
      const source = imported
      // Verify/flush acquisition on both native transfer paths before display
      // consumes the SharedImage. Transfer delivery alone is not acquisition;
      // release still waits for the consumer GPU completion callback.
      source.getFrameCreationSyncToken()
      void receive({ importedSharedTexture: {
        textureId: '', subtle: source, getVideoFrame: source.getVideoFrame,
        release: () => { if (!released) { released = true; source.release(acknowledge) } }
      } }, metadata)
    } catch {
      if (imported && !released) { released = true; imported.release(acknowledge) }
      else if (!imported) acknowledge()
      ipcRenderer.send('playback:shared-texture-failed', { surfaceToken: metadata.surfaceToken, bindingToken: metadata.bindingToken })
    }
  })
  if (supported) {
    try { sharedTexture.setSharedTextureReceiver(receive) }
    catch { supported = false }
  }
  return surfaceToken => {
    if (!token(surfaceToken)) return () => {}
    const binding: SurfaceBinding = { surfaceToken, bindingToken: crypto.randomUUID() }
    const previous = mounted
    mounted = null
    if (previous) retire(previous)
    // Ready also identifies a failed binding, so main can authenticate failure
    // without trusting an arbitrary error string from page code.
    ipcRenderer.send('playback:shared-texture-ready', binding)
    let canvas: PlaybackCanvas | undefined
    let context: CanvasContext | null | undefined
    let element: PlaybackDisplay | undefined
    let video: MountedSurface['video']
    try {
      const surface = [...document.querySelectorAll('[data-playback-surface]')]
        .find(element => element.dataset.playbackSurface === surfaceToken)
      element = surface
      if (['darwin', 'linux'].includes(process.platform) && process.isMainFrame && (supported || surfaceToken.startsWith('cpu:')) && surface && 'videoWidth' in surface) {
        video = createSharedTextureVideo(surface, () => {
          if (mounted?.bindingToken === binding.bindingToken) ipcRenderer.send('playback:shared-texture-failed', binding)
        })
      } else if (surface && 'getContext' in surface && process.platform === 'win32') {
        canvas = surface
        // Make the browser default explicit; this does not convert untagged
        // producer bytes from BT.709 transfer or certify GPU color management.
        // CPU recovery gets a fresh canvas from React and requests software
        // backing. Reusing an accelerated 2D context after a GPU exit can accept
        // putImageData yet keep presenting a lost GPU resource.
        context = canvas?.getContext('2d', { alpha: false, colorSpace: 'srgb',
          ...(surfaceToken.startsWith('cpu:') ? { willReadFrequently: true } : {}) })
      }
    } catch { /* Treat context creation failure like an unavailable receiver. */ }
    if ((!supported && !(surfaceToken.startsWith('cpu:') && ['linux', 'win32', 'darwin'].includes(process.platform) && process.isMainFrame)) || !element || (!video && (!canvas || !context))) {
      video?.dispose()
      ipcRenderer.send('playback:shared-texture-failed', binding)
      return () => {}
    }
    const target: MountedSurface = { ...binding, element, canvas, context: context ?? undefined, video, sequence: 0, timeline: 0, bestRtt: Infinity, clockSamples: 0, clockRequestedAt: 0, cancellations: new Set() }
    mounted = target
    requestClock(target)
    return () => {
      if (mounted !== target) return
      mounted = null
      retire(target)
    }
  }
}
