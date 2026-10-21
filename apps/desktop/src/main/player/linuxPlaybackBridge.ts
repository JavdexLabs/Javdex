import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { NativePlaybackState } from './nativePlayback'
import type { PlaybackOcclusion } from '@shared/desktop/playback'

interface Bounds { x: number; y: number; width: number; height: number; scale?: number }
const LIMIT = 1024 * 1024
const GENERATED_LIMIT = 8 * 1024 * 1024 + 4096
const actionKinds = new Set(['toggle-pause', 'toggle-mute', 'expand', 'dock', 'fullscreen', 'stop', 'seek', 'seek-relative', 'volume', 'volume-relative', 'focus-forward', 'focus-backward', 'history-back', 'history-forward', 'escape'])
function validAction(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const action = value as { kind?: unknown; value?: unknown }
  return typeof action.kind === 'string' && actionKinds.has(action.kind)
    && (action.value === undefined || typeof action.value === 'number' && Number.isFinite(action.value))
}

/** Length-delimited UTF-8 fields keep paths, URLs and subtitle names out of shell
 * parsing. The helper has only inherited private pipes, never a listening port. */
export function encodePlaybackMessage(fields: string[]): Buffer {
  if (!fields.length || fields.length > (fields[0] === 'occlusions' ? 257 : 16) || fields.some(value => value.includes('\0'))) throw new Error('无效的播放控制参数')
  const values = fields.map(value => Buffer.from(value, 'utf8'))
  const size = 4 + values.reduce((sum, value) => sum + 4 + value.length, 0)
  if (size > (fields[0] === 'generated-subtitles' ? GENERATED_LIMIT : LIMIT)) throw new Error('播放控制参数过长')
  const result = Buffer.allocUnsafe(size + 4)
  result.writeUInt32LE(size, 0); result.writeUInt32LE(fields.length, 4)
  let offset = 8
  for (const value of values) { result.writeUInt32LE(value.length, offset); offset += 4; value.copy(result, offset); offset += value.length }
  return result
}
const rectangle = (bounds: Bounds): string[] => [bounds.x, bounds.y, bounds.width, bounds.height, bounds.scale ?? 1].map(String)

export interface LinuxPlaybackFrameChannel {
  surfaceToken: string
  childFd: number
  spawned(): void
  setVisible(visible: boolean): void
  isReady?(): boolean
  submittedFrames?(): number
  resetTiming?(): number | undefined
  onBudget?(callback: (ms: number) => void): void
  timingStats?(): { renderBudgetMs: number; submissionLatenessMs: number }
  destroy(): void
}

