import { app, screen, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { PlaybackAvailability } from '@shared/desktop/playback'
import type { NativePlaybackState } from './nativePlayback'
import { linuxPlaybackBackend } from './playbackDisplay'
import { createLinuxPlaybackBridge } from './linuxPlaybackBridge'
import { createLinuxSharedTexture } from './linuxSharedTexture'
import { linuxPlaybackRenderNode } from './linuxPlaybackDevice'
import { linuxGpuImportLoader } from './linuxGpuImport'
import { createNativeSharedTextureBridge } from './nativeSharedTexture'
import { createSoftwarePlaybackBridge } from './softwarePlayback'
import { createIsolatedPlaybackHost } from './isolatedPlaybackHost'
import { graphicsPlaybackFailure } from './playbackGraphicsFailure'

export interface PlaybackHostBridge {
  create(bounds: { x: number; y: number; width: number; height: number; scale?: number }): void
  setBounds(bounds: { x: number; y: number; width: number; height: number; scale?: number }): void
  setVisible(visible: boolean): void
  command(args: string[], generatedSubtitle?: boolean): void
  generatedSubtitles?(operation: 'update' | 'visible' | 'clear', document: string, visible: boolean, revision: number): void
  render(): void
  state(): NativePlaybackState
  inspect(): NativePlaybackState
  destroy(): void
}
function runtimePath(name?: string, backend = linuxPlaybackBackend()): string {
  const linuxSoftware = process.platform === 'linux' && backend === 'software'
  const filename = name ?? (process.platform === 'linux'
    ? backend === 'software' ? 'playback-software-helper' : 'playback-dmabuf-helper' : 'playback.node')
  const experimental = filename === 'playback-dmabuf-helper' || filename === 'playback-fd.node'
  return app.isPackaged ? path.join(process.resourcesPath, linuxSoftware ? 'linux-software-playback' : experimental ? 'linux-texture-experimental' : 'native-playback', filename)
    : path.join(app.getAppPath(), 'out', ...(linuxSoftware ? ['linux-software-runtime', 'linux-x64'] : ['native-playback']), filename)
}
export function builtinPlaybackAvailability(backend = linuxPlaybackBackend()): PlaybackAvailability {
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) return { available: false, reason: '此平台的原生播放适配尚未实现，请显式使用外部播放器' }
  if (process.platform === 'linux' && !backend) return { available: false, reason: '请退出后以 --javdex-x11 或 --javdex-wayland 选择显示后端' }
  if (process.platform === 'linux' && backend !== null && !fs.existsSync(runtimePath('playback-fd.node', backend))) {
    return { available: false, reason: '安装包缺少 Linux 视频帧传输运行库' }
  }
  if (process.platform !== 'linux' && backend !== 'software' && !fs.existsSync(runtimePath('playback-interop.node', backend)))
    return { available: false, reason: '播放运行库需更新，请重新构建播放运行库' }
  return fs.existsSync(runtimePath(undefined, backend)) ? { available: true, reason: null }
    : { available: false, reason: app.isPackaged
      ? '安装包缺少内置播放运行库，请使用包含播放运行库的安装包。'
      : '未安装内置播放运行库；开发构建可运行 npm run playback:native:build' }
}
/** Only this factory selects operating-system resource transport. Product mode,
 * recovery, commands and subtitle ownership remain in the shared layers. */
export function createPlaybackHostBridge(getWindow: () => BrowserWindow | null, backend = linuxPlaybackBackend()): PlaybackHostBridge {
  let bridge: PlaybackHostBridge
  const availability = builtinPlaybackAvailability(backend)
  if (!availability.available) throw new Error(availability.reason ?? '内置播放不可用')
  const window = getWindow()
  if (!window || window.isDestroyed()) throw new Error('主窗口不可用')
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const producer = createIsolatedPlaybackHost(runtimePath(undefined, backend), backend === 'software' ? 'cpu' : 'gpu')
    bridge = backend === 'software'
      ? createSoftwarePlaybackBridge(producer as Parameters<typeof createSoftwarePlaybackBridge>[0], window, process.platform)
      : createNativeSharedTextureBridge(producer as Parameters<typeof createNativeSharedTextureBridge>[0], window, process.platform)
  } else bridge = createLinuxPlaybackBridge(runtimePath(undefined, backend), backend !== null
    ? onError => {
      const current = getWindow()
      if (!current || current.isDestroyed()) throw new Error('主窗口不可用')
      return createLinuxSharedTexture(current, runtimePath('playback-fd.node', backend), onError, backend === 'software')
    } : undefined, backend === 'dmabuf' ? linuxPlaybackRenderNode() : undefined, backend === 'dmabuf' ? linuxGpuImportLoader(app) : undefined, backend ?? 'dmabuf')
  try { bridge.create({ x: 0, y: 0, width: 1, height: 1, scale: screen.getDisplayMatching(window.getBounds()).scaleFactor }) }
  catch (error) { if (backend !== 'software') throw graphicsPlaybackFailure('GPU_INITIALIZATION_FAILED'); throw error }
  return bridge
}
