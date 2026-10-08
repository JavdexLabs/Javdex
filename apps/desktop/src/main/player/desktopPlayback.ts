import { app, dialog, shell, powerSaveBlocker, powerMonitor, type BrowserWindow } from 'electron'
import path from 'node:path'
import type { CatalogBackend } from '../application/catalogBackend'
import { removePlayedWatchLater } from '../application/watchLaterPlayback'
import { createPlaybackSession } from './playbackSession'
import { createPlaybackSourceResolver } from './playbackSource'
import { builtinPlaybackAvailability, createLibmpvPlayback } from './libmpvPlayback'
import { appCommandAdapter, appEventAdapter } from '../ipc/appContractAdapter'
import { IPC } from '@shared/ipc-channels'
import type { PlaybackTarget, PlaybackOpenOptions } from '@shared/desktop/playback'
import type { PlayResult } from '@shared/libraryTypes'
import type { DesktopSettingsStore } from '../application/desktopPorts'
import { createPlaybackVolume } from './playbackVolume'
import { createPlaybackResumeStore } from './playbackResumeStore'
import { PlaybackFailure, playbackFailure } from './playbackFailure'
import { navigateWindowHistory } from '../desktop/windowNavigation'
import fs from 'node:fs/promises'
import { createAiSubtitleController } from './aiSubtitles/aiSubtitleController'
import { getLocalModels } from '../services/localModels/desktopLocalModels'

let active: ReturnType<typeof createPlaybackSession> | null = null
let dispose: (() => Promise<void>) | null = null
export function pauseBuiltinPlayback(): void { active?.pause() }
export function stopBuiltinPlayback(): void { active?.stop() }
export function disposeBuiltinPlayback(): Promise<void> {
  const pending = dispose?.() ?? Promise.resolve()
  dispose = null; active = null
  return pending
}

