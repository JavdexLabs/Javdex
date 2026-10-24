import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import type { NativePlaybackState } from './nativePlayback'

interface Bounds { width: number; height: number; scale?: number }
interface Binding { surfaceToken: string; bindingToken: string }
interface CpuFrame { sequence: number; width: number; height: number; stride: number; size: number; delayUs: number; pixels: Buffer }
export interface WindowsSoftwareProducer {
  create(bounds: Bounds): void
  setBounds(bounds: Bounds): void
  setVisible(value: boolean): void
  nextFrame(writable: boolean): CpuFrame | undefined
  command(args: string[], generated?: boolean): void
  generatedSubtitles(operation: 'update' | 'visible' | 'clear', document: string, visible: boolean, revision: number): void
  state(): NativePlaybackState
  inspect(): NativePlaybackState
  destroy(): void
}
const monotonicMs = (): number => Number(process.hrtime.bigint()) / 1e6

/** Copied, bounded CPU frames. This path never imports a shared GPU texture and
 * remains usable with Chromium's software compositor (--disable-gpu). */
export function createWindowsSoftwarePlaybackBridge(native: WindowsSoftwareProducer, window: BrowserWindow) {
  if (!native || typeof native.nextFrame !== 'function') throw new Error('播放运行库缺少 Windows CPU 后端，请重新构建并重启应用')
  const contents = window.webContents, surfaceToken = 'cpu:' + randomUUID()
  let binding: Binding | null = null, stopped = true, requested = false, shown = false
  let timeline = 0, lastSequence = 0, submitted = 0, dimensions = '', lastDrawn = 0
  let failure: Error | undefined, timer: ReturnType<typeof setInterval> | undefined
  const pending = new Map<number, { binding: string; since: number; timeline: number }>()
  const trusted = (event: IpcMainEvent): boolean => !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame
  const matches = (event: IpcMainEvent, value: unknown): value is Binding => {
    const v = value as Binding | null
    return trusted(event) && !!v && v.surfaceToken === surfaceToken && typeof v.bindingToken === 'string' && /^[\da-f-]{36}$/.test(v.bindingToken)
  }
  const flush = (): void => {
    timeline++
    if (binding && !contents.isDestroyed()) contents.send('playback:frame-flush', { ...binding, timeline })
  }
  const visibility = (): void => {
    const next = requested && binding !== null
    if (stopped || shown === next) return
    shown = next; flush(); native.setVisible(next)
  }
  const ready = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !matches(event, value)) return
    if (binding?.bindingToken !== value.bindingToken) pending.clear()
    binding = { surfaceToken, bindingToken: value.bindingToken }
    flush(); visibility()
  }
  const removed = (event: IpcMainEvent, value: unknown): void => {
    if (!matches(event, value) || binding?.bindingToken !== value.bindingToken) return
    // Pixels have already been copied; no native memory is leased to renderer.
    binding = null; pending.clear(); visibility()
  }
  const clock = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !matches(event, value)) return
    const sentAt = (value as Binding & { sentAt?: unknown }).sentAt
    if (typeof sentAt === 'number' && Number.isFinite(sentAt) && sentAt >= 0)
      contents.send('playback:frame-clock', { ...value, sentAt, mainTime: monotonicMs() })
  }
  const released = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !matches(event, value)) return
    const sequence = (value as Binding & { sequence: number }).sequence
    if (pending.get(sequence)?.binding === value.bindingToken) pending.delete(sequence)
  }
  const drawn = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !matches(event, value) || value.bindingToken !== binding?.bindingToken) return
    const v = value as Binding & { sequence: number; timeline: number }
    const frame = pending.get(v.sequence)
    if (frame && frame.binding === v.bindingToken && frame.timeline === timeline && v.timeline === timeline && v.sequence > lastDrawn) {
      lastDrawn = v.sequence; submitted++
    }
  }
  const destroy = (): void => {
    if (stopped) return
    stopped = true; clearInterval(timer)
    try { flush() } catch { /* The consumer can already be gone. */ }
    for (const [name, listener] of listeners) ipcMain.removeListener(name, listener)
    contents.removeListener('destroyed', gone); contents.removeListener('render-process-gone', gone)
    contents.removeListener('did-start-navigation', navigation)
    binding = null; pending.clear(); shown = requested = false
    native.destroy()
  }
  const fail = (message: string): void => { failure ??= new Error(message); destroy() }
  const gone = (): void => fail('播放器页面已关闭')
  const navigation = (_event: unknown, _url: string, inPlace: boolean, main: boolean): void => { if (main && !inPlace) gone() }
  const receiverFailed = (event: IpcMainEvent, value: unknown): void => {
    if (matches(event, value) && value.bindingToken === binding?.bindingToken) fail('CPU 视频画面显示失败')
  }
  const listeners: Array<[string, (event: IpcMainEvent, value: unknown) => void]> = [
    ['playback:shared-texture-ready', ready], ['playback:shared-texture-removed', removed],
    ['playback:shared-texture-failed', receiverFailed], ['playback:frame-clock', clock],
    ['playback:cpu-frame-released', released], ['playback:shared-texture-submitted', drawn]
  ]
  const poll = (): void => {
    if (stopped) return
    try {
      if (shown && pending.size >= 2 && [...pending.values()].every(frame => Date.now() - frame.since > 5000))
        throw new Error('CPU 视频帧消费超时')
      const start = monotonicMs()
      const frame = native.nextFrame(shown && pending.size < 2)
      if (!frame || !shown || !binding) return
      if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= lastSequence
        || ![frame.width, frame.height, frame.stride, frame.size].every(Number.isSafeInteger)
        || frame.width < 1 || frame.width > 8192 || frame.height < 1 || frame.height > 8192
        || frame.stride < frame.width * 4 || frame.stride > 32768 || frame.stride % 64 !== 0
        || frame.size > 256 * 1024 * 1024 || frame.size !== frame.stride * frame.height
        || !Buffer.isBuffer(frame.pixels) || frame.pixels.length !== frame.size || !Number.isFinite(frame.delayUs))
        throw new Error('Invalid Windows CPU frame')
      lastSequence = frame.sequence
      pending.set(frame.sequence, { binding: binding.bindingToken, since: Date.now(), timeline })
      contents.send('playback:cpu-frame', { ...binding, ...frame, timeline,
        targetTime: frame.delayUs > 0 && frame.delayUs <= 100000 ? start + frame.delayUs / 1000 : 0 })
    } catch (error) { fail(error instanceof Error ? error.message : 'CPU 视频帧生产失败') }
  }
  const snapshot = (consume: boolean): NativePlaybackState => ({ ...(consume ? native.state() : native.inspect()),
    rendererFullscreenControls: true, nativeVideoFocused: false, sharedTextureSurface: surfaceToken,
    displayProbe: 'not-applicable', presentedFrames: undefined, submittedFrames: submitted, frameTimeline: timeline })
  return {
    create(_handle: Buffer, bounds: Bounds): void {
      native.create({ ...bounds, scale: bounds.scale ?? 1 }); stopped = false
      for (const [name, listener] of listeners) ipcMain.on(name, listener)
      contents.on('destroyed', gone); contents.on('render-process-gone', gone); contents.on('did-start-navigation', navigation)
      timer = setInterval(poll, 8); timer.unref()
    },
    setBounds(bounds: Bounds): void {
      const next = `${bounds.width}:${bounds.height}:${bounds.scale ?? 1}`
      if (next !== dimensions) { dimensions = next; native.setBounds({ ...bounds, scale: bounds.scale ?? 1 }); flush() }
    },
    setVisible(value: boolean): void { requested = value; visibility() },
    setPresentation(_value: string): void { /* Renderer owns controls and geometry. */ },
    command(args: string[], generated = false): void {
      native.command(args, generated)
      if (!generated && (['loadfile', 'seek', 'stop'].includes(args[0]) || args[0] === 'set' && ['pause', 'speed'].includes(args[1]))) flush()
    },
    generatedSubtitles: native.generatedSubtitles.bind(native),
    state(): NativePlaybackState { if (failure) throw failure; return snapshot(true) },
    inspect(): NativePlaybackState { if (failure) throw failure; return snapshot(false) },
    render(): void { if (failure) throw failure },
    destroy
  }
}
