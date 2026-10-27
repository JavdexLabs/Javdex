import { createFrameEndpoint, isFrameBinding as validBinding } from './frameEndpoint'
import { app, ipcMain, sharedTexture, type BrowserWindow, type IpcMainEvent, type SharedTextureImported } from 'electron'
import { randomUUID } from 'node:crypto'
import { channel as diagnosticChannel } from 'node:diagnostics_channel'
import { FrameHealthProbe } from './frameHealthProbe'
import { createRequire } from 'node:module'
import type { NativePlaybackState } from './nativePlayback'

const READY = 'playback:shared-texture-ready'
const REMOVED = 'playback:shared-texture-removed'
const FAILED = 'playback:shared-texture-failed'
const DRAWN = 'playback:shared-texture-submitted'
const CPU_RELEASED = 'playback:cpu-frame-released'
const CLOCK = 'playback:frame-clock'
const monoMs = (): number => Number(process.hrtime.bigint()) / 1e6
const SELF_TEST = 'playback:shared-texture-self-test'
const TRANSFER = 'playback:linux-texture-transfer'
const RELEASED = 'playback:linux-texture-released'
const PIXELS = 'playback:shared-texture-pixel-diagnostic'
const POOL_SIZE = 3
const RELEASE_TIMEOUT = 5000
const READY_TIMEOUT = 10000
const READABLE = 1, WRITABLE = 2 // libuv uv_poll_event flags, private to the FD bridge.
interface FramePacket { metadata: Buffer; fd: number }
interface FdBridge {
  createChannel(): { parentFd: number; childFd: number }
  receive(fd: number): FramePacket | null
  sendAck(fd: number, sequence: number): boolean
  readPixels(fd: number, size: number): Buffer
  watch(fd: number, events: number, callback: (status: number, events: number) => void): boolean
  updateWatch(fd: number, events: number): boolean
  unwatch(fd: number): boolean
  close(fd: number): void
}
interface DmaBufFrame {
  protocol: 'javdex-dmabuf-v1'
  selfTest?: 'solid-v1'
  sequence: number
  slot: number
  width: number
  height: number
  pixelFormat: 'bgra' | 'rgba'
  stride: number
  offset: number
  size: number
  modifier: string
  timeline?: number
  targetTimeUs?: number
  renderStartUs?: number
  producerComplete: true
  colorContract?: 'bt709-srgb-rgb-full'
}
interface SurfaceBinding { surfaceToken: string; bindingToken: string }
interface PendingFrame { slot: number; fd: number | null; since: number; released: boolean }
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
function validTiming(value: { timeline?: unknown; targetTimeUs?: unknown; renderStartUs?: unknown }): boolean {
  return (value.timeline === undefined || integer(value.timeline, 0, Number.MAX_SAFE_INTEGER))
    && ((value.targetTimeUs === undefined && value.renderStartUs === undefined)
      || integer(value.timeline, 0, Number.MAX_SAFE_INTEGER) && integer(value.targetTimeUs, 0, Number.MAX_SAFE_INTEGER)
        && integer(value.renderStartUs, 1, Number.MAX_SAFE_INTEGER))
}

/** Only the helper's one-plane RGBA/BGRA protocol is supported. No arbitrary
 * native handles, pixel layouts or GPU commands are accepted from a renderer. */
