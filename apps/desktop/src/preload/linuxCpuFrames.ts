import { ipcRenderer } from 'electron'

interface SurfaceBinding { surfaceToken: string; bindingToken: string }
interface FrameMetadata extends SurfaceBinding {
  protocol: 'javdex-cpu-frame-v1'; sequence: number; slot: number; generation: number
  width: number; height: number; stride: number; size: number; pixelFormat: 'rgba'; producerComplete: true
}
// The node preload compilation excludes the DOM library. Keep the isolated-world
// drawing surface narrow; page code never receives pixels or Electron APIs.
interface PixelImage { data: Uint8ClampedArray }
interface CanvasContext {
  createImageData(width: number, height: number): PixelImage
  putImageData(image: PixelImage, x: number, y: number): void
  clearRect(x: number, y: number, width: number, height: number): void
}
interface PlaybackCanvas {
  width: number; height: number; isConnected: boolean
  dataset: { playbackCpuSurface?: string }
  getContext(kind: '2d', options: { alpha: boolean; willReadFrequently: boolean }): CanvasContext | null
}
declare const document: { querySelectorAll(selector: string): Iterable<PlaybackCanvas> }
declare const crypto: { randomUUID(): string }
interface MountedSurface extends SurfaceBinding {
  canvas: PlaybackCanvas; context: CanvasContext; sequence: number; generation: number; visible: boolean
  image: { width: number; height: number; pixels: PixelImage } | null
}
const token = (value: unknown): value is string => typeof value === 'string' && /^[\da-f-]{36}$/.test(value)
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
function frameMetadata(value: unknown): value is FrameMetadata {
  if (!value || typeof value !== 'object') return false
  const frame = value as FrameMetadata
  return token(frame.surfaceToken) && token(frame.bindingToken) && frame.protocol === 'javdex-cpu-frame-v1'
    && integer(frame.sequence, 1, Number.MAX_SAFE_INTEGER) && integer(frame.slot, 0, 2) && integer(frame.generation, 1, 0xffffffff)
    && integer(frame.width, 1, 1280) && integer(frame.height, 1, 720) && frame.pixelFormat === 'rgba'
    && frame.stride === frame.width * 4 && frame.size === frame.stride * frame.height && frame.producerComplete === true
}

/** CPU-only Canvas2D receiver. There is deliberately no VideoFrame/sharedTexture
 * registration and no asynchronous pixel queue. Each message draws or drops and
 * releases before returning; the main/helper lease limits IPC to three frames. */
export function installLinuxCpuFrameReceiver(): (surfaceToken: string) => () => void {
  let mounted: MountedSurface | null = null
  const supported = process.platform === 'linux' && process.isMainFrame
  if (supported) {
    ipcRenderer.on('playback:cpu-frame-state', (_event, value: unknown) => {
      const state = value as (SurfaceBinding & { generation: number; visible: boolean }) | null
      const target = mounted
      if (!target || !state || state.surfaceToken !== target.surfaceToken || state.bindingToken !== target.bindingToken
        || !integer(state.generation, 1, 0xffffffff) || typeof state.visible !== 'boolean') return
      // Preserve the most recent paused frame. Hide/rebind/seek invalidation
      // clears it so a frame from the old generation cannot flash on reopen.
      if (state.generation !== target.generation || !state.visible) target.context.clearRect(0, 0, target.canvas.width, target.canvas.height)
      target.generation = state.generation; target.visible = state.visible
    })
    ipcRenderer.on('playback:cpu-frame', (_event, value: unknown, pixels: unknown) => {
      const target = mounted
      let drawn = false
      // A malformed envelope can never select a canvas or allocate pixel memory.
      if (!frameMetadata(value)) {
        if (target) ipcRenderer.send('playback:cpu-frame-failed', { surfaceToken: target.surfaceToken, bindingToken: target.bindingToken })
        return
      }
      try {
        if (!target || value.surfaceToken !== target.surfaceToken || value.bindingToken !== target.bindingToken
          || value.generation !== target.generation || !target.visible || value.sequence <= target.sequence
          || !target.canvas.isConnected || target.canvas.dataset.playbackCpuSurface !== target.surfaceToken) return
        if (!(pixels instanceof Uint8Array) || pixels.byteLength !== value.size) throw new Error('Invalid CPU pixels')
        if (target.canvas.width !== value.width) target.canvas.width = value.width
        if (target.canvas.height !== value.height) target.canvas.height = value.height
        // A single reusable ImageData bounds retained preload pixels to 720p.
        // putImageData synchronously copies them into the canvas backing store.
        if (!target.image || target.image.width !== value.width || target.image.height !== value.height) {
          target.image = { width: value.width, height: value.height, pixels: target.context.createImageData(value.width, value.height) }
        }
        const image = target.image.pixels
        if (image.data.byteLength !== value.size) throw new Error('Invalid Canvas2D pixels')
        image.data.set(pixels)
        target.context.putImageData(image, 0, 0)
        target.sequence = value.sequence
        drawn = true
      } catch {
        if (target === mounted && target) ipcRenderer.send('playback:cpu-frame-failed', {
          surfaceToken: target.surfaceToken, bindingToken: target.bindingToken
        })
      } finally {
        // putImageData is synchronous: the canvas owns the displayed pixels now.
        // Keeping a paused canvas does not keep a producer slot or IPC buffer.
        ipcRenderer.send('playback:cpu-frame-release', { surfaceToken: value.surfaceToken, bindingToken: value.bindingToken,
          sequence: value.sequence, generation: value.generation, outcome: drawn ? 'drawn' : 'dropped' })
      }
    })
  }
  return surfaceToken => {
    if (!token(surfaceToken)) return () => {}
    const previous = mounted; mounted = null
    if (previous) {
      previous.image = null
      previous.context.clearRect(0, 0, previous.canvas.width, previous.canvas.height)
      ipcRenderer.send('playback:cpu-frame-removed', { surfaceToken: previous.surfaceToken, bindingToken: previous.bindingToken })
    }
    const binding: SurfaceBinding = { surfaceToken, bindingToken: crypto.randomUUID() }
    let canvas: PlaybackCanvas | undefined, context: CanvasContext | null | undefined
    try {
      canvas = [...document.querySelectorAll('canvas[data-playback-cpu-surface]')]
        .find(element => element.dataset.playbackCpuSurface === surfaceToken)
      context = canvas?.getContext('2d', { alpha: false, willReadFrequently: true })
    } catch { /* Context unavailable: authenticate failure against this binding. */ }
    if (supported && canvas && context) mounted = { ...binding, canvas, context, sequence: 0, generation: 0, visible: false, image: null }
    ipcRenderer.send('playback:cpu-frame-ready', binding)
    if (!mounted) { ipcRenderer.send('playback:cpu-frame-failed', binding); return () => {} }
    const target = mounted
    return () => {
      if (mounted !== target) return
      mounted = null
      target.image = null
      target.context.clearRect(0, 0, target.canvas.width, target.canvas.height)
      ipcRenderer.send('playback:cpu-frame-removed', binding)
    }
  }
}
