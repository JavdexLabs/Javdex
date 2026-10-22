import { app, ipcMain, sharedTexture, type BrowserWindow, type IpcMainEvent, type SharedTextureImported } from 'electron'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const READY = 'playback:shared-texture-ready'
const REMOVED = 'playback:shared-texture-removed'
const FAILED = 'playback:shared-texture-failed'
const DRAWN = 'playback:shared-texture-submitted'
const CPU_RELEASED = 'playback:cpu-frame-released'
const CLOCK = 'playback:frame-clock'
const monoMs = (): number => Number(process.hrtime.bigint()) / 1e6
const SELF_TEST = 'playback:shared-texture-self-test'
const SELF_TEST_TIMEOUT = 8000
const PIXELS = 'playback:shared-texture-pixel-diagnostic'
const POOL_SIZE = 3
const RELEASE_TIMEOUT = 5000
const READY_TIMEOUT = 10000
interface FramePacket { metadata: Buffer; fd: number }
interface FdBridge {
  createChannel(): { parentFd: number; childFd: number }
  receive(fd: number): FramePacket | null
  sendAck(fd: number, sequence: number): boolean
  readPixels(fd: number, size: number): Buffer
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
  colorContract?: 'mpv-gpu-rgb-untagged'
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
    || value.colorContract !== undefined && value.colorContract !== 'mpv-gpu-rgb-untagged'
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
    || v.colorContract !== undefined && v.colorContract !== 'bt709-sdr-rgb-full')
    throw new Error('无效的 CPU 帧元数据')
  return v as { sequence: number; slot: number; width: number; height: number; stride: number; size: number;
    timeline?: number; targetTimeUs?: number; renderStartUs?: number; colorContract?: 'bt709-sdr-rgb-full' }
}
function validBinding(value: unknown): value is SurfaceBinding {
  if (!value || typeof value !== 'object') return false
  const binding = value as SurfaceBinding
  return typeof binding.surfaceToken === 'string' && binding.surfaceToken.length <= 64
    && typeof binding.bindingToken === 'string' && /^[\da-f-]{36}$/.test(binding.bindingToken)
}

/** Processing budget, not a display delay. Ignore immediate redraws and
 * outliers; update at most once per 2s/30 samples, with asymmetric slew limits. */
export class FrameBudget {
  value = 20
  private samples: number[] = []
  private updated = 0
  reset(): void { this.value = 20; this.samples = []; this.updated = 0 }
  observe(cost: number, now: number): number | undefined {
    if (!Number.isFinite(cost) || cost < 0 || cost > 100) return
    this.samples.push(cost)
    if (this.samples.length > 120) this.samples.shift()
    if (this.samples.length < 30 || now - this.updated < 2000) return
    this.updated = now
    const sorted = [...this.samples].sort((a, b) => a - b)
    const desired = Math.max(8, Math.min(40, Math.ceil(sorted[Math.floor(sorted.length * .95)] + 4)))
    if (Math.abs(desired - this.value) < 2) return
    this.value = Math.max(this.value - 1, Math.min(this.value + 2, desired))
    return this.value
  }
}

/** One manager belongs to one helper lifetime. Its token is published only in
 * the matching playback snapshot; neither socket nor DMA-BUF FDs cross IPC. */
