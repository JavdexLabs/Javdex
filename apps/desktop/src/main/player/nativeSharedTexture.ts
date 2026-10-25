import { createFrameEndpoint } from './frameEndpoint'
import { app, ipcMain, sharedTexture, type BrowserWindow, type IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import type { NativePlaybackState } from './nativePlayback'
import { FrameBudget } from './frameBudget'
import { FrameHealthProbe } from './frameHealthProbe'
import { playbackFallbackReason, graphicsPlaybackFailure } from './playbackGraphicsFailure'
import type { WindowsPlaybackAdapter } from './playbackHostProtocol'

interface Bounds { width: number; height: number; scale?: number }
interface Binding { surfaceToken: string; bindingToken: string }
export interface SharedTextureProducer {
  create(bounds: Bounds, windowsAdapter?: WindowsPlaybackAdapter): void
  setBounds(bounds: Bounds): void
  setVisible(visible: boolean): void
  resetTiming(timeline: number): void
  setRenderBudget(ms: number): void
  setWakeup(callback: (() => void) | null): void
  nextFrame(): unknown
  requestSelfTest(): void
  releaseFrame(sequence: number): void
  command(args: string[], generated?: boolean): void
  generatedSubtitles(operation: 'update' | 'visible' | 'clear', document: string, visible: boolean, revision: number): void
  state(): NativePlaybackState
  inspect(): NativePlaybackState
  destroy(): void
}
interface Frame {
  sequence: number; timeline: number; width: number; height: number; ioSurface?: Buffer; ntHandle?: Buffer
  pixelFormat: 'bgra'; producerComplete: true; colorContract: 'bt709-srgb-rgb-full'
  renderStartUs: number; targetTimeUs: number
  selfTest?: 'solid-v1'
}
interface Lease {
  since: number
  released: boolean
  binding: string
  imported?: ReturnType<typeof sharedTexture.importSharedTexture>
  acknowledged: boolean
}
const monotonicMs = (): number => Number(process.hrtime.bigint()) / 1e6

/** Main-process-only native texture adapter. No pointer, HANDLE, decoder setting or
 * native command is exposed through the renderer binding interface. */
export function createNativeSharedTextureBridge(native: SharedTextureProducer, window: BrowserWindow, platform: 'darwin' | 'win32') {
  const label = platform === 'darwin' ? 'macOS' : 'Windows'
  if (!native || typeof native.setWakeup !== 'function') throw new Error(`${label} 播放运行库需更新，请重新构建并重启应用`)
  const handleKey = platform === 'darwin' ? 'ioSurface' : 'ntHandle'
  const transferChannel = platform === 'darwin' ? 'playback:mac-texture-transfer' : 'playback:windows-texture-transfer'
  const releaseChannel = platform === 'darwin' ? 'playback:mac-texture-released' : 'playback:windows-texture-released'
  const statistics = channel(`javdex.playback.${platform === 'darwin' ? 'mac' : 'windows'}-shared-texture.statistics`)
  const contents = window.webContents, surfaceToken = randomUUID()
  let stopped = true, requested = false, shown = false, timeline = 0, lastSequence = 0, lastSubmission = 0, submitted = 0
  let binding: Binding | null = null, failure: Error | undefined, waitingSince: number | null = null, lateness = 0
  let dimensions = '', timer: ReturnType<typeof setInterval> | undefined
  const pending = new Map<number, Lease>()
  const targets = new Map<number, { start: number; target: number }>()
  const budget = new FrameBudget()
  const probe = new FrameHealthProbe()
  // Main-process pull-only diagnostics. Reuse the normal counters; no extra
  // per-frame IPC/listener, native handle or media locator enters this seam.
  const reportStatistics = (request: unknown): void => {
    if (!request || typeof request !== 'object') return
    try { Object.assign(request, { submittedFrames: submitted, pendingFrames: pending.size,
      frameTimeline: timeline, renderBudgetMs: budget.value, submissionLatenessMs: lateness }) }
    catch { /* Diagnostics cannot fail playback, including frozen requests. */ }
  }
  const { matches, clock } = createFrameEndpoint(contents, surfaceToken, () => !stopped, monotonicMs)
  const flush = (): void => {
    targets.clear()
    budget.reset(); native.setRenderBudget(budget.value)
    native.resetTiming(++timeline)
    if (binding && !contents.isDestroyed()) contents.send('playback:frame-flush', { ...binding, timeline })
  }
  const visibility = (): void => {
    if (stopped) return
    const next = requested && binding !== null
    if (next === shown) return
    if (next && probe.state === 'pending') { probe.reset(); native.requestSelfTest() }
    flush(); native.setVisible(next); shown = next
  }
  const ready = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !matches(event, value)) return
    if (binding?.bindingToken !== value.bindingToken) {
      probe.reset()
      if (shown) native.requestSelfTest()
    }
    binding = { surfaceToken, bindingToken: value.bindingToken }
    if (timeline) contents.send('playback:frame-flush', { ...binding, timeline })
    visibility()
  }
  const removed = (event: IpcMainEvent, value: unknown): void => {
    if (!matches(event, value) || value.bindingToken !== binding?.bindingToken) return
    binding = null; visibility()
  }
  const drawn = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !shown || !matches(event, value) || value.bindingToken !== binding?.bindingToken) return
    const receipt = value as Binding & { sequence: number; timeline: number; readyTime?: number; submittedTime?: number }
    if (receipt.timeline !== timeline || !Number.isSafeInteger(receipt.sequence) || receipt.sequence <= lastSubmission || receipt.sequence > lastSequence) return
    lastSubmission = receipt.sequence; submitted++
    const target = targets.get(receipt.sequence); targets.delete(receipt.sequence)
    if (target && typeof receipt.submittedTime === 'number' && Number.isFinite(receipt.submittedTime)
      && typeof receipt.readyTime === 'number' && Number.isFinite(receipt.readyTime)
      && receipt.readyTime >= target.start && receipt.submittedTime >= receipt.readyTime
      && receipt.submittedTime <= monotonicMs() + 10 && monotonicMs() - receipt.submittedTime < 1000) {
      lateness = receipt.submittedTime - target.target
      const next = budget.observe(receipt.readyTime - target.start, monotonicMs())
      if (next !== undefined) native.setRenderBudget(next)
    }
  }
  const destroy = (): void => {
    if (stopped) return
    stopped = true; clearInterval(timer)
    statistics.unsubscribe(reportStatistics)
    try {
      if (binding && !contents.isDestroyed()) contents.send('playback:frame-flush', { ...binding, timeline: ++timeline })
    } catch { /* A disposed/crashed frame must not prevent native teardown. */ }
    for (const [name, listener] of listeners) ipcMain.removeListener(name, listener)
    contents.removeListener('did-start-navigation', navigation)
    contents.removeListener('render-process-gone', gone); contents.removeListener('destroyed', gone)
    app.removeListener('child-process-gone', childGone)
    binding = null; targets.clear()
    if (pending.size === 0) ipcMain.removeListener(releaseChannel, consumerReleased)
    // Do not release/recycle consumer-held textures here. Each callback below
    // retains its original ticket, including after destroy or another create.
    try { native.setWakeup(null) } finally { native.destroy() }
  }
  const fail = (message: string, kind: 'graphics' | 'page' = 'graphics', reason = 'GPU_RUNTIME_FAILED'): void => {
    if (!stopped) {
      console.warn('[playback-frame-failure]', platform, kind, reason)
      // Keep the failure domain in the main process: localized transport text
      // must not hide a graphics fault from the independent CPU recovery path.
      failure = Object.assign(new Error(message), { code: 'PLAYBACK_RESTART_REQUIRED', playbackFailureKind: kind,
        ...(kind === 'graphics' ? { playbackFailureCode: playbackFallbackReason(graphicsPlaybackFailure(reason), 'GPU_RUNTIME_FAILED') } : {}) })
      try { destroy() } catch { console.warn('[playback] failed graphics resources retained until exit') }
    }
  }
  const receiverFailed = (event: IpcMainEvent, value: unknown): void => {
    if (matches(event, value) && value.bindingToken === binding?.bindingToken) fail(`${label} 共享视频帧消费失败`)
  }
  const selfTest = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !matches(event, value) || binding?.bindingToken !== value.bindingToken) return
    try { probe.receive(value as Binding & { sequence?: unknown; samples?: unknown }) }
    catch { fail('共享视频合成色块自检失败', 'graphics', 'DISPLAY_SELF_TEST_FAILED') }
  }
  const gone = (): void => fail('播放器页面已关闭，请重启应用后重试', 'page')
  const navigation = (_event: unknown, _url: string, inPlace: boolean, main: boolean): void => { if (main && !inPlace) gone() }
  const childGone = (_event: unknown, details: { type: string }): void => { if (details.type === 'GPU') fail('GPU 进程已退出，请重启应用后重试', 'graphics', 'GPU_PROCESS_EXITED') }
  const consumerReleased = (event: IpcMainEvent, value: unknown): void => {
    if (!matches(event, value)) return
    const sequence = (value as Binding & { sequence: number }).sequence
    const owner = pending.get(sequence)
    if (!owner || owner.binding !== value.bindingToken || owner.acknowledged) return
    owner.acknowledged = true
    // The sandbox preload sends this only from subtle.release's GPU-complete
    // callback. A Canvas submission or transfer receipt cannot free the slot.
    try { owner.imported?.release() } catch { fail(`${label} 共享纹理引用释放失败`) }
  }
  // IPC callbacks run outside PlaybackEngine's command/read recovery boundary.
  // Store host failures for its next read instead of throwing into Electron.
  const guarded = (listener: (event: IpcMainEvent, value: unknown) => void) => (event: IpcMainEvent, value: unknown): void => {
    try { listener(event, value) }
    catch (error) { fail(`${label} 共享视频通道失败`, 'graphics', playbackFallbackReason(error, 'FRAME_CHANNEL_FAILED')) }
  }
  const listeners: Array<[string, (event: IpcMainEvent, value: unknown) => void]> = [
    ['playback:shared-texture-ready', guarded(ready)], ['playback:shared-texture-removed', guarded(removed)],
    ['playback:shared-texture-failed', receiverFailed], ['playback:frame-clock', guarded(clock)], ['playback:shared-texture-submitted', guarded(drawn)],
    ['playback:shared-texture-self-test', selfTest]
  ]
  const publish = (frame: Frame, target: Binding): void => {
    let imported: ReturnType<typeof sharedTexture.importSharedTexture> | undefined
    let transferStarted = false
    const owner: Lease = {
      since: Date.now(), released: false, binding: target.bindingToken, acknowledged: false }
    pending.set(frame.sequence, owner)
    try {
      imported = sharedTexture.importSharedTexture({ textureInfo: { codedSize: { width: frame.width, height: frame.height }, pixelFormat: 'bgra',
        colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
        handle: { [handleKey]: frame[handleKey] } }, allReferencesReleased: () => {
        if (owner.released) return
        owner.released = true; pending.delete(frame.sequence)
        try { native.releaseFrame(frame.sequence) } catch { fail(`${label} 共享纹理引用释放失败`) }
        finally { if (stopped && pending.size === 0) ipcMain.removeListener(releaseChannel, consumerReleased) }
      } })
      owner.imported = imported
      // Documented low-level transfer avoids sendSharedTexture's fixed 1s
      // timeout, which loses tracking if the renderer imports a late message.
      const transfer = imported.subtle.startTransferSharedTexture()
      transferStarted = true
      contents.send(transferChannel, {
        ...target, sequence: frame.sequence, timeline: frame.timeline, targetTime: frame.targetTimeUs / 1000,
        colorContract: frame.colorContract, ...(frame.selfTest ? { selfTest: frame.selfTest } : {}), transfer
      })
    } catch {
      // Once a transferable exists, a delivery exception does not prove that
      // the consumer cannot acquire it. Quarantine rather than recycle it.
      if (imported && !transferStarted) imported.release()
      else if (!imported && !owner.released) { owner.released = true; pending.delete(frame.sequence); native.releaseFrame(frame.sequence) }
      fail(`${label} 共享纹理导入或传输失败，请重启应用后重试`, 'graphics', 'TEXTURE_IMPORT_FAILED')
    }
  }
  const poll = (): void => {
    if (stopped) return
    try {
      probe.tick(shown, Date.now())
      if (shown && pending.size >= 3 && [...pending.values()].every(p => Date.now() - p.since > 5000))
        throw graphicsPlaybackFailure('FRAME_RELEASE_TIMEOUT')
      if (requested && (!binding || lastSequence === 0)) {
        waitingSince ??= Date.now()
        if (Date.now() - waitingSince > 10000) throw graphicsPlaybackFailure('RECEIVER_NOT_READY')
      } else waitingSince = null
      // Pump mpv events even when hidden. The native producer drops updates but
      // never overwrites one of its three consumer-held surfaces.
      const value = native.nextFrame()
      if (!value) return
      const f = value as Frame
      // A malformed newly exported lease is still ours until import. Never
      // release a duplicate consumer-held ticket based on untrusted metadata.
      const fresh = Number.isSafeInteger(f.sequence) && f.sequence > lastSequence
      const invalid = (): never => {
        console.warn('[playback-frame-metadata]', { sequence: f.sequence, timeline: f.timeline, width: f.width, height: f.height,
          leadMs: f.targetTimeUs / 1000 - monotonicMs(), pending: pending.size, selfTest: f.selfTest })
        if (fresh) native.releaseFrame(f.sequence)
        throw new Error('Invalid native shared texture frame metadata')
      }
      if (pending.size >= 3) invalid()
      if (!Number.isSafeInteger(f.sequence) || f.sequence <= lastSequence || !Number.isSafeInteger(f.timeline)
        || !Number.isSafeInteger(f.width) || !Number.isSafeInteger(f.height) || f.width < 1 || f.height < 1 || f.width > 8192 || f.height > 8192
        || f.width * f.height * 4 > 256 * 1024 * 1024 || !Buffer.isBuffer(f[handleKey]) || f[handleKey]!.length !== 8
        || f[platform === 'darwin' ? 'ntHandle' : 'ioSurface'] !== undefined
        || f.pixelFormat !== 'bgra' || f.producerComplete !== true || f.colorContract !== 'bt709-srgb-rgb-full'
        || f.selfTest !== undefined && f.selfTest !== 'solid-v1'
        || !Number.isSafeInteger(f.targetTimeUs) || f.targetTimeUs < 0 || !Number.isSafeInteger(f.renderStartUs) || f.renderStartUs < 1
        || f.targetTimeUs > (monotonicMs() + 100) * 1000) invalid()
      lastSequence = f.sequence
      if (!shown || !binding || !f.selfTest && f.timeline !== timeline) { native.releaseFrame(f.sequence); return }
      if (f.selfTest && !probe.exported(f.sequence, binding.bindingToken, f.width, f.height)) { native.releaseFrame(f.sequence); return }
      if (f.targetTimeUs) {
        if (targets.size >= 120) targets.delete(targets.keys().next().value!)
        targets.set(f.sequence, { start: f.renderStartUs / 1000, target: f.targetTimeUs / 1000 })
      }
      publish(f, binding)
    } catch (error) {
      console.warn('[playback-frame-error]', error)
      fail(`${label} 共享视频生产失败，请重启应用后重试`, 'graphics', playbackFallbackReason(error, 'FRAME_RENDER_FAILED'))
    }
  }
  const snapshot = (consume: boolean): NativePlaybackState => ({ ...(consume ? native.state() : native.inspect()),
    sharedTextureSurface: surfaceToken,
    displayProbe: probe.state, presentedFrames: undefined, submittedFrames: submitted, frameTimeline: timeline, renderBudgetMs: budget.value, submissionLatenessMs: lateness })
  return {
    create(bounds: Bounds): void {
      if (typeof sharedTexture?.importSharedTexture !== 'function') throw new Error(`Electron 不支持 ${label} 共享纹理`)
      stopped = false
      native.create({ ...bounds, scale: bounds.scale ?? 1 })
      statistics.subscribe(reportStatistics)
      for (const [name, listener] of listeners) ipcMain.on(name, listener)
      ipcMain.on(releaseChannel, consumerReleased)
      contents.on('did-start-navigation', navigation); contents.on('render-process-gone', gone); contents.on('destroyed', gone)
      app.on('child-process-gone', childGone)
      native.setWakeup(poll)
      // Frames, non-video events and released slots wake the main loop. This
      // low-rate fallback also keeps fault/deadline checks alive while idle;
      // it never sets a maximum video frame cadence.
      timer = setInterval(poll, 250); timer.unref()
    },
    setBounds(bounds: Bounds): void {
      const next = `${Math.round(bounds.width * (bounds.scale ?? 1))}:${Math.round(bounds.height * (bounds.scale ?? 1))}`
      if (next !== dimensions) { dimensions = next; native.setBounds({ ...bounds, scale: bounds.scale ?? 1 }); flush() }
    },
    setVisible(value: boolean): void {
      if (requested !== value) waitingSince = value ? Date.now() : null
      requested = value; visibility()
    },
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