/** Fixed diagnostics only: never reflect helper strings, media URLs or paths. */
export function linuxSharedTextureFailureCode(message: string): string {
  const groups: Array<[string, string[]]> = [
    ['DRM_RENDER_NODE_UNAVAILABLE', ['No accessible DRM render node; a real GPU render node is required', 'Cannot open DRM render node (missing device or permission)', 'Selected device is not a DRM render node', 'DRM render node override must be an absolute path']],
    ['GBM_LINEAR_BUFFER_UNAVAILABLE', ['Cannot create GBM device on DRM render node', 'Cannot allocate linear renderable GBM buffer', 'Cannot allocate renderable GBM buffer', 'GBM did not provide a single-plane linear BGRA buffer', 'GBM did not provide a supported single-plane BGRA buffer', 'Cannot export GBM DMA-BUF descriptor', 'Cannot verify DMA-BUF allocation size']],
    ['EGL_DMABUF_UNAVAILABLE', ['EGL platform display extension is unavailable', 'Cannot initialize EGL on DRM render node', 'Required EGL DMA-BUF, image, context or surfaceless extension is unavailable', 'EGL OpenGL API is unavailable', 'No compatible EGL OpenGL configuration', 'Cannot create surfaceless OpenGL 3.2 context', 'Shared-texture playback requires a hardware EGL renderer', 'EGL image texture functions are unavailable', 'Cannot import GBM DMA-BUF into EGL image', 'DMA-BUF framebuffer is not renderable']],
    ['VULKAN_DMABUF_UNAVAILABLE', ['Missing private Vulkan loader path', 'Cannot load Vulkan capability query', 'No Vulkan DMA-BUF device matches the render node', 'No importable single-plane Vulkan BGRA layout', 'GBM allocation does not match the negotiated Vulkan layout']],
    ['FRAME_RENDER_FAILED', ['Invalid OpenGL render limits', 'DMA-BUF viewport exceeds GPU limits', 'DMA-BUF frame rendering failed', 'libmpv could not render the shared texture', 'libmpv could not skip a hidden frame']],
    ['TEXTURE_IMPORT_FAILED', ['共享视频纹理导入或传输失败，请停止后重试', '当前 Electron 不支持共享视频纹理']],
    ['RECEIVER_NOT_READY', ['等待视频画面接收器超时，请停止后重试', '共享视频画面接收失败，请停止后重试']],
    ['FRAME_RELEASE_TIMEOUT', ['DMA-BUF consumer stalled waiting for frame release', '共享视频纹理释放超时，请停止后重试']],
    ['HELPER_HEARTBEAT_TIMEOUT', ['Shared-texture helper heartbeat timed out']],
    ['GPU_PROCESS_EXITED', ['GPU 进程已退出，请重新打开视频']],
    ['RENDERER_REPLACED', ['播放器页面已重新加载，请重新打开视频', '播放器页面已关闭，请重新打开视频']],
    ['FRAME_CHANNEL_FAILED', ['共享视频帧通道已中断，请停止后重试', '共享视频纹理释放失败，请停止后重试', '共享视频帧确认队列超出限制', 'DMA-BUF consumer disconnected']]
  ]
  return groups.find(([, messages]) => messages.includes(message))?.[0] ?? 'EXPERIMENTAL_PLAYBACK_FAILED'
}

