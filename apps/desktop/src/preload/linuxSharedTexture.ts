import { ipcRenderer, sharedTexture, type ReceivedSharedTextureData } from 'electron'

interface SurfaceBinding { surfaceToken: string; bindingToken: string }
interface FrameMetadata extends SurfaceBinding { sequence: number; diagnosePixels?: boolean }
// The node preload compilation intentionally excludes the full DOM library.
// Keep this isolated-world drawing seam narrow instead of adding DOM globals.
interface ReceivedVideoFrame {
  displayWidth: number; displayHeight: number; close(): void
  allocationSize(options: { format: 'RGBA' }): number
  copyTo(data: Uint8Array, options: { format: 'RGBA' }): Promise<Array<{ offset: number; stride: number }>>
}
interface CanvasContext {
  drawImage(frame: ReceivedVideoFrame, x: number, y: number): void
  clearRect(x: number, y: number, width: number, height: number): void
  getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray }
}
interface PlaybackCanvas {
  width: number
  height: number
  isConnected: boolean
  dataset: { playbackSurface?: string }
  getContext(kind: '2d', options: { alpha: boolean }): CanvasContext | null
  getBoundingClientRect(): { width: number; height: number }
}
declare const document: { querySelectorAll(selector: string): Iterable<PlaybackCanvas> }
declare const getComputedStyle: (canvas: PlaybackCanvas) => { display: string; visibility: string; opacity: string }
declare const crypto: { randomUUID(): string }
interface MountedSurface extends SurfaceBinding {
  canvas: PlaybackCanvas
  context: CanvasContext
  sequence: number
}
const token = (value: unknown): value is string => typeof value === 'string' && /^[\da-f-]{36}$/.test(value)

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
 * function for its fixed player canvas, never a VideoFrame, FD or Electron API. */
export function installLinuxSharedTextureReceiver(): (surfaceToken: string) => () => void {
  let mounted: MountedSurface | null = null
  let supported = process.platform === 'linux' && process.isMainFrame
    && typeof sharedTexture?.setSharedTextureReceiver === 'function'
  const receive = async ({ importedSharedTexture }: ReceivedSharedTextureData, value: unknown): Promise<void> => {
    let frame: ReceivedVideoFrame | undefined
    const target = mounted
    try {
      const metadata = value as FrameMetadata | null
      if (!target || !metadata || metadata.surfaceToken !== target.surfaceToken || metadata.bindingToken !== target.bindingToken
        || !Number.isSafeInteger(metadata.sequence) || metadata.sequence <= target.sequence
        || !target.canvas.isConnected || target.canvas.dataset.playbackSurface !== target.surfaceToken) return
      frame = importedSharedTexture.getVideoFrame() as ReceivedVideoFrame
      if (!frame.displayWidth || !frame.displayHeight) throw new Error('Empty video frame')
      // Changing intrinsic size clears the context, so do it only on resize.
      if (target.canvas.width !== frame.displayWidth) target.canvas.width = frame.displayWidth
      if (target.canvas.height !== frame.displayHeight) target.canvas.height = frame.displayHeight
      target.context.drawImage(frame, 0, 0)
      // Explicit, bounded synthetic-fixture diagnostic. Readback can change
      // synchronization/Canvas acceleration; it is never enabled by default.
      if (metadata.diagnosePixels === true && frame.displayWidth === 640 && frame.displayHeight === 360) {
        const result: Record<string, unknown> = { sequence: metadata.sequence, readbackPerturbsRendering: true }
        try {
          const data = target.context.getImageData(0, 0, 640, 360).data
          result.canvas = summarizePixels(data, 640, 360, 640 * 4)
          const rect = target.canvas.getBoundingClientRect(), style = getComputedStyle(target.canvas)
          result.geometry = { width: rect.width, height: rect.height, connected: target.canvas.isConnected,
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
      target.sequence = metadata.sequence
      ipcRenderer.send('playback:shared-texture-drawn', {
        surfaceToken: target.surfaceToken, bindingToken: target.bindingToken, sequence: metadata.sequence
      })
    } catch {
      if (target === mounted && target) ipcRenderer.send('playback:shared-texture-failed', {
        surfaceToken: target.surfaceToken, bindingToken: target.bindingToken
      })
    } finally {
      try { frame?.close() } finally { importedSharedTexture.release() }
    }
  }
  if (supported) {
    try { sharedTexture.setSharedTextureReceiver(receive) }
    catch { supported = false }
  }
  return surfaceToken => {
    if (!token(surfaceToken)) return () => {}
    const binding: SurfaceBinding = { surfaceToken, bindingToken: crypto.randomUUID() }
    const previous = mounted
    mounted = null
    if (previous) ipcRenderer.send('playback:shared-texture-removed', { surfaceToken: previous.surfaceToken, bindingToken: previous.bindingToken })
    // Ready also identifies a failed binding, so main can authenticate failure
    // without trusting an arbitrary error string from page code.
    ipcRenderer.send('playback:shared-texture-ready', binding)
    let canvas: PlaybackCanvas | undefined
    let context: CanvasContext | null | undefined
    try {
      canvas = [...document.querySelectorAll('canvas[data-playback-surface]')]
        .find(element => element.dataset.playbackSurface === surfaceToken)
      context = canvas?.getContext('2d', { alpha: false })
    } catch { /* Treat context creation failure like an unavailable receiver. */ }
    if (!supported || !canvas || !context) {
      ipcRenderer.send('playback:shared-texture-failed', binding)
      return () => {}
    }
    const target: MountedSurface = { ...binding, canvas, context, sequence: 0 }
    mounted = target
    return () => {
      if (mounted !== target) return
      mounted = null
      target.context.clearRect(0, 0, target.canvas.width, target.canvas.height)
      ipcRenderer.send('playback:shared-texture-removed', binding)
    }
  }
}
