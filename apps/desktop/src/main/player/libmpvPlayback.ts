import { app, screen, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { PlaybackAvailability, PlaybackControl, PlaybackSnapshot } from '@shared/desktop/playback'
import type { NativePlayback, NativePlaybackState } from './nativePlayback'
import { linuxPlaybackBackend } from './playbackDisplay'
import { createLinuxPlaybackBridge } from './linuxPlaybackBridge'

interface Bridge {
  create(handle: Buffer, bounds: { x: number; y: number; width: number; height: number; scale?: number }, host?: { backend: 'x11' }): void
  setBounds(bounds: { x: number; y: number; width: number; height: number; scale?: number }): void
  setVisible(visible: boolean): void
  setPresentation(presentation: string): void
  setRendererControls?(enabled: boolean): void
  setOcclusions?(rects: Array<{ x: number; y: number; width: number; height: number }>): void
  command(args: string[]): void
  render(): void
  state(): NativePlaybackState
  destroy(): void
}
function runtimePath(): string {
  const filename = process.platform === 'linux' ? 'playback-helper' : 'playback.node'
  return app.isPackaged ? path.join(process.resourcesPath, 'native-playback', filename)
    : path.join(app.getAppPath(), 'out', 'native-playback', filename)
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
  const nativeTracks = (): Array<Record<string, unknown>> => {
    try {
      const value: unknown = JSON.parse(bridge?.state()['track-list'] ?? '[]')
      return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []
    } catch { return [] }
  }
  const ownedSubtitle = (file: string): Record<string, unknown> | undefined => nativeTracks().find(track => {
    if (track.type !== 'sub' || typeof track['external-filename'] !== 'string') return false
    const normalize = (filename: string): string => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename)
    return normalize(track['external-filename']) === normalize(file)
  })
  return {
    create(): void {
      const availability = builtinPlaybackAvailability()
      if (!availability.available) throw new Error(availability.reason ?? '内置播放不可用')
      const window = getWindow()
      if (!window || window.isDestroyed()) throw new Error('主窗口不可用')
      if (!bridge) bridge = process.platform === 'linux' ? createLinuxPlaybackBridge(runtimePath())
        : createRequire(path.join(app.getAppPath(), 'package.json'))(runtimePath()) as Bridge
      if (process.platform === 'linux') {
        bridge.create(window.getNativeWindowHandle(), { x: 0, y: 0, width: 1, height: 1,
          scale: screen.getDisplayMatching(window.getBounds()).scaleFactor }, { backend: 'x11' })
      } else bridge.create(window.getNativeWindowHandle(), { x: 0, y: 0, width: 1, height: 1 })
      if (process.platform === 'win32') bridge.setRendererControls?.(true)
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
    read: () => {
      const value = bridge && alive ? bridge.state() : { alive: false }
      const zoom = getWindow()?.webContents.getZoomFactor() ?? 1
      return value.fullscreenPointerY == null ? value : { ...value, fullscreenPointerY: value.fullscreenPointerY / zoom }
    },
    viewport(rect, visible, state: PlaybackSnapshot, occlusions = []): void {
      if (!alive || !bridge) return
      const window = getWindow()
      if (!window || window.isDestroyed()) return
      // Synchronous geometry changes need no hide/show cycle. Hiding a focused
      // NSView hands first responder back to Chromium on every fullscreen resize.
      if (!visible) bridge.setVisible(false)
      const zoom = window.webContents.getZoomFactor()
      bridge.setBounds({ x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom,
        ...(process.platform === 'linux' ? { scale: screen.getDisplayMatching(window.getBounds()).scaleFactor } : {}) })
      bridge.setOcclusions?.(occlusions.map(area => ({ x: area.x * zoom, y: area.y * zoom, width: area.width * zoom, height: area.height * zoom })))
      bridge.setPresentation(state.presentation)
      if (visible) bridge.setVisible(true)
    },
    render(): void { if (alive) bridge?.render() },
    addSubtitle(file): void { command(['sub-add', file, 'select']) },
    updateGeneratedSubtitle(file, select): void {
      const track = ownedSubtitle(file)
      if (track && typeof track.id === 'number') {
        command(['sub-reload', String(track.id)])
        if (select) command(['set', 'sid', String(track.id)])
      } else command(['sub-add', file, select ? 'select' : 'auto', 'AI 日中字幕'])
    },
    removeGeneratedSubtitle(file, restoreId): void {
      const list = nativeTracks()
      const track = ownedSubtitle(file)
      if (!track || typeof track.id !== 'number') return
      command(['sub-remove', String(track.id)])
      if (track.selected) command(['set', 'sid', restoreId !== null && list.some(item => item.type === 'sub' && item.id === restoreId) ? String(restoreId) : 'no'])
    },
    generatedSubtitleSelected: file => ownedSubtitle(file)?.selected === true,
    selectedAudioStream(): number | null {
      const track = nativeTracks().find(track => track.type === 'audio' && track.selected === true)
      const index = track?.['ff-index']
      return track && !track.external && typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : null
    },
    destroy(): void { bridge?.destroy(); alive = false }
  }
}