export function createLinuxSharedTexture(window: BrowserWindow, addonPath: string, onError: (error: Error) => void, software = false) {
  if (!software && (typeof sharedTexture?.importSharedTexture !== 'function' || typeof sharedTexture.sendSharedTexture !== 'function')) {
    throw new Error('当前 Electron 不支持共享视频纹理')
  }
  const transport = createRequire(addonPath)(addonPath) as FdBridge
  const channel = transport.createChannel()
  const surfaceToken = (software ? 'cpu:' : '') + randomUUID()
  let parentFd: number | null = channel.parentFd
  let childFd: number | null = channel.childFd
  let stopped = false
  let visible = false
  let binding: SurfaceBinding | null = null
  let waitingSince: number | null = null
  let lastSequence = 0
  let lastDrawnSequence = 0
  let drawnFrames = 0
  let probe: 'pending' | 'passed' = 'pending'
  let probeSequence: number | undefined
  let probeBinding: string | undefined
  let probeSince: number | null = null
  const budget = new FrameBudget()
  let setBudget: ((ms: number) => void) | undefined
  const timings = new Map<number, { start: number; target: number; binding: string }>()
  let lastLatenessMs = 0
  let timeline = 0
  const clock = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !trusted(event) || !validBinding(value) || value.surfaceToken !== surfaceToken) return
    const sentAt = (value as SurfaceBinding & { sentAt?: unknown }).sentAt
    if (typeof sentAt !== 'number' || !Number.isFinite(sentAt) || sentAt < 0) return
    contents.send(CLOCK, { surfaceToken, bindingToken: value.bindingToken, sentAt, mainTime: monoMs() })
  }
  const pixelDiagnostics = process.env.JAVDEX_TEXTURE_PIXEL_DIAGNOSTICS === '1'
  let diagnosticFrames = 0
  if (pixelDiagnostics) {
    console.info('[playback-texture-pixels-enabled]')
    // Describes the existing producer, not a claim of calibrated output. Do not
    // label unspecified libmpv GPU output or BT.709 transfer bytes as sRGB.
    console.info('[playback-color-contract]', software ? 'BT.709 SDR/full-range RGBA -> Canvas sRGB (transfer agreement unverified)'
      : 'libmpv GPU/full-range BGRA -> untagged VideoFrame -> Canvas sRGB (transfer/gamut unverified)')
  }
  const diagnosticSequences = new Set<number>()
  let saturatedSince: number | null = null
  const pending = new Map<number, PendingFrame>()
  const acknowledgements: number[] = []
  const contents = window.webContents
  const trusted = (event: IpcMainEvent): boolean => !contents.isDestroyed()
    && event.sender === contents && event.senderFrame === contents.mainFrame
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
    if (binding && !contents.isDestroyed()) contents.send('playback:frame-flush', { ...binding, timeline: ++timeline })
    clearInterval(timer)
    ipcMain.removeListener(READY, ready)
    ipcMain.removeListener(REMOVED, removed)
    ipcMain.removeListener(FAILED, receiverFailed)
    ipcMain.removeListener(DRAWN, drawn)
    ipcMain.removeListener(CPU_RELEASED, cpuReleased)
    ipcMain.removeListener(CLOCK, clock)
    ipcMain.removeListener(PIXELS, pixels)
    ipcMain.removeListener(SELF_TEST, selfTest)
    contents.removeListener('did-start-navigation', navigation)
    contents.removeListener('render-process-gone', rendererGone)
    contents.removeListener('destroyed', rendererGone)
    app.removeListener('child-process-gone', childGone)
    binding = null
    if (parentFd !== null) { const fd = parentFd; parentFd = null; transport.close(fd) }
    spawned()
    // Fail closed: the owner terminates the producer, and no buffer is ACKed or
    // reused. Electron owns its imported resource references independently.
    // Close our descriptor copies even if a crashed GPU never calls us back.
    for (const entry of pending.values()) closeFrame(entry)
    pending.clear(); timings.clear(); acknowledgements.length = 0
  }
  const fail = (message: string): void => {
    if (stopped) return
    destroy()
    onError(new Error(message))
  }
  const ready = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !trusted(event) || !validBinding(value) || value.surfaceToken !== surfaceToken) return
    binding = { surfaceToken, bindingToken: value.bindingToken }; waitingSince = null
    if (timeline) contents.send('playback:frame-flush', { ...binding, timeline })
  }
  const removed = (event: IpcMainEvent, value: unknown): void => {
    if (!trusted(event) || !validBinding(value) || value.surfaceToken !== surfaceToken || value.bindingToken !== binding?.bindingToken) return
    if (software) for (const [sequence, entry] of pending) {
      if (!entry.released) { entry.released = true; entry.since = Date.now(); acknowledgements.push(sequence) }
    }
    binding = null; waitingSince = visible ? Date.now() : null
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
    // Canvas draw submission is evidence of renderer delivery, not screen
    // scanout. Neither helper export nor sendSharedTexture resolution counts.
    drawnFrames++
    const timing = timings.get(sequence)
    timings.delete(sequence)
    if (timing && timing.binding === binding?.bindingToken) {
      const receipt = value as SurfaceBinding & { readyTime?: number; submittedTime?: number }
      const now = monoMs()
      if (typeof receipt.readyTime === 'number' && typeof receipt.submittedTime === 'number'
        && Number.isFinite(receipt.readyTime) && Number.isFinite(receipt.submittedTime)
        && receipt.readyTime >= timing.start && receipt.submittedTime >= receipt.readyTime
        && receipt.submittedTime <= now + 10 && now - receipt.submittedTime < 1000) {
        lastLatenessMs = receipt.submittedTime - timing.target
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
    entry.released = true; entry.since = Date.now(); timings.delete(sequence); acknowledgements.push(sequence)
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
    if (software || stopped || probe !== 'pending' || !trusted(event) || !validBinding(value)
      || value.surfaceToken !== surfaceToken || value.bindingToken !== binding?.bindingToken || value.bindingToken !== probeBinding) return
    const data = value as SurfaceBinding & { sequence?: unknown; samples?: unknown }
    if (probeSequence === undefined || data.sequence !== probeSequence) return
    const samples = data.samples
    // Fixed pattern only, never classify black scenes from arbitrary media.
    if (!Array.isArray(samples) || samples.length !== 20 || !samples.every((v, i) =>
      integer(v, 0, 255) && Math.abs(v - [64, 191, 128, 255][i % 4]) <= 8)) {
      fail('共享视频合成色块自检失败'); return
    }
    probe = 'passed'; probeSince = null
    console.info('[playback-display-self-test] passed (readback; not scanout proof)')
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
    if (isMainFrame && !isInPlace) fail('播放器页面已重新加载，请重新打开视频')
  }
  const rendererGone = (): void => fail('播放器页面已关闭，请重新打开视频')
  const childGone = (_event: unknown, details: { type: string }): void => {
    if (!software && details.type === 'GPU') fail('GPU 进程已退出，请重新打开视频')
  }
  const importFrame = async (packet: FramePacket, target: SurfaceBinding): Promise<void> => {
    let imported: SharedTextureImported | undefined
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
          closeFrame(entry); entry.released = true; acknowledgements.push(frame.sequence); return
        }
        recordTiming(frame, target)
        const pixels = transport.readPixels(packet.fd, frame.size)
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
        acknowledgements.push(frame.sequence)
        return
      }
      if (frame.selfTest) {
        if (probeSequence !== undefined) throw new Error('Duplicate self-test frame')
        probeSequence = frame.sequence; probeBinding = target.bindingToken
      }
      imported = sharedTexture.importSharedTexture({
        textureInfo: { pixelFormat: frame.pixelFormat, codedSize: { width: frame.width, height: frame.height },
          handle: { nativePixmap: { planes: [{ fd: packet.fd, stride: frame.stride, offset: frame.offset, size: frame.size }],
            modifier: frame.modifier, supportsZeroCopyWebGpuImport: false } } },
        allReferencesReleased: () => {
          if (owner.released) return
          owner.released = true
          owner.since = Date.now()
          closeFrame(owner)
          if (stopped) return
          // Sending is not a GPU fence. Only this cross-process release callback
          // permits the producer to render into this slot again.
          if (acknowledgements.length >= POOL_SIZE) { fail('共享视频帧确认队列超出限制'); return }
          acknowledgements.push(frame.sequence)
        }
      })
      const diagnosePixels = pixelDiagnostics && frame.width === 640 && frame.height === 360
        && [1, 16, 31].includes(++diagnosticFrames)
      if (diagnosePixels) diagnosticSequences.add(frame.sequence)
      await sharedTexture.sendSharedTexture({ frame: contents.mainFrame, importedSharedTexture: imported },
        { ...target, sequence: frame.sequence, timeline, targetTime: (frame.targetTimeUs ?? 0) / 1000, colorContract: frame.colorContract,
          ...(frame.selfTest ? { selfTest: frame.selfTest } : {}), ...(diagnosePixels ? { diagnosePixels: true } : {}) })
    } catch {
      if (!imported) {
        if (entry) closeFrame(entry)
        else transport.close(packet.fd)
      }
      fail(software ? 'CPU 视频帧读取或传输失败，请停止后重试' : '共享视频纹理导入或传输失败，请停止后重试')
    } finally {
      try { imported?.release() } catch { fail('共享视频纹理释放失败，请停止后重试') }
    }
  }
  const timer = setInterval(() => {
    if (stopped || parentFd === null) return
    try {
      while (acknowledgements.length && transport.sendAck(parentFd, acknowledgements[0])) {
        pending.delete(acknowledgements.shift()!)
      }
      const now = Date.now()
      // A paused canvas may retain its most recent frame. Only a saturated
      // three-slot pool (or an ACK that cannot be delivered) is a stalled pool.
      if (visible && pending.size === POOL_SIZE) saturatedSince ??= now
      else saturatedSince = null
      if (saturatedSince !== null && now - saturatedSince > RELEASE_TIMEOUT
        || acknowledgements.some(sequence => now - pending.get(sequence)!.since > RELEASE_TIMEOUT)) {
        fail('共享视频纹理释放超时，请停止后重试'); return
      }
      if (visible && !binding && waitingSince !== null && now - waitingSince > READY_TIMEOUT) {
        fail('等待视频画面接收器超时，请停止后重试'); return
      }
      if (!software && visible && binding && probe === 'pending') {
        probeSince ??= now
        if (now - probeSince > SELF_TEST_TIMEOUT) { fail('共享视频合成色块自检超时'); return }
      }
      if (visible && binding && pending.size < POOL_SIZE) {
        const packet = transport.receive(parentFd)
        if (packet) void importFrame(packet, binding)
      }
    } catch { fail('共享视频帧通道已中断，请停止后重试') }
  }, 5)
  timer.unref()
  ipcMain.on(READY, ready)
  ipcMain.on(REMOVED, removed)
  ipcMain.on(FAILED, receiverFailed)
  ipcMain.on(DRAWN, drawn)
  ipcMain.on(CPU_RELEASED, cpuReleased)
  ipcMain.on(CLOCK, clock)
  ipcMain.on(PIXELS, pixels)
  ipcMain.on(SELF_TEST, selfTest)
  contents.on('did-start-navigation', navigation)
  contents.on('render-process-gone', rendererGone)
  contents.on('destroyed', rendererGone)
  app.on('child-process-gone', childGone)
  return { surfaceToken, childFd: channel.childFd, spawned, destroy, submittedFrames: (): number => drawnFrames,
    resetTiming(): number | undefined {
      if (stopped) return
      timeline++; timings.clear(); budget.reset(); setBudget?.(20)
      if (binding) contents.send('playback:frame-flush', { ...binding, timeline })
      return timeline
    },
    displayProbe: () => software ? 'not-applicable' as const : probe,
    timingStats: () => ({ renderBudgetMs: budget.value, submissionLatenessMs: lastLatenessMs }),
    onBudget(callback: (ms: number) => void): void { setBudget = callback },
    isReady: (): boolean => !stopped && binding !== null,
    setVisible(value: boolean): void {
      if (stopped) return
      if (value && !visible && !binding) waitingSince = Date.now()
      if (!value) { waitingSince = null; saturatedSince = null; probeSince = null }
      visible = value
    } }
}