export function decodeDmaBufFrame(metadata: Buffer): DmaBufFrame {
  if (!Buffer.isBuffer(metadata) || metadata.length > 4096) throw new Error('无效的共享视频帧元数据')
  const value = JSON.parse(metadata.toString('utf8')) as DmaBufFrame | null
  if (!value || value.protocol !== 'javdex-dmabuf-v1'
    || value.selfTest !== undefined && (value.selfTest !== 'solid-v1' || value.width !== 640 || value.height !== 360)
    || !integer(value.sequence, 1, Number.MAX_SAFE_INTEGER) || !integer(value.slot, 0, POOL_SIZE - 1)
    || !integer(value.width, 1, 8192) || !integer(value.height, 1, 8192)
    || !['bgra', 'rgba'].includes(value.pixelFormat)
    || !integer(value.stride, value.width * 4, 131072)
    || !integer(value.offset, 0, 1073741824) || !integer(value.size, 1, 1073741824)
    || value.offset + value.stride * value.height > value.size
    || typeof value.modifier !== 'string' || !/^[0-9]{1,20}$/.test(value.modifier)
    || !validTiming(value)
    || value.colorContract !== undefined && value.colorContract !== 'bt709-srgb-rgb-full'
    || BigInt(value.modifier) > 0xffffffffffffffffn || value.producerComplete !== true) {
    throw new Error('无效的共享视频帧元数据')
  }
  return value
}
export function decodeCpuFrame(metadata: Buffer) {
  if (!Buffer.isBuffer(metadata) || metadata.length > 4096) throw new Error('无效的 CPU 帧元数据')
  const v = JSON.parse(metadata.toString('utf8')) as Record<string, unknown>
  if (!v || v.protocol !== 'javdex-cpu-v1' || v.pixelFormat !== 'rgba'
    || !integer(v.sequence, 1, Number.MAX_SAFE_INTEGER) || !integer(v.slot, 0, 2)
    || !integer(v.width, 1, 8192) || !integer(v.height, 1, 8192)
    || !integer(v.stride, v.width * 4, 32768) || v.stride % 64 !== 0
    || !integer(v.size, 4, 256 * 1024 * 1024) || v.size !== v.stride * v.height || !validTiming(v)
    || v.colorContract !== undefined && v.colorContract !== 'bt709-srgb-rgb-full')
    throw new Error('无效的 CPU 帧元数据')
  return v as { sequence: number; slot: number; width: number; height: number; stride: number; size: number;
    timeline?: number; targetTimeUs?: number; renderStartUs?: number; colorContract?: 'bt709-srgb-rgb-full' }
}
import { FrameBudget } from './frameBudget'

/** One manager belongs to one helper lifetime. Its token is published only in
 * the matching playback snapshot; neither socket nor DMA-BUF FDs cross IPC. */
