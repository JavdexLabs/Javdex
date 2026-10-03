/** Backend identity is fixed before Electron is ready. Environment variables and
 * native handle size cannot distinguish a Wayland parent from an X11 parent. */
export const LINUX_X11_PLAYBACK_FLAG = '--javdex-x11'

interface DisplayStartupHost {
  isReady(): boolean
  commandLine: {
    getSwitchValue(name: string): string
    appendSwitch(name: string, value: string): void
  }
}

let linuxBackend: 'x11' | null = null

export function configurePlaybackDisplay(
  host: DisplayStartupHost,
  { platform = process.platform, argv = process.argv }: { platform?: NodeJS.Platform; argv?: string[] } = {}
): void {
  if (platform !== 'linux') { linuxBackend = null; return }
  if (host.isReady()) throw new Error('播放显示后端必须在应用启动时选择；请退出应用后重新启动')
  const selected = host.commandLine.getSwitchValue('ozone-platform')
  if (argv.includes(LINUX_X11_PLAYBACK_FLAG)) {
    if (selected && selected !== 'x11') throw new Error('--javdex-x11 与 --ozone-platform 的选择冲突，请只选择一种显示后端')
    host.commandLine.appendSwitch('ozone-platform', 'x11')
    linuxBackend = 'x11'
  } else if (selected === 'x11') {
    linuxBackend = 'x11'
  } else linuxBackend = null
}

export function linuxPlaybackBackend(): 'x11' | null { return linuxBackend }
