import { app, ipcMain, sharedTexture, type BrowserWindow, type IpcMainEvent, type SharedTextureImported } from 'electron'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const READY = 'playback:shared-texture-ready'
const REMOVED = 'playback:shared-texture-removed'
const FAILED = 'playback:shared-texture-failed'
const DRAWN = 'playback:shared-texture-drawn'
const PIXELS = 'playback:shared-texture-pixel-diagnostic'
const POOL_SIZE = 3
const RELEASE_TIMEOUT = 5000
const READY_TIMEOUT = 10000
interface FramePacket { metadata: Buffer; fd: number }
interface FdBridge {
  createChannel(): { parentFd: number; childFd: number }
  receive(fd: number): FramePacket | null
  sendAck(fd: number, sequence: number): boolean
  close(fd: number): void
}
interface DmaBufFrame {
  protocol: 'javdex-dmabuf-v1'
  sequence: number
  slot: number
  width: number
  height: number
  pixelFormat: 'bgra' | 'rgba'
  stride: number
  offset: number
  size: number
  modifier: string
  producerComplete: true
}
interface SurfaceBinding { surfaceToken: string; bindingToken: string }
interface PendingFrame { slot: number; fd: number | null; since: number; released: boolean }
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max

/** Only the helper's one-plane RGBA/BGRA protocol is supported. No arbitrary
 * native handles, pixel layouts or GPU commands are accepted from a renderer. */
export function decodeDmaBufFrame(metadata: Buffer): DmaBufFrame {
  if (!Buffer.isBuffer(metadata) || metadata.length > 4096) throw new Error('无效的共享视频帧元数据')
  const value = JSON.parse(metadata.toString('utf8')) as DmaBufFrame | null
  if (!value || value.protocol !== 'javdex-dmabuf-v1'
    || !integer(value.sequence, 1, Number.MAX_SAFE_INTEGER) || !integer(value.slot, 0, POOL_SIZE - 1)
    || !integer(value.width, 1, 8192) || !integer(value.height, 1, 8192)
    || !['bgra', 'rgba'].includes(value.pixelFormat)
    || !integer(value.stride, value.width * 4, 131072)
    || !integer(value.offset, 0, 1073741824) || !integer(value.size, 1, 1073741824)
    || value.offset + value.stride * value.height > value.size
    || typeof value.modifier !== 'string' || !/^[0-9]{1,20}$/.test(value.modifier)
    || BigInt(value.modifier) > 0xffffffffffffffffn || value.producerComplete !== true) {
    throw new Error('无效的共享视频帧元数据')
  }
  return value
}
function validBinding(value: unknown): value is SurfaceBinding {
  if (!value || typeof value !== 'object') return false
  const binding = value as SurfaceBinding
  return typeof binding.surfaceToken === 'string' && binding.surfaceToken.length <= 64
    && typeof binding.bindingToken === 'string' && /^[\da-f-]{36}$/.test(binding.bindingToken)
}

/** One manager belongs to one helper lifetime. Its token is published only in
 * the matching playback snapshot; neither socket nor DMA-BUF FDs cross IPC. */
export function createLinuxSharedTexture(window: BrowserWindow, addonPath: string, onError: (error: Error) => void) {
  if (typeof sharedTexture?.importSharedTexture !== 'function' || typeof sharedTexture.sendSharedTexture !== 'function') {
    throw new Error('当前 Electron 不支持共享视频纹理')
  }
  const transport = createRequire(addonPath)(addonPath) as FdBridge
  const channel = transport.createChannel()
  const surfaceToken = randomUUID()
  let parentFd: number | null = channel.parentFd
  let childFd: number | null = channel.childFd
  let stopped = false
  let visible = false
  let binding: SurfaceBinding | null = null
  let waitingSince: number | null = null
  let lastSequence = 0
  let lastDrawnSequence = 0
  let drawnFrames = 0
  const pixelDiagnostics = process.env.JAVDEX_TEXTURE_PIXEL_DIAGNOSTICS === '1'
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
    clearInterval(timer)
    ipcMain.removeListener(READY, ready)
    ipcMain.removeListener(REMOVED, removed)
    ipcMain.removeListener(FAILED, receiverFailed)
    ipcMain.removeListener(DRAWN, drawn)
    ipcMain.removeListener(PIXELS, pixels)
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
    pending.clear(); acknowledgements.length = 0
  }
  const fail = (message: string): void => {
    if (stopped) return
    destroy()
    onError(new Error(message))
  }
  const ready = (event: IpcMainEvent, value: unknown): void => {
    if (stopped || !trusted(event) || !validBinding(value) || value.surfaceToken !== surfaceToken) return
    binding = { surfaceToken, bindingToken: value.bindingToken }; waitingSince = null
  }
  const removed = (event: IpcMainEvent, value: unknown): void => {
    if (!trusted(event) || !validBinding(value) || value.surfaceToken !== surfaceToken || value.bindingToken !== binding?.bindingToken) return
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
    const sequence = (value as SurfaceBinding & { sequence?: unknown }).sequence
    if (!integer(sequence, lastDrawnSequence + 1, lastSequence)) return
    lastDrawnSequence = sequence
    // Canvas draw submission is evidence of renderer delivery, not screen
    // scanout. Neither helper export nor sendSharedTexture resolution counts.
    drawnFrames++
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
    if (details.type === 'GPU') fail('GPU 进程已退出，请重新打开视频')
  }
  const importFrame = async (packet: FramePacket, target: SurfaceBinding): Promise<void> => {
    let imported: SharedTextureImported | undefined
    let entry: PendingFrame | undefined
    try {
      const frame = decodeDmaBufFrame(packet.metadata)
      if (frame.sequence <= lastSequence || pending.size >= POOL_SIZE || [...pending.values()].some(value => value.slot === frame.slot)) {
        throw new Error('共享视频帧池所有权无效')
      }
      lastSequence = frame.sequence
      entry = { slot: frame.slot, fd: packet.fd, since: Date.now(), released: false }
      const owner = entry
      pending.set(frame.sequence, owner)
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
        && [15, 30, 45].includes(frame.sequence)
      if (diagnosePixels) diagnosticSequences.add(frame.sequence)
      await sharedTexture.sendSharedTexture({ frame: contents.mainFrame, importedSharedTexture: imported },
        { ...target, sequence: frame.sequence, ...(diagnosePixels ? { diagnosePixels: true } : {}) })
    } catch {
      if (!imported) {
        if (entry) closeFrame(entry)
        else transport.close(packet.fd)
      }
      fail('共享视频纹理导入或传输失败，请停止后重试')
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
  ipcMain.on(PIXELS, pixels)
  contents.on('did-start-navigation', navigation)
  contents.on('render-process-gone', rendererGone)
  contents.on('destroyed', rendererGone)
  app.on('child-process-gone', childGone)
  return { surfaceToken, childFd: channel.childFd, spawned, destroy, presentedFrames: (): number => drawnFrames,
    isReady: (): boolean => !stopped && binding !== null,
    setVisible(value: boolean): void {
      if (stopped) return
      if (value && !visible && !binding) waitingSince = Date.now()
      if (!value) { waitingSince = null; saturatedSince = null }
      visible = value
    } }
}