export function createLinuxPlaybackBridge(executable: string,
  createFrameChannel?: (onError: (error: Error) => void) => LinuxPlaybackFrameChannel, renderNode?: string, vulkanLoader?: string) {
  let child: ChildProcessWithoutNullStreams | null = null
  let frameChannel: LinuxPlaybackFrameChannel | null = null
  let generation = 0
  let snapshot: NativePlaybackState = { alive: false }
  let actions: NonNullable<NativePlaybackState['actions']> = []
  let failure: Error | null = null
  let input = ''
  let lastDiagnostic = 0
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let requestedVisible = false
  let lastBounds = '', lastVisible: boolean | undefined, lastPresentation = ''
  let lastOcclusions = '', lastRendererControls: boolean | undefined
  const send = (fields: string[]): void => {
    if (failure) throw failure
    if (!child || child.killed || !child.stdin.writable) throw new Error('Linux 播放进程未运行')
    if (child.stdin.writableLength > GENERATED_LIMIT) throw new Error('Linux 播放进程未响应')
    child.stdin.write(encodePlaybackMessage(fields))
  }
  const syncNativeVisibility = (): void => {
    const visible = requestedVisible && (!frameChannel || frameChannel.isReady?.() === true)
    if (visible !== lastVisible) { send(['visible', visible ? '1' : '0']); lastVisible = visible }
  }
  const destroy = (): void => {
    generation++
    clearInterval(heartbeat); heartbeat = undefined
    const previous = child; child = null
    frameChannel?.destroy(); frameChannel = null
    snapshot = { alive: false }; actions = []; failure = null; input = ''
    if (!previous) return
    // Graceful cleanup first, then bound shutdown of an unresponsive decoder.
    if (previous.stdin.writable) previous.stdin.end(encodePlaybackMessage(['destroy']))
    const timeout = setTimeout(() => previous.kill('SIGKILL'), 2000)
    timeout.unref(); previous.once('exit', () => clearTimeout(timeout))
  }
  return {
    create(handle: Buffer, bounds: Bounds, host?: { backend: 'dmabuf' | 'software' }): void {
      const shared = host?.backend === 'dmabuf' || host?.backend === 'software'
      const diagnostics = shared && globalThis.process.env.JAVDEX_PLAYBACK_DIAGNOSTICS === '1'
      if (shared && !createFrameChannel) throw new Error('未提供实验共享纹理传输通道')
      if (!shared || handle.length !== 0) throw new Error('Linux 播放仅支持共享纹理或 CPU 内存帧')
      const id = 0n
      destroy(); requestedVisible = false; lastBounds = ''; lastVisible = undefined; lastPresentation = ''; lastOcclusions = ''; lastRendererControls = undefined
      const epoch = generation
      let lastState = Date.now()
      let process: ChildProcessWithoutNullStreams | null = null
      const failed = (error: Error): void => {
        if (generation !== epoch || failure) return
        clearInterval(heartbeat); heartbeat = undefined
        failure = error; snapshot = { alive: false }
        if (shared) console.warn('[playback-dmabuf] failure=' + linuxSharedTextureFailureCode(error.message))
        frameChannel?.destroy(); frameChannel = null
        if (process) {
          process.kill('SIGTERM')
          const previous = process
          const timeout = setTimeout(() => previous.kill('SIGKILL'), 2000)
          timeout.unref(); previous.once('exit', () => clearTimeout(timeout))
        }
      }
      try {
        if (shared) frameChannel = createFrameChannel!(failed)
        const fontConfig = path.join(path.dirname(executable), 'fonts.conf')
        const environment = { ...globalThis.process.env,
          JAVDEX_PLAYBACK_VULKAN_LOADER: host?.backend === 'dmabuf' ? vulkanLoader : undefined,
          ...(shared && renderNode ? { JAVDEX_DRM_RENDER_NODE: renderNode } : {}),
          ...(shared && existsSync(fontConfig) ? { FONTCONFIG_FILE: fontConfig } : {}) }
        process = spawn(executable, ['--stdio-v1'], { stdio: frameChannel
          ? ['pipe', 'pipe', 'pipe', frameChannel.childFd] : ['pipe', 'pipe', 'pipe'], windowsHide: true,
          env: environment }) as ChildProcessWithoutNullStreams
        frameChannel?.spawned()
      } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); throw error }
      const launched = process
      child = launched; snapshot = { alive: true }
      frameChannel?.onBudget?.(ms => { if (child === launched && !failure) send(['command', 'set', 'video-timing-offset', String(ms / 1000)]) })
      if (shared) {
        heartbeat = setInterval(() => {
          if (generation === epoch && Date.now() - lastState > 10000) failed(new Error('Shared-texture helper heartbeat timed out'))
        }, 500)
        heartbeat.unref()
      }
      launched.on('error', error => failed(new Error('无法启动 Linux 播放进程：' + error.message)))
      launched.stdin.on('error', error => failed(new Error('Linux 播放控制通道断开：' + error.message)))
      launched.stderr.on('data', () => { /* Drain library diagnostics; never log media URLs or credentials. */ })
      launched.stdout.setEncoding('utf8')
      launched.stdout.on('data', (data: string) => {
        if (child !== launched) return
        input += data
        if (input.length > LIMIT) { failed(new Error('Linux 播放状态过长')); return }
        let end: number
        while ((end = input.indexOf('\n')) >= 0) {
          const line = input.slice(0, end); input = input.slice(end + 1)
          try {
            const value: unknown = JSON.parse(line)
            if (!value || typeof value !== 'object' || typeof (value as NativePlaybackState).alive !== 'boolean') throw new Error('Invalid state')
            const next = value as NativePlaybackState
            if (!next.alive && next.error) { failed(new Error(next.error)); return }
            if (next.actions && (!Array.isArray(next.actions) || next.actions.length > 32 || !next.actions.every(validAction))) throw new Error('Invalid actions')
            actions.push(...(next.actions ?? []))
            if (actions.length > 128) throw new Error('Action overflow')
            snapshot = { ...next, actions: undefined }; lastState = Date.now()
            if (diagnostics && Date.now() - lastDiagnostic >= 1000) {
              lastDiagnostic = Date.now()
              console.info('[playback-dmabuf]', JSON.stringify({ alive: next.alive, nativeFrames: next.nativeFrames,
                submittedFrames: frameChannel?.submittedFrames?.() ?? next.submittedFrames, loadedFiles: next.loadedFiles, width: next.width, height: next.height }))
            }
          } catch { failed(new Error('Linux 播放状态无效')); return }
        }
      })
      launched.on('exit', (code, signal) => {
        if (child === launched) {
          clearInterval(heartbeat); heartbeat = undefined
          frameChannel?.destroy(); frameChannel = null
          snapshot = { alive: false }; failure ??= new Error(`Linux 播放进程已退出（${signal ?? code ?? 'unknown'}）`)
        }
      })
      send(['create', id.toString(), ...rectangle(bounds), host!.backend])
    },
    setBounds(bounds: Bounds): void {
      const fields = rectangle(bounds), key = fields.join(',')
      if (key !== lastBounds) { send(['bounds', ...fields]); lastBounds = key }
    },
    setVisible(visible: boolean): void {
      requestedVisible = visible
      frameChannel?.setVisible(visible)
      syncNativeVisibility()
    },
    setPresentation(value: string): void { if (value !== lastPresentation) { send(['presentation', value]); lastPresentation = value } },
    setRendererControls(enabled: boolean): void {
      if (enabled !== lastRendererControls) { send(['renderer-controls', enabled ? '1' : '0']); lastRendererControls = enabled }
    },
    setOcclusions(rects: PlaybackOcclusion[]): void {
      if (rects.length > 32) throw new Error('播放控件遮挡区域过多')
      const values = rects.flatMap(rect => [rect.x, rect.y, rect.width, rect.height, ...(rect.radii ?? [0, 0, 0, 0])])
      if (values.some(value => !Number.isFinite(value))) throw new Error('无效的播放控件遮挡区域')
      const key = values.join(',')
      if (key !== lastOcclusions) { send(['occlusions', ...values.map(String)]); lastOcclusions = key }
    },
    command(args: string[], generatedSubtitle = false): void {
      send([generatedSubtitle ? 'generated-subtitle-command' : 'command', ...args])
      if (!generatedSubtitle && (['loadfile', 'seek', 'stop'].includes(args[0])
        || args[0] === 'set' && ['pause', 'speed'].includes(args[1]))) {
        const timeline = frameChannel?.resetTiming?.()
        if (timeline !== undefined) send(['timing-reset', String(timeline)])
      }
    },
    generatedSubtitles(operation: 'update' | 'visible' | 'clear', document: string, visible: boolean, revision: number): void {
      send(['generated-subtitles', operation, document, visible ? '1' : '0', String(revision)])
    },
    render(): void {
      if (failure) throw failure
      if (frameChannel) syncNativeVisibility()
    },
    state(): NativePlaybackState {
      if (failure) throw failure
      const value = { ...snapshot, ...(frameChannel ? { sharedTextureSurface: frameChannel.surfaceToken,
        presentedFrames: undefined, submittedFrames: frameChannel.submittedFrames?.() ?? 0, ...frameChannel.timingStats?.() } : {}), actions }; actions = []; return value
    },
    inspect(): NativePlaybackState {
      if (failure) throw failure
      return { ...snapshot, ...(frameChannel ? { sharedTextureSurface: frameChannel.surfaceToken,
        presentedFrames: undefined, submittedFrames: frameChannel.submittedFrames?.() ?? 0, ...frameChannel.timingStats?.() } : {}) }
    },
    destroy
  }
}
