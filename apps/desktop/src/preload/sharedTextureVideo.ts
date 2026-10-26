// Structural DOM types keep the sandbox preload independent of the full DOM lib.
export interface VideoFrameSource { displayWidth: number; displayHeight: number }
export interface CpuVideoSource { pixels: Uint8Array; width: number; height: number; stride: number; timestamp: number }
declare const VideoFrame: new (pixels: Uint8Array, options: {
  format: 'RGBX'; codedWidth: number; codedHeight: number
  layout: Array<{ offset: number; stride: number }>; timestamp: number
  colorSpace: { primaries: 'bt709'; transfer: 'iec61966-2-1'; matrix: 'rgb'; fullRange: true }
  transfer: ArrayBuffer[]
}) => VideoFrameSource & { close(): void }
interface TrackWriter {
  write(frame: VideoFrameSource): Promise<void>
  abort(): Promise<void>
  releaseLock(): void
  closed: Promise<void>
}
interface VideoTrack { writable: { getWriter(): TrackWriter }; stop(): void }
export interface SharedVideoSurface {
  muted: boolean
  playsInline: boolean
  srcObject: unknown
  videoWidth: number
  videoHeight: number
  error: unknown
  style: { opacity: string }
  play(): Promise<void>
  pause(): void
  load(): void
  addEventListener(name: 'error', listener: () => void): void
  removeEventListener(name: 'error', listener: () => void): void
  requestVideoFrameCallback(callback: () => void): number
  cancelVideoFrameCallback(id: number): void
}
declare const MediaStreamTrackGenerator: new (options: { kind: 'video' }) => VideoTrack
declare const MediaStream: new (tracks: VideoTrack[]) => unknown
declare const document: { createElement(name: 'canvas'): {
  width: number; height: number
  getContext(name: '2d', settings: { alpha: boolean; colorSpace: 'srgb' }): {
    drawImage(source: SharedVideoSurface, x: number, y: number, width: number, height: number): void
    getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray }
  } | null
} }

/** Owns DOM consumption and transferred CPU buffer frames. The GPU caller closes
 * its frames and releases Electron imports; neither write nor presentation
 * completion returns a native GPU texture lease. */
export function createSharedTextureVideo(video: SharedVideoSurface, fail: () => void) {
  let active = true, generation = 0
  let track: VideoTrack | undefined, writer: TrackWriter | undefined
  let probe: Promise<void> | undefined
  let cpuReady: Promise<void> = Promise.resolve()
  const observations = new Set<() => void>()
  const opacity = video.style.opacity
  const clear = (): void => {
    generation++
    for (const cancel of observations) cancel()
    observations.clear()
    const previous = writer
    writer = undefined
    // Aborting a queued write is cancellation, not a GPU release signal.
    if (previous) {
      void previous.abort().catch(() => {})
      try { previous.releaseLock() } catch { /* A pending write keeps its own reference. */ }
    }
    track?.stop(); track = undefined
    video.pause(); video.srcObject = null; video.load()
    video.style.opacity = opacity
  }
  const reset = (): void => {
    clear()
    track = new MediaStreamTrackGenerator({ kind: 'video' })
    writer = track.writable.getWriter()
    void writer.closed.catch(() => {})
    video.muted = true; video.playsInline = true
    video.srcObject = new MediaStream([track])
    const epoch = generation
    void video.play().catch(() => { if (active && generation === epoch) fail() })
  }
  const error = (): void => { if (active && video.error) fail() }
  const observe = (timeoutMs = 1500): { promise: Promise<void>; cancel(): void } => {
    let cancel!: () => void
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (reason?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer); video.cancelVideoFrameCallback(id); observations.delete(cancel)
        if (reason) reject(new Error(reason)); else resolve()
      }
      cancel = (): void => finish('Video frame observation cancelled')
      const timer = setTimeout(() => finish('Video frame observation timed out'), timeoutMs)
      const id = video.requestVideoFrameCallback(() => finish())
      observations.add(cancel)
    })
    return { promise, cancel }
  }
  const pixels = (width: number, height: number): Uint8ClampedArray => {
    if (width !== 640 || height !== 360 || video.videoWidth !== width || video.videoHeight !== height)
      throw new Error('Invalid video diagnostic dimensions')
    const canvas = document.createElement('canvas')
    try {
      canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' })
      if (!context) throw new Error('Video diagnostic context unavailable')
      context.drawImage(video, 0, 0, width, height)
      return context.getImageData(0, 0, width, height).data
    } finally { canvas.width = 0; canvas.height = 0 }
  }
  try { reset(); video.addEventListener('error', error) }
  catch (reason) { active = false; clear(); throw reason }
  const submit = async (frame: VideoFrameSource, current: () => boolean): Promise<boolean> => {
    await probe
    if (!active || !current()) return false
    const epoch = generation, owner = writer!
    await owner.write(frame)
    return active && generation === epoch && current()
  }
  return {
    submit,
    async submitCpu(source: CpuVideoSource, current: () => boolean): Promise<boolean> {
      const previous = cpuReady
      let release!: () => void
      cpuReady = new Promise<void>(resolve => { release = resolve })
      await previous
      try {
        await probe
        if (!active || !current()) return false
        const epoch = generation
        // Main already copied these pixels. Transfer only this private IPC buffer,
        // never the producer's pool or a shared GPU allocation. CPU output is opaque.
        const frame = new VideoFrame(source.pixels, {
          format: 'RGBX', codedWidth: source.width, codedHeight: source.height,
          layout: [{ offset: 0, stride: source.stride }], timestamp: source.timestamp,
          colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true },
          transfer: [source.pixels.buffer as ArrayBuffer]
        })
        let observed: ReturnType<typeof observe> | undefined
        try {
          // Local MediaStreams replace their current frame immediately. Bound
          // CPU writes to one compositor callback so a burst cannot overwrite
          // an unseen frame. This is backpressure, not GPU lease completion.
          // Match the copied-frame transport's five-second consumer budget.
          observed = observe(5000)
          const [accepted] = await Promise.all([submit(frame, current), observed.promise])
          return accepted && active && generation === epoch && current()
        } catch (reason) {
          if (!active || generation !== epoch || !current()) return false
          throw reason
        } finally { observed?.cancel(); frame.close() }
      } finally { release() }
    },
    async selfTest(frame: VideoFrameSource, current: () => boolean): Promise<number[]> {
      reset()
      const epoch = generation
      // Exercise the mounted video route without flashing the synthetic frame.
      video.style.opacity = '0'
      const operation = (async () => {
        const observed = observe()
        // Attach the cancellation handler before a write can reject.
        try { await Promise.all([writer!.write(frame), observed.promise]) }
        finally { observed.cancel() }
        if (!active || generation !== epoch || !current()) return []
        const data = pixels(640, 360), samples: number[] = []
        for (const [x, y] of [[80, 45], [559, 45], [320, 180], [80, 314], [559, 314]])
          samples.push(...data.slice((y * 640 + x) * 4, (y * 640 + x) * 4 + 4))
        return samples
      })().finally(() => { if (active && generation === epoch) reset() })
      const barrier = operation.then(() => {}, () => {})
      probe = barrier
      try { return await operation }
      finally { if (probe === barrier) probe = undefined }
    },
    pixels,
    flush(): void { if (active) reset() },
    dispose(): void {
      if (!active) return
      active = false; video.removeEventListener('error', error); clear()
    }
  }
}
