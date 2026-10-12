/** Backend identity is fixed before Electron is ready. Environment variables and
 * native handle size cannot distinguish a Wayland parent from an X11 parent. */
export const LINUX_X11_PLAYBACK_FLAG = '--javdex-x11'

interface DisplayStartupHost {
  isReady(): boolean
  commandLine: {
    appendSwitch(name: string, value: string): void
  }
}

let linuxBackend: 'x11' | null = null

export function configurePlaybackDisplay(
  host: DisplayStartupHost,
  { platform = process.platform, argv = process.argv, windowsNativePlayback = false }:
    { platform?: NodeJS.Platform; argv?: string[]; windowsNativePlayback?: boolean } = {}
): void {
  if (platform === 'win32' && windowsNativePlayback) {
    if (host.isReady()) throw new Error('播放显示后端必须在应用启动时选择；请退出应用后重新启动')
    // Chromium's DirectComposition tree obscures the sibling WGL/Win32 child
    // surfaces. Use its normal GPU swap chain so video and controls compose.
    host.commandLine.appendSwitch('disable-direct-composition', '')
  }
  if (platform !== 'linux') { linuxBackend = null; return }
  if (host.isReady()) throw new Error('播放显示后端必须在应用启动时选择；请退出应用后重新启动')
  // Electron may already report an ozone default (including x11) before ready.
  // Only startup arguments prove opt-in. Match Chromium's switch rules: skip the
  // executable, trim ASCII whitespace, stop at --, and use the last = value.
  let explicitX11 = false
  let selected: string | undefined
  for (const rawArg of argv.slice(1)) {
    const arg = rawArg.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '')
    if (arg === '--') break
    if (arg === LINUX_X11_PLAYBACK_FLAG) explicitX11 = true
    const ozone = /^--?ozone-platform(?:=([\s\S]*))?$/.exec(arg)
    if (ozone) selected = ozone[1] ?? ''
  }
  if (explicitX11) {
    if (selected !== undefined && selected !== 'x11') throw new Error('--javdex-x11 与 --ozone-platform 的选择冲突，请只选择一种显示后端')
    host.commandLine.appendSwitch('ozone-platform', 'x11')
    linuxBackend = 'x11'
  } else if (selected === 'x11') {
    linuxBackend = 'x11'
  } else linuxBackend = null
}

export function linuxPlaybackBackend(): 'x11' | null { return linuxBackend }
