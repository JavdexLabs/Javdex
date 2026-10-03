import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { NativePlaybackState } from './nativePlayback'

interface Bounds { x: number; y: number; width: number; height: number; scale?: number }
const LIMIT = 1024 * 1024
const actionKinds = new Set(['toggle-pause', 'toggle-mute', 'expand', 'dock', 'fullscreen', 'stop', 'seek', 'seek-relative', 'volume', 'volume-relative', 'focus-forward', 'focus-backward', 'history-back', 'history-forward'])
function validAction(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const action = value as { kind?: unknown; value?: unknown }
  return typeof action.kind === 'string' && actionKinds.has(action.kind)
    && (action.value === undefined || typeof action.value === 'number' && Number.isFinite(action.value))
}

/** Length-delimited UTF-8 fields keep paths, URLs and subtitle names out of shell
 * parsing. The helper has only inherited private pipes, never a listening port. */
export function encodePlaybackMessage(fields: string[]): Buffer {
  if (!fields.length || fields.length > 16 || fields.some(value => value.includes('\0'))) throw new Error('无效的播放控制参数')
  const values = fields.map(value => Buffer.from(value, 'utf8'))
  const size = 4 + values.reduce((sum, value) => sum + 4 + value.length, 0)
  if (size > LIMIT) throw new Error('播放控制参数过长')
  const result = Buffer.allocUnsafe(size + 4)
  result.writeUInt32LE(size, 0); result.writeUInt32LE(fields.length, 4)
  let offset = 8
  for (const value of values) { result.writeUInt32LE(value.length, offset); offset += 4; value.copy(result, offset); offset += value.length }
  return result
}
const rectangle = (bounds: Bounds): string[] => [bounds.x, bounds.y, bounds.width, bounds.height, bounds.scale ?? 1].map(String)

export function createLinuxPlaybackBridge(executable: string) {
  let child: ChildProcessWithoutNullStreams | null = null
  let snapshot: NativePlaybackState = { alive: false }
  let actions: NonNullable<NativePlaybackState['actions']> = []
  let failure: Error | null = null
  let input = ''
  let lastBounds = '', lastVisible: boolean | undefined, lastPresentation = ''
  const send = (fields: string[]): void => {
    if (failure) throw failure
    if (!child || child.killed || !child.stdin.writable) throw new Error('Linux 播放进程未运行')
    if (child.stdin.writableLength > LIMIT) throw new Error('Linux 播放进程未响应')
    child.stdin.write(encodePlaybackMessage(fields))
  }
  const destroy = (): void => {
    const previous = child; child = null
    snapshot = { alive: false }; actions = []; failure = null; input = ''
    if (!previous) return
    // Graceful cleanup first, then bound shutdown of an unresponsive decoder.
    if (previous.stdin.writable) previous.stdin.end(encodePlaybackMessage(['destroy']))
    const timeout = setTimeout(() => previous.kill('SIGKILL'), 2000)
    timeout.unref(); previous.once('exit', () => clearTimeout(timeout))
  }
  return {
    create(handle: Buffer, bounds: Bounds, host?: { backend: 'x11' }): void {
      if (host?.backend !== 'x11' || ![4, 8].includes(handle.length)) throw new Error('需要显式选择的 X11 窗口')
      const id = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())
      if (!id || id > 0xffffffffn) throw new Error('无效的 X11 窗口')
      destroy(); lastBounds = ''; lastVisible = undefined; lastPresentation = ''
      const process = spawn(executable, ['--stdio-v1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      child = process; snapshot = { alive: true }
      const failed = (error: Error): void => { if (child === process) { failure = error; snapshot = { alive: false }; process.kill() } }
      process.on('error', error => failed(new Error('无法启动 Linux 播放进程：' + error.message)))
      process.stdin.on('error', error => failed(new Error('Linux 播放控制通道断开：' + error.message)))
      process.stderr.on('data', () => { /* Drain library diagnostics; never log media URLs or credentials. */ })
      process.stdout.setEncoding('utf8')
      process.stdout.on('data', (data: string) => {
        if (child !== process) return
        input += data
        if (input.length > LIMIT) { failed(new Error('Linux 播放状态过长')); return }
        let end: number
        while ((end = input.indexOf('\n')) >= 0) {
          const line = input.slice(0, end); input = input.slice(end + 1)
          try {
            const value: unknown = JSON.parse(line)
            if (!value || typeof value !== 'object' || typeof (value as NativePlaybackState).alive !== 'boolean') throw new Error('Invalid state')
            const next = value as NativePlaybackState
            if (next.actions && (!Array.isArray(next.actions) || next.actions.length > 32 || !next.actions.every(validAction))) throw new Error('Invalid actions')
            actions.push(...(next.actions ?? []))
            if (actions.length > 128) throw new Error('Action overflow')
            snapshot = { ...next, actions: undefined }
          } catch { failed(new Error('Linux 播放状态无效')); return }
        }
      })
      process.on('exit', (code, signal) => {
        if (child === process) { snapshot = { alive: false }; failure ??= new Error(`Linux 播放进程已退出（${signal ?? code ?? 'unknown'}）`) }
      })
      send(['create', id.toString(), ...rectangle(bounds), 'x11'])
    },
    setBounds(bounds: Bounds): void {
      const fields = rectangle(bounds), key = fields.join(',')
      if (key !== lastBounds) { send(['bounds', ...fields]); lastBounds = key }
    },
    setVisible(visible: boolean): void { if (visible !== lastVisible) { send(['visible', visible ? '1' : '0']); lastVisible = visible } },
    setPresentation(value: string): void { if (value !== lastPresentation) { send(['presentation', value]); lastPresentation = value } },
    command(args: string[]): void { send(['command', ...args]) },
    render(): void { if (failure) throw failure },
    state(): NativePlaybackState {
      if (failure) throw failure
      const value = { ...snapshot, actions }; actions = []; return value
    },
    destroy
  }
}
