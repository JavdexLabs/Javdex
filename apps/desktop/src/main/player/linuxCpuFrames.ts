import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const READY = 'playback:cpu-frame-ready'
const REMOVED = 'playback:cpu-frame-removed'
const FAILED = 'playback:cpu-frame-failed'
const RELEASE = 'playback:cpu-frame-release'
const FRAME = 'playback:cpu-frame'
const STATE = 'playback:cpu-frame-state'
const POOL_SIZE = 3
const RELEASE_TIMEOUT = 5000
const READY_TIMEOUT = 10000
interface FramePacket { metadata: Buffer; fd: number }
interface FdBridge {
  createChannel(): { parentFd: number; childFd: number }
  receive(fd: number): FramePacket | null
  /** Consumes and closes the owned received FD, including on validation failure. */
  copyFrame(fd: number, size: number): Buffer
  sendAck(fd: number, sequence: number): boolean
  close(fd: number): void
}
interface CpuFrame {
  protocol: 'javdex-cpu-frame-v1'
  sequence: number
  slot: number
  generation: number
  width: number
  height: number
  pixelFormat: 'rgba'
  stride: number
  size: number
  producerComplete: true
}
interface SurfaceBinding { surfaceToken: string; bindingToken: string }
interface PendingFrame { slot: number; generation: number; bindingToken: string | null; since: number; released: boolean }
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const token = (value: unknown): value is string => typeof value === 'string' && /^[\da-f-]{36}$/.test(value)
function validBinding(value: unknown): value is SurfaceBinding {
  if (!value || typeof value !== 'object') return false
  const binding = value as SurfaceBinding
  return token(binding.surfaceToken) && token(binding.bindingToken)
}

/** Fixed, tightly packed SDR RGBA only. Validate before allocating/copying pixels. */
export function decodeCpuFrame(metadata: Buffer): CpuFrame {
  if (!Buffer.isBuffer(metadata) || metadata.length > 4096) throw new Error('无效的 CPU 视频帧元数据')
  const value = JSON.parse(metadata.toString('utf8')) as CpuFrame | null
  if (!value || value.protocol !== 'javdex-cpu-frame-v1'
    || !integer(value.sequence, 1, Number.MAX_SAFE_INTEGER) || !integer(value.slot, 0, POOL_SIZE - 1)
    || !integer(value.generation, 1, 0xffffffff) || !integer(value.width, 1, 1280) || !integer(value.height, 1, 720)
    || value.pixelFormat !== 'rgba' || value.stride !== value.width * 4 || value.size !== value.stride * value.height
    || value.producerComplete !== true) throw new Error('无效的 CPU 视频帧元数据')
  // Never forward unknown helper fields (descriptors, paths or other payloads).
  return { protocol: 'javdex-cpu-frame-v1', sequence: value.sequence, slot: value.slot, generation: value.generation,
    width: value.width, height: value.height, pixelFormat: 'rgba', stride: value.stride, size: value.size, producerComplete: true }
}

/** No sharedTexture, GPU context, native handle or media locator crosses this seam.
 * Main copies bounded memfds; the producer keeps each lease until draw/drop ACK. */