export function registerBuiltinPlayback(backend: CatalogBackend, getWindow: () => BrowserWindow | null, settings: DesktopSettingsStore): (target: PlaybackTarget) => Promise<PlayResult> {
  const native = createLibmpvPlayback(getWindow)
  const resolver = createPlaybackSourceResolver(backend)
  const volume = createPlaybackVolume(settings)
  let recordingEnabled = false
  const progress = createPlaybackResumeStore(path.join(app.getPath('userData'), 'playback-progress.json'), () => recordingEnabled)
  let blocker: number | null = null
  let bound: BrowserWindow | null = null
  let returnFromFullscreen = false
  const onClosed = (): void => { active?.stop(); bound = null }
  // macOS emits hide during a fullscreen transition while the window remains visible.
  const onHidden = (): void => { if (bound && !bound.isDestroyed() && !bound.isVisible()) active?.pause() }
  const onMinimized = (): void => { active?.pause() }
  const onFullscreenExit = (): void => {
    const state = active?.snapshot()
    if (state?.presentation === 'fullscreen') active?.control(state.sessionId, { kind: 'presentation', value: 'expanded' })
    if (returnFromFullscreen) {
      // AppKit may reset first responder after React already restored DOM focus.
      // Complete the native -> HTML handoff when the fullscreen animation finishes.
      returnFromFullscreen = false
      if (bound && !bound.isDestroyed()) bound.webContents.focus()
    }
  }
  const bind = (): void => {
    const window = getWindow()
    if (!window || bound === window) return
    bound?.off('closed', onClosed); bound?.off('hide', onHidden); bound?.off('leave-full-screen', onFullscreenExit)
    bound?.off('minimize', onMinimized)
    bound = window
    window.on('closed', onClosed); window.on('hide', onHidden); window.on('leave-full-screen', onFullscreenExit)
    window.on('minimize', onMinimized)
    window.webContents.once('render-process-gone', onClosed)
  }
  const session = createPlaybackSession({
    native, ...resolver,
    readVolume: volume.read,
    volumeChanged: volume.remember,
    progress: {
      prepare: async source => {
        recordingEnabled = (await settings.read()).resumePlayback === true
        return { enabled: recordingEnabled, point: progress.get(source.resumeKey) }
      },
      save: (source, point) => progress.save(source.resumeKey, point),
      clear: source => progress.clearConfirmed(source.resumeKey)
    },
    changed: state => {
      if (!state) void volume.flush()
      const window = getWindow()
      if (window && !window.isDestroyed()) appEventAdapter.send(window.webContents, IPC.PLAYBACK_CHANGED, state)
    },
    presentation: value => {
      const window = getWindow()
      if (!window || window.isDestroyed()) return
      if (value === 'fullscreen') returnFromFullscreen = false
      else if (window.isFullScreen()) returnFromFullscreen = true
      window.setFullScreen(value === 'fullscreen')
    },
    focusControls: () => {
      const window = getWindow()
      if (window && !window.isDestroyed()) {
        if (process.platform === 'win32') window.focusOnWebView()
        else window.webContents.focus()
      }
    },
    navigate: direction => navigateWindowHistory(getWindow(), direction),
    started: async source => { await removePlayedWatchLater(backend, source.target.videoId) },
    awake: playing => {
      if (playing && blocker == null) blocker = powerSaveBlocker.start('prevent-display-sleep')
      if (!playing && blocker != null) { powerSaveBlocker.stop(blocker); blocker = null }
    },
    windowSize: () => {
      const window = getWindow()
      const [width, height] = window?.getContentSize() ?? [0, 0]
      const zoom = window?.webContents.getZoomFactor() ?? 1
      return { width: width / zoom, height: height / zoom }
    }
  })
  active = session
  const aiSubtitles = createAiSubtitleController({
    root: path.join(app.getPath('userData'), 'ai-subtitles'), native,
    runtime: getLocalModels().subtitleRuntime(),
    acquireRuntime: () => getLocalModels().acquireSubtitleRuntime(),
    onRuntimeChanged: listener => getLocalModels().onChanged(listener),
    playback: session.snapshot, source: session.aiSubtitleSource,
    resolve: async source => {
      await resolver.validate(source)
      if (source.mode === 'local') return source
      const renewed = await resolver.resolve(source.target)
      if (renewed.identityKey !== source.identityKey || renewed.revision !== source.revision) throw new Error('影片资源已变化，请重新打开影片')
      return renewed
    },
    changed: state => {
      const window = getWindow()
      if (window && !window.isDestroyed()) appEventAdapter.send(window.webContents, IPC.PLAYBACK_AI_SUBTITLE_CHANGED, state)
    },
    exportFile: async content => {
      const window = getWindow()
      if (!window || window.isDestroyed()) return
      const selected = await dialog.showSaveDialog(window, { title: '导出 AI 字幕', defaultPath: 'AI-日中字幕.ass',
        filters: [{ name: 'ASS 字幕', extensions: ['ass'] }, { name: 'SRT 字幕', extensions: ['srt'] }] })
      if (!selected.canceled && selected.filePath) await fs.writeFile(selected.filePath, path.extname(selected.filePath).toLowerCase() === '.srt' ? content.srt : content.ass, 'utf8')
    },
    openLog: async content => {
      const directory = path.join(app.getPath('userData'), 'ai-subtitles', 'work')
      await fs.mkdir(directory, { recursive: true })
      const filename = path.join(directory, 'AI-subtitle-log.html')
      await fs.writeFile(filename, content, 'utf8')
      const error = await shell.openPath(filename)
      if (error) throw new Error('无法打开日志，请检查系统的默认浏览器')
    }
  })
  const renderTimer = setInterval(() => {
    try { native.render() } catch { session.fail(new PlaybackFailure('video').message) }
  }, 16)
  const stateTimer = setInterval(() => {
    try { session.tick() } catch { session.fail(new PlaybackFailure('native').message) }
    try { aiSubtitles.tick(session.snapshot()) } catch { /* Optional subtitles cannot fail the video decoder. */ }
  }, 200)
  renderTimer.unref(); stateTimer.unref()
  const onSuspend = (): void => { session.pause() }
  powerMonitor.on('suspend', onSuspend)
  const unsubscribe = backend.onSessionChanged?.(() => session.stop())
  const unsubscribeSettings = settings.onChanged?.(value => {
    recordingEnabled = value.resumePlayback === true
    if (!recordingEnabled) session.stopRecording()
  })
  dispose = () => {
    clearInterval(renderTimer); clearInterval(stateTimer); unsubscribe?.(); unsubscribeSettings?.()
    powerMonitor.off('suspend', onSuspend)
    bound?.off('closed', onClosed); bound?.off('hide', onHidden); bound?.off('leave-full-screen', onFullscreenExit)
    bound?.off('minimize', onMinimized)
    session.stop()
    return aiSubtitles.close()
  }
  appCommandAdapter.register(IPC.PLAYBACK_AVAILABILITY, builtinPlaybackAvailability)
  appCommandAdapter.register(IPC.PLAYBACK_SNAPSHOT, () => session.snapshot())
  appCommandAdapter.register(IPC.PLAYBACK_AI_SUBTITLE_SNAPSHOT, aiSubtitles.snapshot)
  appCommandAdapter.register(IPC.PLAYBACK_AI_SUBTITLE_COMMAND, aiSubtitles.command)
  const open = async (target: PlaybackTarget, options?: PlaybackOpenOptions): Promise<PlayResult> => {
    const availability = builtinPlaybackAvailability()
    if (!availability.available) return { ok: false, error: availability.reason ?? '内置播放不可用' }
    try {
      bind()
      if (!await session.open(target, options?.privateSession)) return { ok: false, error: '播放请求已更新或取消' }
      return { ok: true }
    }
    catch (error) {
      const failure = playbackFailure(error)
      console.warn('[playback] open failed', failure.code)
      return { ok: false, error: failure.message, ...(failure.code === 'missing' ? { fileMissing: true } : {}) }
    }
  }
  appCommandAdapter.register(IPC.PLAYBACK_OPEN, open)
  appCommandAdapter.register(IPC.PLAYBACK_CONTROL, (id, command) => session.control(id, command))
  appCommandAdapter.register(IPC.PLAYBACK_VIEWPORT, viewport => session.viewport(viewport))
  appCommandAdapter.register(IPC.PLAYBACK_CLEAR_PROGRESS, input => {
    if (input.scope === 'current') session.clearProgress(input.sessionId)
    else { progress.clearConfirmed(); session.stopRecording() }
  })
  appCommandAdapter.register(IPC.PLAYBACK_SUBTITLE, async id => {
    if (session.snapshot()?.sessionId !== id) throw new Error('播放会话已变化')
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    const selected = await dialog.showOpenDialog(window, { title: '选择本机外挂字幕', properties: ['openFile'], filters: [{ name: '字幕', extensions: ['srt', 'ass'] }] })
    if (selected.canceled || !selected.filePaths[0]) return
    const file = selected.filePaths[0]
    if (!['.srt', '.ass'].includes(path.extname(file).toLowerCase())) throw new Error('仅支持 SRT / ASS 字幕')
    session.addSubtitle(id, file)
  })
  return open
}
