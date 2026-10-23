/** Backend identity is fixed before Electron is ready. Environment variables and
 * native handle size cannot distinguish a Wayland parent from an X11 parent. */
export const LINUX_X11_PLAYBACK_FLAG = '--javdex-x11'
export const LINUX_DMABUF_PLAYBACK_FLAG = '--javdex-dmabuf'
export const LINUX_WAYLAND_PLAYBACK_FLAG = '--javdex-wayland'
export const WINDOWS_CANVAS_PLAYBACK_FLAG = '--javdex-windows-canvas'

interface DisplayStartupHost {
  isReady(): boolean
  commandLine: {
    appendSwitch(name: string, value: string): void
  }
}

let linuxBackend: 'dmabuf' | 'software' | null = null
let windowsCanvas = false

export function configurePlaybackDisplay(
  host: DisplayStartupHost,
  { platform = process.platform, argv = process.argv, windowsNativePlayback = false }:
    { platform?: NodeJS.Platform; argv?: string[]; windowsNativePlayback?: boolean } = {}
): void {
  // Temporary migration gate. Native Windows acceptance must precede changing
  // the default. Canvas must not inherit the old HWND composition workaround.
  const argumentsTrimmed = argv.slice(1).map(arg => arg.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, ''))
  const separator = argumentsTrimmed.indexOf('--')
  const beforeSeparator = separator < 0 ? argumentsTrimmed : argumentsTrimmed.slice(0, separator)
  if (platform === 'win32' && host.isReady()) throw new Error('播放显示后端必须在应用启动时选择；请退出应用后重新启动')
  windowsCanvas = platform === 'win32' && beforeSeparator.includes(WINDOWS_CANVAS_PLAYBACK_FLAG)
  if (platform === 'win32' && windowsNativePlayback && !windowsCanvas) {
    // Chromium's DirectComposition tree obscures the sibling WGL/Win32 child
    // surfaces. Use its normal GPU swap chain so video and controls compose.
    host.commandLine.appendSwitch('disable-direct-composition', '')
  }
  if (platform !== 'linux') { linuxBackend = null; return }
  if (host.isReady()) throw new Error('播放显示后端必须在应用启动时选择；请退出应用后重新启动')
  // Electron may already report an ozone default (including x11) before ready.
  // Only startup arguments prove opt-in. Match Chromium's switch rules: skip the
  // executable, trim ASCII whitespace, stop at --, and use the last = value.
  const software = argv.slice(1, argv.indexOf('--') < 0 ? undefined : argv.indexOf('--')).includes('--javdex-cpu')
  let explicitX11 = false, explicitWayland = false, sharedTexture = false
  let selected: string | undefined
  for (const rawArg of argv.slice(1)) {
    const arg = rawArg.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '')
    if (arg === '--') break
    if (arg === LINUX_X11_PLAYBACK_FLAG) explicitX11 = true
    if (arg === LINUX_WAYLAND_PLAYBACK_FLAG) explicitWayland = true
    if (arg === LINUX_DMABUF_PLAYBACK_FLAG) sharedTexture = true
    const ozone = /^--?ozone-platform(?:=([\s\S]*))?$/.exec(arg)
    if (ozone) selected = ozone[1] ?? ''
  }
  if (explicitX11 && explicitWayland) throw new Error('--javdex-x11 与 --javdex-wayland 的选择冲突，请只选择一种显示后端')
  const explicit = explicitX11 ? 'x11' : explicitWayland ? 'wayland' : undefined
  if (explicit && selected !== undefined && selected !== explicit) throw new Error('Javdex 显示参数与 --ozone-platform 的选择冲突，请只选择一种显示后端')
  sharedTexture ||= explicitWayland
  const display = explicit ?? selected ?? (sharedTexture ? 'wayland' : undefined)
  if (sharedTexture && display !== 'x11' && display !== 'wayland') throw new Error('实验共享纹理播放只支持明确选择的 X11 或 Wayland 显示后端')
  if (explicit || sharedTexture && selected === undefined) host.commandLine.appendSwitch('ozone-platform', display!)
  linuxBackend = display === 'x11' || display === 'wayland' ? software ? 'software' : 'dmabuf' : null
}

export function linuxPlaybackBackend(): 'dmabuf' | 'software' | null { return linuxBackend }
export function windowsCanvasPlayback(): boolean { return windowsCanvas }