export function createLinuxSharedTexture(window: BrowserWindow, addonPath: string, onError: (error: Error) => void, software = false) {
  if (!software && typeof sharedTexture?.importSharedTexture !== 'function') {
    throw new Error('当前 Electron 不支持共享视频纹理')
  }
  const transport = createRequire(addonPath)(addonPath) as FdBridge
  if (typeof transport.watch !== 'function' || typeof transport.updateWatch !== 'function' || typeof transport.unwatch !== 'function')
    throw new Error('Linux 帧传输运行库需更新，请重新构建播放运行库')
  const channel = transport.createChannel()
  const surfaceToken = (software ? 'cpu:' : '') + randomUUID()
  let parentFd: number | null = channel.parentFd
  let childFd: number | null = channel.childFd
  let stopped = false
  let visible = false
  let binding: SurfaceBinding | null = null
  let readyChanged: (() => void) | undefined, requestProbe: (() => void) | undefined
  let waitingSince: number | null = null
  let lastSequence = 0
  let lastDrawnSequence = 0
  let drawnFrames = 0
  const probe = new FrameHealthProbe()
  const budget = new FrameBudget()
  const stages: Record<string, { samples: number; totalMs: number; maxMs: number }> = {}
  const observeStage = (name: string, ms: number): void => {
    if (!Number.isFinite(ms) || ms < 0 || ms > RELEASE_TIMEOUT) return
    const s = stages[name] ??= { samples: 0, totalMs: 0, maxMs: 0 }
    s.samples++; s.totalMs += ms; s.maxMs = Math.max(s.maxMs, ms)
  }
  let setBudget: ((ms: number) => void) | undefined
  const timings = new Map<number, { start: number; target: number; binding: string }>()
  let lastLatenessMs = 0
  let timeline = 0
  const pixelDiagnostics = process.env.JAVDEX_TEXTURE_PIXEL_DIAGNOSTICS === '1'
  let diagnosticFrames = 0
  if (pixelDiagnostics) {
    console.info('[playback-texture-pixels-enabled]')
    console.info('[playback-color-contract]', 'BT.709 primaries / sRGB transfer / full-range SDR, static BT.2390 at 203 nit')
  }
  const diagnosticSequences = new Set<number>()
  let saturatedSince: number | null = null
  const pending = new Map<number, PendingFrame>()
  // Keep main references until the sandbox preload's GPU-complete callback.
  // Delivery failures are ambiguous; retain at most the three leased surfaces,
  // including late imports/releases after this producer has been terminated.
  const transfers = new Map<number, { imported: SharedTextureImported; binding: string;
    frame: BrowserWindow['webContents']['mainFrame']; acknowledged: boolean }>()
  let retiredTimer: ReturnType<typeof setInterval> | undefined
  let documentChanging = false, documentReplaced = false
  const lifecycle = diagnosticChannel('javdex.playback.linux-texture.statistics')
  const reportLifecycle = (request: unknown): void => {
    if (!request || typeof request !== 'object') return
    try {
      const value = request as { owners?: unknown[] }
      if (Array.isArray(value.owners)) value.owners.push({ mode: software ? 'cpu' : 'gpu', stopped,
        pendingFrames: pending.size, transferredFrames: transfers.size })
    } catch { /* A read-only/frozen diagnostic request must not fail playback. */ }
  }
  lifecycle.subscribe(reportLifecycle)
  const clearRetired = (): void => {
    clearInterval(retiredTimer)
    contents.removeListener('did-start-navigation', retiredNavigation)
    contents.removeListener('dom-ready', retiredDocumentReady)
    ipcMain.removeListener(RELEASED, consumerReleased)
    lifecycle.unsubscribe(reportLifecycle)
  }
  const retireDestroyedFrames = (): void => {
    if (!stopped) return
    for (const value of transfers.values()) {
      if (value.acknowledged || !documentReplaced && !contents.isDestroyed() && !value.frame.isDestroyed()) continue
      value.acknowledged = true
      // The producer is already stopped and never ACKed. A destroyed target
      // cannot acquire a queued transfer; drop only our reference. Existing GPU
      // references own their allocation independently. This never permits reuse.
      try { value.imported.release() } catch { /* Retain ambiguous resources until process exit. */ }
    }
  }
  const retiredNavigation = (_event: unknown, _url: string, inPlace: boolean, main: boolean): void => {
    if (main && !inPlace) documentChanging = true
  }
  const retiredDocumentReady = (): void => {
    // Reload can reuse the same RenderFrameHost. New Linux preloads discard
    // unmatched transfers before import, so old queued messages cannot acquire
    // a resource after its retired producer's main reference is dropped.
    if (stopped && documentChanging) { documentReplaced = true; retireDestroyedFrames() }
  }
  const acknowledgements: number[] = []
  let interest = 0, pumping = false
  const transportStats = { wakeups: 0, receiveAttempts: 0, packets: 0, blockedAcks: 0, watchdogTicks: 0 }
  const contents = window.webContents
  const { trusted, clock } = createFrameEndpoint(contents, surfaceToken, () => !stopped, monoMs)
  const closeFrame = (entry: PendingFrame): void => {
    if (entry.fd === null) return
    const fd = entry.fd; entry.fd = null
    transport.close(fd)
  }
  const spawned = (): void => {
    if (childFd === null) return
    const fd = childFd; childFd = null
    transport.close(fd)
  }
  const destroy = (): void => {
    if (stopped) return
    stopped = true
    try {
      if (binding && !contents.isDestroyed()) contents.send('playback:frame-flush', { ...binding, timeline: ++timeline })
    } catch { /* A disposed frame must not prevent descriptor cleanup or owner notification. */ }
    clearInterval(timer)
    for (const [name, listener] of listeners) ipcMain.removeListener(name, listener)
    contents.removeListener('did-start-navigation', navigation)
    contents.removeListener('render-process-gone', rendererGone)
    contents.removeListener('destroyed', rendererGone)
    app.removeListener('child-process-gone', childGone)
    binding = null
    if (parentFd !== null) {
      const fd = parentFd; parentFd = null
      try { transport.unwatch(fd) } catch { /* close() also stops an owned poll before closing the descriptor. */ }
      transport.close(fd)
    }
    spawned()
    // Fail closed: the owner terminates the producer, and no buffer is ACKed or
    // reused. Electron owns its imported resource references independently.
    // Close our descriptor copies even if a crashed GPU never calls us back.
    for (const entry of pending.values()) closeFrame(entry)
    pending.clear(); timings.clear(); acknowledgements.length = 0
    if (transfers.size === 0) {
      clearRetired()
    } else {
      contents.on('did-start-navigation', retiredNavigation)
      contents.on('dom-ready', retiredDocumentReady)
      retiredTimer = setInterval(retireDestroyedFrames, 1000)
      retiredTimer.unref()
      retireDestroyedFrames()
    }
  }
  const fail = (message: string, kind: 'graphics' | 'page' = 'graphics'): void => {
    if (stopped) return
    try { destroy() } catch { console.warn('[playback] failed Linux frame resources retained until exit') }
    onError(Object.assign(new Error(message), { playbackFailureKind: software ? 'cpu' : kind }))
  }
  const ready = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !trusted(event) || !validBinding(value) || value.surfaceToken !== surfaceToken) return
    if (!software && binding?.bindingToken !== value.bindingToken) { probe.reset(); requestProbe?.() }
    binding = { surfaceToken, bindingToken: value.bindingToken }; waitingSince = null
    if (timeline) contents.send('playback:frame-flush', { ...binding, timeline })
    readyChanged?.(); refreshInterest()
  }
  const removed = (event: IpcMainEvent, value: unknown): void => {
    if (!trusted(event) || !validBinding(value) || value.surfaceToken !== surfaceToken || value.bindingToken !== binding?.bindingToken) return
    if (software) for (const [sequence, entry] of pending) {
      if (!entry.released) { entry.released = true; entry.since = Date.now(); queueAck(sequence) }
    }
    binding = null; waitingSince = visible ? Date.now() : null
    readyChanged?.(); refreshInterest()
  }
  const receiverFailed = (event: IpcMainEvent, value: unknown): void => {
    if (trusted(event) && validBinding(value) && value.surfaceToken === surfaceToken && value.bindingToken === binding?.bindingToken) {
      fail('共享视频画面接收失败，请停止后重试')
    }
  }
  const drawn = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !visible || !trusted(event) || !validBinding(value) || value.surfaceToken !== surfaceToken
      || value.bindingToken !== binding?.bindingToken) return
    const receiptTimeline = (value as SurfaceBinding & { timeline?: unknown }).timeline ?? 0
    if (receiptTimeline !== timeline) return
    const sequence = (value as SurfaceBinding & { sequence?: unknown }).sequence
    if (!integer(sequence, lastDrawnSequence + 1, lastSequence)) return
    lastDrawnSequence = sequence
    // A renderer submission receipt is delivery to the page, not screen scanout.
    // Neither helper export nor sendSharedTexture resolution counts.
    drawnFrames++
    const timing = timings.get(sequence)
    timings.delete(sequence)
    if (timing && timing.binding === binding?.bindingToken) {
      const receipt = value as SurfaceBinding & { readyTime?: number; submissionStartedTime?: number; submittedTime?: number }
      const now = monoMs()
      if (typeof receipt.readyTime === 'number' && typeof receipt.submittedTime === 'number'
        && Number.isFinite(receipt.readyTime) && Number.isFinite(receipt.submittedTime)
        && receipt.readyTime >= timing.start && receipt.submittedTime >= receipt.readyTime
        && receipt.submittedTime <= now + 10 && now - receipt.submittedTime < 1000) {
        lastLatenessMs = receipt.submittedTime - timing.target
        observeStage('producerToReady', receipt.readyTime - timing.start)
        observeStage('producerToSubmitted', receipt.submittedTime - timing.start)
        if (typeof receipt.submissionStartedTime === 'number' && Number.isFinite(receipt.submissionStartedTime)
          && receipt.submissionStartedTime >= receipt.readyTime && receipt.submissionStartedTime <= receipt.submittedTime) {
          observeStage('rendererWait', receipt.submissionStartedTime - receipt.readyTime)
          observeStage('rendererSubmit', receipt.submittedTime - receipt.submissionStartedTime)
        }
        const next = budget.observe(receipt.readyTime - timing.start, now)
        if (next !== undefined) setBudget?.(next)
      }
    }
  }
  const cpuReleased = (event: IpcMainEvent, value: unknown): void => {
    if (!software || stopped || !trusted(event) || !validBinding(value) || value.surfaceToken !== surfaceToken
      || value.bindingToken !== binding?.bindingToken) return
    const sequence = (value as SurfaceBinding & { sequence?: unknown }).sequence
    if (!integer(sequence, 1, lastSequence)) return
    const entry = pending.get(sequence)
    if (!entry || entry.released) return
    entry.released = true; entry.since = Date.now(); timings.delete(sequence); queueAck(sequence)
  }
  const recordTiming = (frame: { sequence: number; targetTimeUs?: number; renderStartUs?: number }, target: SurfaceBinding): void => {
    const now = monoMs()
    if (frame.targetTimeUs && (frame.targetTimeUs / 1000 > now + 100 || frame.renderStartUs! / 1000 > now + 10)) throw new Error('Invalid frame clock')
    if (frame.targetTimeUs) {
      if (timings.size >= 120) timings.delete(timings.keys().next().value!)
      timings.set(frame.sequence, { start: frame.renderStartUs! / 1000, target: frame.targetTimeUs / 1000, binding: target.bindingToken })
    }
  }
  const selfTest = (event: IpcMainEvent, value: unknown): void => {
    if (software || stopped || !trusted(event) || !validBinding(value)
      || value.surfaceToken !== surfaceToken || value.bindingToken !== binding?.bindingToken) return
    try { if (probe.receive(value as SurfaceBinding & { sequence?: unknown; samples?: unknown }))
      console.info('[playback-display-self-test] passed (readback; not scanout proof)') }
    catch { fail('共享视频合成色块自检失败') }
  }
  const pixels = (event: IpcMainEvent, value: unknown): void => {
    if (!pixelDiagnostics || stopped || !trusted(event) || !validBinding(value)
      || value.surfaceToken !== surfaceToken || value.bindingToken !== binding?.bindingToken) return
    const data = value as SurfaceBinding & Record<string, unknown>
    if (typeof data.sequence !== 'number' || !diagnosticSequences.delete(data.sequence)) return
    // Project only bounded numbers/booleans. Never log arbitrary renderer strings.
    const result: Record<string, unknown> = { sequence: data.sequence, readbackPerturbsRendering: true }
    for (const name of ['canvas', 'imported', 'geometry']) {
      const input = data[name]
      if (!input || typeof input !== 'object') continue
      const projected: Record<string, number | boolean> = {}
      for (const key of ['samples', 'nonblack', 'maximum', 'opaque', 'width', 'height', 'connected', 'displayed', 'visible', 'opacity']) {
        const item = (input as Record<string, unknown>)[key]
        if (typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 100000) projected[key] = item
      }
      result[name] = projected
    }
    for (const key of ['canvasError', 'importedError']) if (data[key] === true) result[key] = true
    console.info('[playback-texture-pixels]', JSON.stringify(result))
  }
  const navigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
    if (isMainFrame && !isInPlace) { documentChanging = true; fail('播放器页面已重新加载，请重新打开视频', 'page') }
  }
  const rendererGone = (): void => fail('播放器页面已关闭，请重新打开视频', 'page')
  const childGone = (_event: unknown, details: { type: string }): void => {
    if (!software && details.type === 'GPU') fail('GPU 进程已退出，请重新打开视频')
  }
  const consumerReleased = (event: IpcMainEvent, value: unknown): void => {
    if (!trusted(event) || !validBinding(value) || value.surfaceToken !== surfaceToken) return
    const sequence = (value as SurfaceBinding & { sequence?: unknown }).sequence
    if (!integer(sequence, 1, lastSequence)) return
    const transfer = transfers.get(sequence)
    if (!transfer || transfer.binding !== value.bindingToken || transfer.acknowledged) return
    transfer.acknowledged = true
    try { transfer.imported.release() } catch { fail('共享视频纹理释放失败，请停止后重试') }
  }
  const importFrame = (packet: FramePacket, target: SurfaceBinding): void => {
    let imported: SharedTextureImported | undefined
    let transferStarted = false
    let entry: PendingFrame | undefined
    try {
      if (software) {
        const frame = decodeCpuFrame(packet.metadata)
        if (frame.sequence <= lastSequence || pending.size >= POOL_SIZE || [...pending.values()].some(v => v.slot === frame.slot))
          throw new Error('CPU 帧池所有权无效')
        entry = { slot: frame.slot, fd: packet.fd, since: Date.now(), released: false }
        lastSequence = frame.sequence
        pending.set(frame.sequence, entry)
        if ((frame.timeline ?? 0) !== timeline) {
          closeFrame(entry); entry.released = true; queueAck(frame.sequence); return
        }
        recordTiming(frame, target)
        const readStarted = monoMs()
        const pixels = transport.readPixels(packet.fd, frame.size)
        observeStage('cpuRead', monoMs() - readStarted)
        closeFrame(entry)
        contents.send('playback:cpu-frame', { ...target, ...frame, timeline, targetTime: (frame.targetTimeUs ?? 0) / 1000, pixels })
        return
      }
      const frame = decodeDmaBufFrame(packet.metadata)
      if (frame.sequence <= lastSequence || pending.size >= POOL_SIZE || [...pending.values()].some(value => value.slot === frame.slot)) {
        throw new Error('共享视频帧池所有权无效')
      }
      recordTiming(frame, target)
      lastSequence = frame.sequence
      entry = { slot: frame.slot, fd: packet.fd, since: Date.now(), released: false }
      const owner = entry
      pending.set(frame.sequence, owner)
      if (!frame.selfTest && (frame.timeline ?? 0) !== timeline) {
        timings.delete(frame.sequence); closeFrame(owner); owner.released = true
        queueAck(frame.sequence)
        return
      }
      if (frame.selfTest) {
        if (!probe.exported(frame.sequence, target.bindingToken, frame.width, frame.height)) {
          timings.delete(frame.sequence); closeFrame(owner); owner.released = true; queueAck(frame.sequence); return
        }
      }
      const importStarted = monoMs()
      imported = sharedTexture.importSharedTexture({
        textureInfo: { pixelFormat: frame.pixelFormat, timestamp: frame.targetTimeUs || frame.renderStartUs,
          colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' }, codedSize: { width: frame.width, height: frame.height },
          handle: { nativePixmap: { planes: [{ fd: packet.fd, stride: frame.stride, offset: frame.offset, size: frame.size }],
            modifier: frame.modifier, supportsZeroCopyWebGpuImport: false } } },
        allReferencesReleased: () => {
          if (owner.released) return
          owner.released = true
          observeStage('gpuLease', monoMs() - importStarted)
          transfers.delete(frame.sequence)
          owner.since = Date.now()
          closeFrame(owner)
          if (stopped) {
            if (transfers.size === 0) {
              clearRetired()
            }
            return
          }
          // Sending is not a GPU fence. Only this cross-process release callback
          // permits the producer to render into this slot again.
          if (acknowledgements.length >= POOL_SIZE) { fail('共享视频帧确认队列超出限制'); return }
          queueAck(frame.sequence)
        }
      })
      observeStage('gpuImport', monoMs() - importStarted)
      transfers.set(frame.sequence, { imported, binding: target.bindingToken, frame: contents.mainFrame, acknowledged: false })
      const diagnosePixels = pixelDiagnostics && frame.width === 640 && frame.height === 360
        && [1, 16, 31].includes(++diagnosticFrames)
      if (diagnosePixels) diagnosticSequences.add(frame.sequence)
      // Unlike sendSharedTexture, this has no fixed 1s Promise.race that can
      // lose renderer reference tracking when import arrives after timeout.
      const transfer = imported.subtle.startTransferSharedTexture()
      transferStarted = true
      contents.send(TRANSFER, { ...target, sequence: frame.sequence, timeline,
        targetTime: (frame.targetTimeUs ?? 0) / 1000, colorContract: frame.colorContract, transfer,
        ...(frame.selfTest ? { selfTest: frame.selfTest } : {}), ...(diagnosePixels ? { diagnosePixels: true } : {}) })
    } catch {
      // Before transfer starts there can be no late consumer; afterwards a
      // delivery exception does not grant permission to recycle its texture.
      if (imported && !transferStarted) imported.release()
      if (!imported) {
        if (entry) closeFrame(entry)
        else transport.close(packet.fd)
      }
      fail(software ? 'CPU 视频帧读取或传输失败，请停止后重试' : '共享视频纹理导入或传输失败，请停止后重试')
    }
  }
  const guarded = (listener: (event: IpcMainEvent, value: unknown) => void) => (event: IpcMainEvent, value: unknown): void => {
    try { listener(event, value) } catch { fail('共享视频帧通道已中断，请停止后重试') }
  }
  const listeners: Array<[string, (event: IpcMainEvent, value: unknown) => void]> = [
    [READY, guarded(ready)], [REMOVED, guarded(removed)], [FAILED, receiverFailed], [DRAWN, guarded(drawn)],
    [CPU_RELEASED, cpuReleased], [CLOCK, guarded(clock)], [PIXELS, pixels], [SELF_TEST, selfTest]
  ]
  const refreshInterest = (): void => {
    if (stopped || parentFd === null) return
    const next = (visible && binding && pending.size < POOL_SIZE ? READABLE : 0)
      | (acknowledgements.length ? WRITABLE : 0)
    if (next === interest) return
    interest = next
    try { transport.updateWatch(parentFd, next) }
    catch { fail('共享视频帧通道已中断，请停止后重试') }
  }
  const queueAck = (sequence: number): void => {
    if (stopped) return
    if (acknowledgements.length >= POOL_SIZE) { fail('共享视频帧确认队列超出限制'); return }
    acknowledgements.push(sequence); refreshInterest()
  }
  const checkHealth = (): void => {
    const now = Date.now()
    // A paused display may retain a frame. Only a saturated pool or blocked
    // ACK is a stalled pool; the low-frequency watchdog never polls the socket.
    if (visible && pending.size === POOL_SIZE) saturatedSince ??= now
    else saturatedSince = null
    if (saturatedSince !== null && now - saturatedSince > RELEASE_TIMEOUT
      || acknowledgements.some(sequence => now - pending.get(sequence)!.since > RELEASE_TIMEOUT)) {
      fail('共享视频纹理释放超时，请停止后重试'); return
    }
    if (visible && !binding && waitingSince !== null && now - waitingSince > READY_TIMEOUT) {
      fail('等待视频画面接收器超时，请停止后重试'); return
    }
    if (!software) {
      try { probe.tick(visible && !!binding, now) }
      catch { fail('共享视频合成色块自检超时') }
    }
  }
  const pump = (): void => {
    if (stopped || parentFd === null || pumping) return
    pumping = true
    try {
      while (acknowledgements.length) {
        if (!transport.sendAck(parentFd, acknowledgements[0])) { transportStats.blockedAcks++; break }
        pending.delete(acknowledgements.shift()!)
      }
      checkHealth()
      // GPU metadata imports are cheap and bounded by three leases. A CPU
      // packet copies up to 256MiB; yield after one instead of batching copies.
      for (let count = 0; count < (software ? 1 : POOL_SIZE) && !stopped
        && parentFd !== null && visible && binding && pending.size < POOL_SIZE; count++) {
        transportStats.receiveAttempts++
        const packet = transport.receive(parentFd)
        if (!packet) break // EAGAIN/false readiness is normal.
        transportStats.packets++; importFrame(packet, binding)
      }
    } catch { fail('共享视频帧通道已中断，请停止后重试') }
    finally { pumping = false; refreshInterest() }
  }
  const timer = setInterval(() => {
    if (stopped) return
    transportStats.watchdogTicks++
    try { checkHealth() } catch { fail('共享视频帧通道已中断，请停止后重试') }
  }, 250)
  timer.unref()
  try {
    transport.watch(channel.parentFd, 0, status => {
      if (stopped) return
      transportStats.wakeups++
      if (status < 0) fail('共享视频帧通道已中断，请停止后重试')
      else pump()
    })
  } catch (error) { destroy(); throw error }
  for (const [name, listener] of listeners) ipcMain.on(name, listener)
  if (!software) ipcMain.on(RELEASED, consumerReleased)
  contents.on('did-start-navigation', navigation)
  contents.on('render-process-gone', rendererGone)
  contents.on('destroyed', rendererGone)
  app.on('child-process-gone', childGone)
  return { surfaceToken, childFd: channel.childFd, spawned, destroy, submittedFrames: (): number => drawnFrames,
    resetTiming(): number | undefined {
      if (stopped) return
      timeline++; timings.clear(); budget.reset(!software); setBudget?.(budget.value)
      if (!software && visible && binding && probe.state === 'pending') { probe.reset(); requestProbe?.() }
      if (binding) contents.send('playback:frame-flush', { ...binding, timeline })
      return timeline
    },
    displayProbe: () => software ? 'not-applicable' as const : probe.state,
    onReady(callback: () => void): void { readyChanged = callback },
    onProbe(callback: () => void): void { requestProbe = callback },
    timingStats: () => ({ renderBudgetMs: budget.value, submissionLatenessMs: lastLatenessMs, submittedFrames: drawnFrames,
      pendingFrames: pending.size, transferredFrames: transfers.size, transportStats: { ...transportStats },
      consumerTimings: Object.fromEntries(Object.entries(stages).map(([name, value]) => [name, { ...value }])) }),
    observeState: (state: NativePlaybackState): void => {
      if (software) return
      const next = budget.observeDrops(state['frame-drop-count'], visible && !state.pause && !state.seeking
        && !state['paused-for-cache'] && !state['eof-reached'], monoMs())
      if (next !== undefined) setBudget?.(next)
    },
    onBudget(callback: (ms: number) => void): void { setBudget = callback },
    isReady: (): boolean => !stopped && binding !== null,
    setVisible(value: boolean): void {
      if (stopped) return
      if (value && !visible && !binding) waitingSince = Date.now()
      if (!value) { waitingSince = null; saturatedSince = null; probe.tick(false, Date.now()) }
      visible = value; refreshInterest()
    } }
}
