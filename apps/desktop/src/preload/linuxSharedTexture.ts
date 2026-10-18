import { ipcRenderer, sharedTexture, type ReceivedSharedTextureData } from 'electron'

interface SurfaceBinding { surfaceToken: string; bindingToken: string }
interface FrameMetadata extends SurfaceBinding { sequence: number }
// The node preload compilation intentionally excludes the full DOM library.
// Keep this isolated-world drawing seam narrow instead of adding DOM globals.
interface ReceivedVideoFrame { displayWidth: number; displayHeight: number; close(): void }
interface CanvasContext { drawImage(frame: ReceivedVideoFrame, x: number, y: number): void; clearRect(x: number, y: number, width: number, height: number): void }
interface PlaybackCanvas {
  width: number
  height: number
  isConnected: boolean
  dataset: { playbackSurface?: string }
  getContext(kind: '2d', options: { alpha: boolean }): CanvasContext | null
}
declare const document: { querySelectorAll(selector: string): Iterable<PlaybackCanvas> }
declare const crypto: { randomUUID(): string }
interface MountedSurface extends SurfaceBinding {
  canvas: PlaybackCanvas
  context: CanvasContext
  sequence: number
}
const token = (value: unknown): value is string => typeof value === 'string' && /^[\da-f-]{36}$/.test(value)

/** Runs in the isolated, sandboxed preload. Page code receives only a binding
 * function for its fixed player canvas, never a VideoFrame, FD or Electron API. */
export function installLinuxSharedTextureReceiver(): (surfaceToken: string) => () => void {
  let mounted: MountedSurface | null = null
  let supported = process.platform === 'linux' && process.isMainFrame
  let registered = false
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
  return surfaceToken => {
    if (!token(surfaceToken)) return () => {}
    // CPU-frame sessions must never depend on sharedTexture/GPU registration.
    if (supported && !registered) {
      try { sharedTexture.setSharedTextureReceiver(receive); registered = true }
      catch { supported = false }
    }
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
