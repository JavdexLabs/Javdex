import { app, screen, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import type { PlaybackAvailability, PlaybackControl, PlaybackOcclusion, PlaybackSnapshot } from '@shared/desktop/playback'
import type { NativePlayback, NativePlaybackState } from './nativePlayback'
import { linuxPlaybackBackend, windowsCanvasPlayback } from './playbackDisplay'
import { createLinuxPlaybackBridge } from './linuxPlaybackBridge'
import { createLinuxSharedTexture } from './linuxSharedTexture'
import { linuxPlaybackRenderNode } from './linuxPlaybackDevice'
import { linuxGpuImportLoader } from './linuxGpuImport'
import { createMacSharedTextureBridge } from './macSharedTexture'
import { createNativeSharedTextureBridge } from './nativeSharedTexture'

interface Bridge {
  create(handle: Buffer, bounds: { x: number; y: number; width: number; height: number; scale?: number }, host?: { backend: 'dmabuf' | 'software' }): void
  setBounds(bounds: { x: number; y: number; width: number; height: number; scale?: number }): void
  setVisible(visible: boolean): void
  setPresentation(presentation: string): void
  setRendererControls?(enabled: boolean): void
  setOcclusions?(rects: PlaybackOcclusion[]): void
  command(args: string[], generatedSubtitle?: boolean): void
  generatedSubtitles?(operation: 'update' | 'visible' | 'clear', document: string, visible: boolean, revision: number): void
  render(): void
  state(): NativePlaybackState
  inspect(): NativePlaybackState
  destroy(): void
}
function runtimePath(name?: string, backend = linuxPlaybackBackend()): string {
  const filename = name ?? (process.platform === 'linux'
    ? backend === 'software' ? 'playback-software-helper' : 'playback-dmabuf-helper' : 'playback.node')
  const experimental = filename === 'playback-dmabuf-helper' || filename === 'playback-fd.node'
  return app.isPackaged ? path.join(process.resourcesPath, backend === 'software' ? 'linux-software-playback' : experimental ? 'linux-texture-experimental' : 'native-playback', filename)
    : path.join(app.getAppPath(), 'out', ...(backend === 'software' ? ['linux-software-runtime', 'linux-x64'] : ['native-playback']), filename)
}
export function builtinPlaybackAvailability(backend = linuxPlaybackBackend()): PlaybackAvailability {
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) return { available: false, reason: '此平台的原生播放适配尚未实现，请显式使用外部播放器' }
  if (process.platform === 'linux' && !backend) return { available: false, reason: '请退出后以 --javdex-x11 或 --javdex-wayland 选择显示后端' }
  if (process.platform === 'linux' && backend !== null && !fs.existsSync(runtimePath('playback-fd.node', backend))) {
    return { available: false, reason: '安装包缺少 Linux 视频帧传输运行库' }
  }
  return fs.existsSync(runtimePath(undefined, backend)) ? { available: true, reason: null }
    : { available: false, reason: app.isPackaged
      ? '安装包缺少内置播放运行库，请使用包含播放运行库的安装包。'
      : '未安装内置播放运行库；开发构建可运行 npm run playback:native:build' }
}
export function createLibmpvPlayback(getWindow: () => BrowserWindow | null, backend = linuxPlaybackBackend()): NativePlayback {
  const canvas = process.platform === 'darwin' || process.platform === 'win32' && windowsCanvasPlayback()
  const generatedId = Number.MAX_SAFE_INTEGER
  let bridge: Bridge | null = null
  let alive = false
  let generation = 0
  let generatedRepliesExpected = 0
  let subtitleSelectionRevision = 0
  let overlayRevision = 0
  let generated: { file: string; visible: boolean; ownsSelection: boolean } | null = null
  const command = (args: string[], generatedSubtitle = false): void => {
    if (!alive || !bridge) throw new Error('播放内核未启动')
    const state = bridge.inspect()
    bridge.command(args, generatedSubtitle)
    if (generatedSubtitle && (['sub-add', 'sub-reload', 'sub-remove'].includes(args[0])
      || args[0] === 'set' && ['sid', 'sub-delay', 'sub-font-size'].includes(args[1]))) {
      // Linux sends through a pipe: its last snapshot may predate this command.
      generatedRepliesExpected = Math.max(generatedRepliesExpected, (state.generatedSubtitleCommandReplies ?? 0) + (state.generatedSubtitleCommandsPending ?? 0)) + 1
    }
  }
  const nativeTracks = (state = bridge?.inspect()): Array<Record<string, unknown>> => {
    try {
      const value: unknown = JSON.parse(state?.['track-list'] ?? '[]')
      if (!Array.isArray(value)) return []
      const tracks = value.filter(item => item && typeof item === 'object').map((track: Record<string, unknown>) => {
        const selection = track.type === 'sub' ? state?.sid : track.type === 'audio' ? state?.aid : undefined
        // track-list observations can retain old selected flags after a sid/aid change.
        return selection === 'no' || /^\d+$/.test(selection ?? '') ? { ...track, selected: String(track.id) === selection } : track
      })
      if (generated) tracks.push({ id: generatedId, type: 'sub', selected: generated.visible && state?.sid === 'no',
        title: 'AI 日中字幕', codec: 'ass', 'external-filename': generated.file })
      return tracks
    } catch { return [] }
  }
  const matchesGenerated = (file: string): boolean => {
    const normalize = (filename: string): string => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename)
    return generated !== null && normalize(generated.file) === normalize(file)
  }
  const overlay = (operation: 'update' | 'visible' | 'clear', document = '', visible = false): number => {
    if (!alive || !bridge?.generatedSubtitles || bridge.inspect().generatedSubtitleOverlayVersion !== 1)
      throw new Error('播放运行库需更新，请重新构建播放运行库并重启应用')
    const revision = ++overlayRevision
    bridge.generatedSubtitles(operation, document, visible, revision)
    return revision
  }
  const showGenerated = (visible: boolean): void => {
    if (!generated || generated.visible === visible) return
    generated.visible = visible
    overlay('visible', '', visible)
  }
  async function subtitleIdle(epoch: number): Promise<void> {
    const deadline = Date.now() + 5000
    for (;;) {
      if (!alive || !bridge || generation !== epoch) throw new Error('播放会话已结束')
      const state = bridge.inspect()
      if ((state.generatedSubtitleCommandsPending == null || state.generatedSubtitleCommandErrors == null) && process.platform !== 'linux') throw new Error('播放运行库需更新，请重新构建播放运行库并重启应用')
      if (state.generatedSubtitleCommandsPending === 0 && (state.generatedSubtitleCommandReplies ?? -1) >= generatedRepliesExpected) return
      if (Date.now() >= deadline) throw new Error('等待播放器更新字幕超时')
      // The platform render loop drains replies; Linux delivers them in snapshots.
      await delay(20)
    }
  }
  async function subtitleState(epoch: number, matches: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000
    for (;;) {
      if (!alive || generation !== epoch) throw new Error('播放会话已结束')
      if (matches()) return
      if (Date.now() >= deadline) throw new Error('等待播放器字幕轨道状态超时')
      // Command replies may arrive before the corresponding property observation.
      await delay(20)
    }
  }
  return {
    renderPolling: canvas ? false : undefined,
    create(): void {
      const availability = builtinPlaybackAvailability(backend)
      if (!availability.available) throw new Error(availability.reason ?? '内置播放不可用')
      const window = getWindow()
      if (!window || window.isDestroyed()) throw new Error('主窗口不可用')
      if (process.platform === 'darwin') bridge = createMacSharedTextureBridge(
        createRequire(path.join(app.getAppPath(), 'package.json'))(runtimePath(undefined, backend)), window)
      else if (process.platform === 'win32' && canvas) bridge = createNativeSharedTextureBridge(
        createRequire(path.join(app.getAppPath(), 'package.json'))(runtimePath(undefined, backend)).sharedTexture, window, 'win32')
      else bridge = process.platform === 'linux' ? createLinuxPlaybackBridge(runtimePath(undefined, backend), backend !== null
        ? onError => {
          const current = getWindow()
          if (!current || current.isDestroyed()) throw new Error('主窗口不可用')
          return createLinuxSharedTexture(current, runtimePath('playback-fd.node', backend), onError, backend === 'software')
        } : undefined, backend === 'dmabuf' ? linuxPlaybackRenderNode() : undefined, backend === 'dmabuf' ? linuxGpuImportLoader(app) : undefined)
        : createRequire(path.join(app.getAppPath(), 'package.json'))(runtimePath(undefined, backend)) as Bridge
      if (canvas) bridge.create(Buffer.alloc(0), { x: 0, y: 0, width: 1, height: 1,
        scale: screen.getDisplayMatching(window.getBounds()).scaleFactor })
      else if (process.platform === 'linux') {
        const selectedBackend = backend ?? 'dmabuf'
        bridge.create(Buffer.alloc(0), { x: 0, y: 0, width: 1, height: 1,
          scale: screen.getDisplayMatching(window.getBounds()).scaleFactor }, { backend: selectedBackend })
      } else bridge.create(window.getNativeWindowHandle(), { x: 0, y: 0, width: 1, height: 1 })
      bridge.setRendererControls?.(true)
      generatedRepliesExpected = 0
      overlayRevision = 0; generated = null
      alive = true
    },
    load(locator, options): void {
      generation++
      generated = null
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
      else if (control.kind === 'track') {
        if (control.type === 'sub') {
          subtitleSelectionRevision++
          if (control.id === generatedId && generated) {
            generated.ownsSelection = true
            command(['set', 'sid', 'no']); showGenerated(true)
          } else { if (generated) generated.ownsSelection = false; showGenerated(false); command(['set', 'sid', control.id === null ? 'no' : String(control.id)]) }
        } else command(['set', 'aid', control.id === null ? 'no' : String(control.id)])
      }
      else if (control.kind === 'subtitle-delay') command(['set', 'sub-delay', String(control.seconds)])
      else if (control.kind === 'subtitle-size') command(['set', 'sub-font-size', String(control.value)])
      else throw new Error('此控制应由播放会话处理')
    },
    read: () => {
      const value = bridge && alive ? bridge.state() : { alive: false }
      if (value['track-list'] || generated) value['track-list'] = JSON.stringify(nativeTracks(value))
      const zoom = getWindow()?.webContents.getZoomFactor() ?? 1
      return value.fullscreenPointerY == null ? value : { ...value, fullscreenPointerY: value.fullscreenPointerY / zoom }
    },
    viewport(rect, visible, state: PlaybackSnapshot, occlusions = []): void {
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
      bridge.setOcclusions?.(occlusions.map(area => ({ x: area.x * zoom, y: area.y * zoom, width: area.width * zoom, height: area.height * zoom,
        ...(area.radii ? { radii: area.radii.map(radius => radius * zoom) as PlaybackOcclusion['radii'] } : {}) })))
      bridge.setPresentation(state.presentation)
      if (visible) bridge.setVisible(true)
    },
    render(): void { if (alive) bridge?.render() },
    addSubtitle(file): void { subtitleSelectionRevision++; if (generated) generated.ownsSelection = false; showGenerated(false); command(['sub-add', file, 'select']) },
    async updateGeneratedSubtitle(file, select, signal, document): Promise<void> {
      const epoch = generation
      const selection = subtitleSelectionRevision
      await subtitleIdle(epoch)
      signal?.throwIfAborted()
      const errors = bridge?.inspect().generatedSubtitleCommandErrors ?? 0
      if (typeof document !== 'string') throw new Error('缺少生成的字幕时间轴')
      if (!bridge?.generatedSubtitles || bridge.inspect().generatedSubtitleOverlayVersion !== 1)
        throw new Error('播放运行库需更新，请重新构建播放运行库并重启应用')
      if (!matchesGenerated(file)) generated = { file, visible: false, ownsSelection: false }
      const owner = generated!
      if (select && selection === subtitleSelectionRevision) {
        command(['set', 'sid', 'no'], true)
        owner.ownsSelection = true
        await subtitleIdle(epoch)
        await subtitleState(epoch, () => signal?.aborted === true || selection !== subtitleSelectionRevision || bridge?.inspect().sid === 'no')
        signal?.throwIfAborted()
        if (selection === subtitleSelectionRevision && generated === owner) owner.visible = true
      }
      if (!alive || generation !== epoch) throw new Error('播放会话已结束')
      if (generated !== owner) return
      const revision = overlay('update', document, owner.visible)
      await subtitleState(epoch, () => (bridge?.inspect().generatedSubtitleRevision ?? 0) >= revision)
      await subtitleIdle(epoch)
      signal?.throwIfAborted()
      if ((bridge?.inspect().generatedSubtitleCommandErrors ?? 0) > errors) throw new Error('播放器未能更新 AI 字幕显示')
    },
    async removeGeneratedSubtitle(file, restoreId): Promise<void> {
      const epoch = generation, selection = subtitleSelectionRevision
      await subtitleIdle(epoch)
      const errors = bridge?.inspect().generatedSubtitleCommandErrors ?? 0
      if (!matchesGenerated(file)) return
      // Ownership records the command intent, even if a sid observation is late
      // or startup was cancelled between its reply and the property event.
      const selected = generated!.ownsSelection
      generated = null
      const revision = overlay('clear')
      await subtitleState(epoch, () => (bridge?.inspect().generatedSubtitleRevision ?? 0) >= revision)
      await subtitleIdle(epoch)
      if ((bridge?.inspect().generatedSubtitleCommandErrors ?? 0) > errors) throw new Error('播放器未能移除生成的字幕')
      if (selected && selection === subtitleSelectionRevision) {
        command(['set', 'sid', restoreId !== null && nativeTracks().some(item => item.type === 'sub' && item.id === restoreId) ? String(restoreId) : 'no'], true)
        await subtitleIdle(epoch)
      }
    },
    generatedSubtitleSelected: file => matchesGenerated(file) && generated!.visible && bridge?.inspect().sid === 'no',
    subtitleCommandErrors: () => bridge?.inspect().subtitleCommandErrors ?? 0,
    generatedSubtitleCommandErrors: () => bridge?.inspect().generatedSubtitleCommandErrors ?? 0,
    selectedAudioStream(): number | null {
      const track = nativeTracks().find(track => track.type === 'audio' && track.selected === true)
      const index = track?.['ff-index']
      return track && !track.external && typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : null
    },
    destroy(): void { generation++; generated = null; bridge?.destroy(); alive = false }
  }
}
