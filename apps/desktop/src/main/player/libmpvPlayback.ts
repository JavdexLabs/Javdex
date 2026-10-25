import { screen, type BrowserWindow } from 'electron'
import type { PlaybackControl } from '@shared/desktop/playback'
import type { NativePlayback } from './nativePlayback'
import { linuxPlaybackBackend } from './playbackDisplay'
import { createPlaybackHostBridge, type PlaybackHostBridge } from './playbackHostFactory'
import { createGeneratedSubtitleDisplay } from './generatedSubtitleDisplay'
export { builtinPlaybackAvailability } from './playbackHostFactory'

export function createLibmpvPlayback(getWindow: () => BrowserWindow | null, backend = linuxPlaybackBackend()): NativePlayback {
  let bridge: PlaybackHostBridge | null = null
  let alive = false
  const subtitles = createGeneratedSubtitleDisplay()
  const command = subtitles.command

  return {
    renderPolling: false,
    create(): void {
      bridge = createPlaybackHostBridge(getWindow, backend)
      subtitles.bind(bridge)
      alive = true
    },
    load(locator, options): void {
      subtitles.loaded()
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
      else if (control.kind === 'track') subtitles.selectTrack(control.type, control.id)
      else if (control.kind === 'subtitle-delay') command(['set', 'sub-delay', String(control.seconds)])
      else if (control.kind === 'subtitle-size') command(['set', 'sub-font-size', String(control.value)])
      else throw new Error('此控制应由播放会话处理')
    },
    read: () => {
      const value = bridge && alive ? bridge.state() : { alive: false }
      return subtitles.decorate(value)
    },
    viewport(rect, visible): void {
      if (!alive || !bridge) return
      const window = getWindow()
      if (!window || window.isDestroyed()) return
      // Resize the current surface without a hide/show cycle or a new session.
      if (!visible) bridge.setVisible(false)
      const zoom = window.webContents.getZoomFactor()
      bridge.setBounds({ x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom,
        // Chromium's effective scale can include Windows accessibility text
        // scaling, which GetDpiForWindow alone does not include.
        scale: screen.getDisplayMatching(window.getBounds()).scaleFactor })
      if (visible) bridge.setVisible(true)
    },
    render(): void { if (alive) bridge?.render() },
    ...subtitles.display,
    destroy(): void { subtitles.destroy(); bridge?.destroy(); alive = false }
  }
}