export function createLinuxCpuFrames(window: BrowserWindow, addonPath: string, onError: (error: Error) => void) {
  const transport = createRequire(addonPath)(addonPath) as FdBridge
  if (typeof transport.copyFrame !== 'function') throw new Error('CPU 视频帧桥接运行库需更新')
  const channel = transport.createChannel()
  const surfaceToken = randomUUID()
  let parentFd: number | null = channel.parentFd
  let childFd: number | null = channel.childFd
  let stopped = false, visible = false
  let binding: SurfaceBinding | null = null
  let waitingSince: number | null = null
  let generation = 1, lastSequence = 0, drawnFrames = 0, copiedFrames = 0, droppedFrames = 0
  const pending = new Map<number, PendingFrame>()
  const contents = window.webContents
  const trusted = (event: IpcMainEvent): boolean => !contents.isDestroyed()
    && event.sender === contents && event.senderFrame === contents.mainFrame
  const spawned = (): void => {
    if (childFd === null) return
    const fd = childFd; childFd = null; transport.close(fd)
  }
  const publishState = (): void => {
    if (binding && !stopped) contents.mainFrame.send(STATE, { ...binding, generation, visible })
  }
  const destroy = (): void => {
    if (stopped) return
    // Ordered after any sent frames: clear the stale canvas even when the next
    // snapshot or React unmount has not arrived yet.
    visible = false
    try { publishState() } catch { /* Renderer may already be gone. */ }
    stopped = true
    clearInterval(timer)
    ipcMain.removeListener(READY, ready); ipcMain.removeListener(REMOVED, removed)
    ipcMain.removeListener(FAILED, receiverFailed); ipcMain.removeListener(RELEASE, released)
    contents.removeListener('did-start-navigation', navigation)
    contents.removeListener('render-process-gone', rendererGone); contents.removeListener('destroyed', rendererGone)
    binding = null
    if (parentFd !== null) { const fd = parentFd; parentFd = null; transport.close(fd) }
    spawned(); pending.clear()
  }
  const fail = (message: string): void => {
    if (stopped) return
    destroy(); onError(new Error(message))
  }
  const ready = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !trusted(event) || !validBinding(value) || value.surfaceToken !== surfaceToken) return
    binding = { surfaceToken, bindingToken: value.bindingToken }; waitingSince = null
    try { publishState() } catch { fail('CPU 视频画面接收失败，请停止后重试') }
  }
  const removed = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !trusted(event) || !validBinding(value) || value.surfaceToken !== surfaceToken || value.bindingToken !== binding?.bindingToken) return
    binding = null; waitingSince = visible ? Date.now() : null
  }
  const receiverFailed = (event: IpcMainEvent, value: unknown): void => {
    if (trusted(event) && validBinding(value) && value.surfaceToken === surfaceToken && value.bindingToken === binding?.bindingToken) {
      fail('CPU 视频画面接收失败，请停止后重试')
    }
  }
  const released = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !trusted(event) || !validBinding(value) || value.surfaceToken !== surfaceToken) return
    const reply = value as SurfaceBinding & { sequence?: unknown; generation?: unknown; outcome?: unknown }
    if (!integer(reply.sequence, 1, Number.MAX_SAFE_INTEGER)) return
    const entry = pending.get(reply.sequence)
    // Old mounts may release their own frame, but cannot release a replacement's
    // lease or count a stale draw. Duplicate ACKs never reach the helper.
    if (!entry || entry.released || entry.bindingToken !== reply.bindingToken || entry.generation !== reply.generation
      || reply.outcome !== 'drawn' && reply.outcome !== 'dropped') return
    entry.released = true; entry.since = Date.now()
    if (reply.outcome === 'drawn' && visible && binding?.bindingToken === reply.bindingToken && entry.generation === generation) drawnFrames++
    else droppedFrames++
  }
  const navigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
    if (isMainFrame && !isInPlace) fail('播放器页面已重新加载，请重新打开视频')
  }
  const rendererGone = (): void => fail('播放器页面已关闭，请重新打开视频')
  const receiveFrame = (packet: FramePacket): void => {
    let fd: number | null = packet.fd
    try {
      const frame = decodeCpuFrame(packet.metadata)
      if (frame.sequence <= lastSequence || pending.size >= POOL_SIZE || [...pending.values()].some(entry => entry.slot === frame.slot)) {
        throw new Error('CPU 视频帧池所有权无效')
      }
      lastSequence = frame.sequence
      const target = visible && binding && frame.generation === generation ? binding : null
      const entry: PendingFrame = { slot: frame.slot, generation: frame.generation,
        bindingToken: target?.bindingToken ?? null, since: Date.now(), released: target === null }
      pending.set(frame.sequence, entry)
      if (!target) { droppedFrames++; return }
      // copyFrame owns the descriptor as soon as called, even when it throws.
      const consumedFd = fd; fd = null
      const pixels = transport.copyFrame(consumedFd, frame.size)
      if (!Buffer.isBuffer(pixels) || pixels.byteLength !== frame.size) throw new Error('CPU 视频帧长度无效')
      copiedFrames++
      // Binary structured clone, never JSON/base64 pixels. Maximum three IPC
      // frame messages remain outstanding across sent and unreleased leases.
      contents.mainFrame.send(FRAME, { ...target, ...frame }, pixels)
    } catch { fail('CPU 视频帧复制或传输失败，请停止后重试') }
    finally { if (fd !== null) transport.close(fd) }
  }
  const timer = setInterval(() => {
    if (stopped || parentFd === null) return
    try {
      for (const [sequence, entry] of pending) {
        if (entry.released && transport.sendAck(parentFd, sequence)) pending.delete(sequence)
      }
      const now = Date.now()
      if (visible && [...pending.values()].some(entry => now - entry.since > RELEASE_TIMEOUT)) {
        fail('CPU 视频帧释放超时，请停止后重试'); return
      }
      if (visible && !binding && waitingSince !== null && now - waitingSince > READY_TIMEOUT) {
        fail('等待 CPU 视频画面接收器超时，请停止后重试'); return
      }
      // Hidden/unbound and obsolete-generation packets are drained and dropped
      // without pixel copies, allowing all producer leases to be returned.
      for (let i = 0; i < POOL_SIZE && pending.size < POOL_SIZE && !stopped; i++) {
        const packet = transport.receive(parentFd)
        if (!packet) break
        receiveFrame(packet)
      }
    } catch { fail('CPU 视频帧通道已中断，请停止后重试') }
  }, 5)
  timer.unref()
  ipcMain.on(READY, ready); ipcMain.on(REMOVED, removed); ipcMain.on(FAILED, receiverFailed); ipcMain.on(RELEASE, released)
  contents.on('did-start-navigation', navigation); contents.on('render-process-gone', rendererGone); contents.on('destroyed', rendererGone)
  return { surfaceToken, kind: 'cpu' as const, childFd: channel.childFd, spawned, destroy,
    presentedFrames: (): number => drawnFrames,
    diagnostics: () => ({ copiedFrames, transportDroppedFrames: droppedFrames, cpuFramesInFlight: pending.size,
      // Producer storage upper bound only; IPC copies, ImageData and canvas
      // backing stores are separate allocations, not included in this budget.
      poolMemoryBudgetBytes: POOL_SIZE * 1280 * 720 * 4 }),
    isReady: (): boolean => !stopped && binding !== null,
    invalidateFrames(): number {
      generation = generation === 0xffffffff ? 1 : generation + 1
      try { publishState() } catch { fail('CPU 视频画面接收失败，请停止后重试') }
      return generation
    },
    setVisible(value: boolean): void {
      if (stopped || value === visible) return
      visible = value; waitingSince = value && !binding ? Date.now() : null
      // Chromium may freeze an intentionally hidden renderer. Preserve leases,
      // continue draining real releases, and give restoration a fresh deadline.
      if (value) for (const entry of pending.values()) entry.since = Date.now()
      try { publishState() } catch { fail('CPU 视频画面接收失败，请停止后重试') }
    } }
}
