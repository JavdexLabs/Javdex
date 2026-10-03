import { app, screen, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { PlaybackAvailability, PlaybackControl, PlaybackSnapshot } from '@shared/desktop/playback'
import type { NativePlayback, NativePlaybackState } from './nativePlayback'
import { linuxPlaybackBackend } from './playbackDisplay'

interface Bridge {
  create(handle: Buffer, bounds: { x: number; y: number; width: number; height: number; scale?: number }, host?: { backend: 'x11' }): void
  setBounds(bounds: { x: number; y: number; width: number; height: number; scale?: number }): void
  setVisible(visible: boolean): void
  setPresentation(presentation: string): void
  command(args: string[]): void
  render(): void
  state(): NativePlaybackState
  destroy(): void
}
function runtimePath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'native-playback', 'playback.node')
    : path.join(app.getAppPath(), 'out', 'native-playback', 'playback.node')
}
export function builtinPlaybackAvailability(): PlaybackAvailability {
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) return { available: false, reason: '此平台的原生播放适配尚未实现，请显式使用外部播放器' }
  if (process.platform === 'linux' && linuxPlaybackBackend() !== 'x11') return { available: false, reason: 'Linux 内置播放首版需要 X11／XWayland；请退出后以 --javdex-x11 启动，或显式使用外部播放器' }
  if (process.platform === 'linux' && !process.env.DISPLAY) return { available: false, reason: '未提供 X11 显示（DISPLAY）；请启用 X11／XWayland，或显式使用外部播放器' }
  return fs.existsSync(runtimePath()) ? { available: true, reason: null }
    : { available: false, reason: '未安装内置播放运行库；开发构建可运行 npm run playback:native:build' }
}
export function createLibmpvPlayback(getWindow: () => BrowserWindow | null): NativePlayback {
  let bridge: Bridge | null = null
  let alive = false
  const command = (args: string[]): void => {
    if (!alive || !bridge) throw new Error('播放内核未启动')
    bridge.command(args)
  }
  return {
    create(): void {
      const availability = builtinPlaybackAvailability()
      if (!availability.available) throw new Error(availability.reason ?? '内置播放不可用')
      const window = getWindow()
      if (!window || window.isDestroyed()) throw new Error('主窗口不可用')
      if (!bridge) bridge = createRequire(path.join(app.getAppPath(), 'package.json'))(runtimePath()) as Bridge
      if (process.platform === 'linux') {
        bridge.create(window.getNativeWindowHandle(), { x: 0, y: 0, width: 1, height: 1,
          scale: screen.getDisplayMatching(window.getBounds()).scaleFactor }, { backend: 'x11' })
      } else bridge.create(window.getNativeWindowHandle(), { x: 0, y: 0, width: 1, height: 1 })
      alive = true
    },
    load(locator, options): void {
      command(['set', 'pause', 'yes'])
      command(['set', 'speed', '1'])
      command(['loadfile', locator, 'replace'])
      command(['set', 'pause', options?.paused ? 'yes' : 'no'])
    },
    command(control: PlaybackControl): void {
      if (control.kind === 'pause') command(['set', 'pause', control.paused ? 'yes' : 'no'])
      else if (control.kind === 'seek') command(['seek', String(control.seconds), control.relative ? 'relative+exact' : 'absolute+exact'])
      else if (control.kind === 'volume') command(['set', 'volume', String(control.value)])
      else if (control.kind === 'mute') command(['set', 'mute', control.muted ? 'yes' : 'no'])
      else if (control.kind === 'speed') command(['set', 'speed', String(control.value)])
      else if (control.kind === 'track') command(['set', control.type === 'audio' ? 'aid' : 'sid', control.id === null ? 'no' : String(control.id)])
      else if (control.kind === 'subtitle-delay') command(['set', 'sub-delay', String(control.seconds)])
      else if (control.kind === 'subtitle-size') command(['set', 'sub-font-size', String(control.value)])
      else throw new Error('此控制应由播放会话处理')
    },
    read: () => bridge && alive ? bridge.state() : { alive: false },
    viewport(rect, visible, state: PlaybackSnapshot): void {
      if (!alive || !bridge) return
      const window = getWindow()
      if (!window || window.isDestroyed()) return
      // Synchronous geometry changes need no hide/show cycle. Hiding a focused
      // NSView hands first responder back to Chromium on every fullscreen resize.
      if (!visible) bridge.setVisible(false)
      const zoom = window.webContents.getZoomFactor()
      bridge.setBounds({ x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom,
        ...(process.platform === 'linux' ? { scale: screen.getDisplayMatching(window.getBounds()).scaleFactor } : {}) })
      bridge.setPresentation(state.presentation)
      if (visible) bridge.setVisible(true)
    },
    render(): void { if (alive) bridge?.render() },
    addSubtitle(file): void { command(['sub-add', file, 'select']) },
    destroy(): void { bridge?.destroy(); alive = false }
  }
}
