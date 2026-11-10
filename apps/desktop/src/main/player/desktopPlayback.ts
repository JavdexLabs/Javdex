import { createPlaybackEngine } from './playbackEngine'
import { app, dialog, shell, powerSaveBlocker, powerMonitor, type BrowserWindow } from 'electron'
import path from 'node:path'
import type { CatalogBackend } from '../application/catalogBackend'
import { removePlayedWatchLater } from '../application/watchLaterPlayback'
import { createPlaybackSession } from './playbackSession'
import { createPlaybackSourceResolver, playbackCatalogKey } from './playbackSource'
import { builtinPlaybackAvailability, createLibmpvPlayback } from './libmpvPlayback'
import { appCommandAdapter, appEventAdapter } from '../ipc/appContractAdapter'
import { IPC } from '@shared/ipc-channels'
import type { PlaybackRenderMode, PlaybackTarget } from '@shared/desktop/playback'
import type { PlayResult } from '@shared/libraryTypes'
import type { DesktopSettingsStore } from '../application/desktopPorts'
import { createPlaybackVolume } from './playbackVolume'
import { createPlaybackResumeStore } from './playbackResumeStore'
import { playbackFailure } from './playbackFailure'
import fs from 'node:fs/promises'
import { localAiDirectories } from '../services/localModels/modelStorage'
import { createAiSubtitleController } from './aiSubtitles/aiSubtitleController'
import { getLocalModels } from '../services/localModels/desktopLocalModels'
import { softwareStartupRequested } from '../bootstrap/startupGraphicsRecovery'
import { waitForLinuxPlaybackCompositing } from './linuxPlaybackDevice'
import { retireMacCpuSurface } from './macCpuShutdown'
import { schedulePlaybackRuntimePreload } from './playbackRuntimePreload'
import { preloadBuiltinPlaybackRuntime } from './playbackHostFactory'
import { disposeWindowsPlaybackInterop } from './windowsPlaybackInterop'
import { createSubtitleTasks } from './aiSubtitles/subtitleTasks'
import { inspectSubtitleMedia } from './aiSubtitles/offlineInference'
import { discoverSubtitleFiles } from './aiSubtitles/subtitleFiles'
import { createSubtitleDiscovery } from './subtitleDiscovery'
import { createSubtitleFileManagement } from './subtitleFileManagement'

let active: ReturnType<typeof createPlaybackSession> | null = null
let dispose: (() => Promise<void>) | null = null
export function pauseBuiltinPlayback(): void { active?.pause() }
export function stopBuiltinPlayback(): void { active?.stop() }
export function disposeBuiltinPlayback(): Promise<void> {
  try { return dispose?.() ?? Promise.resolve() }
  finally { disposeWindowsPlaybackInterop(); dispose = null; active = null }
}

export function registerBuiltinPlayback(backend: CatalogBackend, getWindow: () => BrowserWindow | null, settings: DesktopSettingsStore, recentStarted?: (videoId: number) => Promise<void>): (target: PlaybackTarget) => Promise<PlayResult> {
  const forceCpu = softwareStartupRequested(process.argv)
    || process.argv.slice(1, process.argv.indexOf('--') < 0 ? undefined : process.argv.indexOf('--')).includes('--javdex-cpu')
  const runtimePreload = schedulePlaybackRuntimePreload(getWindow, settings, forceCpu, preloadBuiltinPlaybackRuntime)
  let renderMode: PlaybackRenderMode = forceCpu ? 'cpu' : 'auto'
  const native = createPlaybackEngine(createLibmpvPlayback(getWindow), createLibmpvPlayback(getWindow, 'software'), {
    mode: () => renderMode,
    gpuAvailable: () => app.isHardwareAccelerationEnabled() && builtinPlaybackAvailability().available,
    gpuUnavailableReason: () => app.isHardwareAccelerationEnabled() ? 'GPU_INITIALIZATION_FAILED' : 'GPU_DISABLED'
  }, process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux')
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
  let observationRevision = 0
  const session = createPlaybackSession({
    native, ...resolver,
    ...(process.platform === 'linux' ? { prepareNative: async () => {
      if (renderMode !== 'cpu') await waitForLinuxPlaybackCompositing()
    } } : {}),
    ending: () => { void stopSubtitles().catch(() => { console.warn('[playback] unable to finish subtitle cleanup') }) },
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
      observationRevision++
      if (!state) void volume.flush()
      const window = getWindow()
      if (window && !window.isDestroyed()) appEventAdapter.send(window.webContents, IPC.PLAYBACK_CHANGED, { revision: observationRevision, snapshot: state })
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
    started: async source => {
      const current = (): boolean => source.identityKey === playbackCatalogKey(backend)
      if (!current()) return
      await recentStarted?.(source.target.videoId)
      if (current()) await removePlayedWatchLater(backend, source.target.videoId, current)
    },
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
  const aiPaths = localAiDirectories(app.getPath('userData'))
  const subtitleDiscovery = createSubtitleDiscovery({ filename: path.join(app.getPath('userData'), 'subtitle-selection.json'),
    native, playback: session.snapshot, source: session.aiSubtitleSource, validate: resolver.validate,
    add: session.addSubtitle, select: (id, track) => session.control(id, { kind: 'track', type: 'sub', id: track }) })
  const subtitleTasks = createSubtitleTasks({ root: path.join(app.getPath('userData'), 'subtitle-tasks'), cacheRoot: path.join(aiPaths.cache, 'cache'),
    resolve: async target => {
      if (backend.mode !== 'local') throw new Error('后台字幕任务目前仅支持本机资源')
      return resolver.resolve(target)
    }, validate: resolver.validate,
    runtime: getLocalModels().subtitleRuntime(), acquireRuntime: () => getLocalModels().acquireSubtitleRuntime(),
    saved: (source, filename) => {
      void subtitleDiscovery.associate(source, filename).then(() => {
        const playback = session.snapshot()
        if (playback && session.aiSubtitleSource(playback.sessionId).resumeKey === source.resumeKey) return subtitleDiscovery.refresh()
      }).catch(() => { console.warn('[subtitles] saved subtitle association could not be refreshed') })
    }
  })
  const aiSubtitles = createAiSubtitleController({
    background: subtitleTasks,
    root: aiPaths.cache, workRoot: aiPaths.work, native,
    runtime: getLocalModels().subtitleRuntime(),
    acquireRuntime: () => getLocalModels().acquireSubtitleRuntime(),
    onRuntimeChanged: listener => getLocalModels().onChanged(listener),
    playback: session.snapshot, source: session.aiSubtitleSource,
    resolve: async source => {
      await resolver.validate(source)
      // The session-owned local route renews its upstream grant when necessary.
      // Probe, recognition chunks and the decoder all share this same route.
      return source
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
      const directory = aiPaths.work
      await fs.mkdir(directory, { recursive: true })
      const filename = path.join(directory, 'AI-subtitle-log.html')
      await fs.writeFile(filename, content, 'utf8')
      const error = await shell.openPath(filename)
      if (error) throw new Error('无法打开日志，请检查系统的默认浏览器')
    }
  })
  const stopSubtitles = aiSubtitles.stop
  const renderTimer = native.renderPolling === false ? null : setInterval(() => {
    try { native.render() } catch (error) { session.fail(playbackFailure(error, 'video').message) }
  }, 16)
  const stateTimer = setInterval(() => {
    try { session.tick() } catch (error) { session.fail(playbackFailure(error, 'native').message) }
    try { aiSubtitles.tick(session.snapshot()) } catch { /* Optional subtitles cannot fail the video decoder. */ }
    try { subtitleDiscovery.tick(session.snapshot()); session.subtitleNotice(subtitleDiscovery.notice()) } catch { /* Discovery cannot interrupt media playback. */ }
  }, 200)
  renderTimer?.unref(); stateTimer.unref()
  const onSuspend = (): void => { runtimePreload.dispose(); session.pause() }
  powerMonitor.on('suspend', onSuspend)
  const unsubscribe = backend.onSessionChanged?.(() => session.stop())
  const unsubscribeSettings = settings.onChanged?.(value => {
    runtimePreload.settingsChanged(value)
    recordingEnabled = value.resumePlayback === true
    if (!recordingEnabled) session.stopRecording()
  })
  dispose = () => {
    runtimePreload.dispose()
    const snapshot = session.snapshot()
    let surface = snapshot?.sharedTextureSurface
    // Recovery can switch to CPU between state samples. Only inspect an
    // already-active CPU producer; a GPU read could itself start recovery.
    if (process.platform === 'darwin' && snapshot && bound && !bound.isDestroyed()) {
      try {
        surface = native.currentCpuSurface() ?? surface
      } catch { /* Keep the last published surface if the producer has gone. */ }
    }
    const contents = process.platform === 'darwin' && surface?.startsWith('cpu:') && bound && !bound.isDestroyed()
      ? bound.webContents : undefined
    if (renderTimer) clearInterval(renderTimer)
    clearInterval(stateTimer); unsubscribe?.(); unsubscribeSettings?.()
    powerMonitor.off('suspend', onSuspend)
    bound?.off('closed', onClosed); bound?.off('hide', onHidden); bound?.off('leave-full-screen', onFullscreenExit)
    bound?.off('minimize', onMinimized)
    session.stop()
    return Promise.all([aiSubtitles.close(), subtitleTasks.close(), subtitleDiscovery.close(), contents && surface ? retireMacCpuSurface(contents, surface) : Promise.resolve()]).then(() => {})
  }
  const availability = () => {
    const gpu = builtinPlaybackAvailability(renderMode === 'cpu' ? 'software' : undefined)
    return renderMode === 'auto' && !gpu.available ? builtinPlaybackAvailability('software') : gpu
  }
  appCommandAdapter.register(IPC.PLAYBACK_AVAILABILITY, availability)
  appCommandAdapter.register(IPC.PLAYBACK_SNAPSHOT, () => ({ revision: observationRevision, snapshot: session.snapshot() }))
  appCommandAdapter.register(IPC.PLAYBACK_AI_SUBTITLE_SNAPSHOT, aiSubtitles.snapshot)
  appCommandAdapter.register(IPC.PLAYBACK_AI_SUBTITLE_COMMAND, (id, command) => {
    if (command.action === 'start' || command.action === 'retry') subtitleDiscovery.suppressSelection()
    return aiSubtitles.command(id, command)
  })
  appCommandAdapter.register(IPC.SUBTITLE_TASKS_SNAPSHOT, subtitleTasks.snapshot)
  const subtitleFiles = createSubtitleFileManagement({
    resolve: async target => {
      if (backend.mode !== 'local') throw new Error('字幕文件管理目前仅支持本机资源')
      return resolver.resolve(target)
    },
    validate: resolver.validate, files: subtitleDiscovery.files, associate: subtitleDiscovery.associateFiles,
    choose: async () => {
      const window = getWindow()
      if (!window || window.isDestroyed()) throw new Error('应用窗口已关闭')
      const result = await dialog.showOpenDialog(window, { title: '关联字幕文件', properties: ['openFile', 'multiSelections'],
        filters: [{ name: '字幕文件', extensions: ['srt', 'ass'] }] })
      return result.canceled ? null : result.filePaths
    },
    changed: source => {
      const playback = session.snapshot()
      if (playback && session.aiSubtitleSource(playback.sessionId).resumeKey === source.resumeKey) void subtitleDiscovery.refresh()
    }
  })
  appCommandAdapter.register(IPC.SUBTITLE_FILES_LIST, subtitleFiles.list)
  appCommandAdapter.register(IPC.SUBTITLE_FILES_ADD, subtitleFiles.add)
  const prepareSubtitles = async (target: PlaybackTarget) => {
    if (backend.mode !== 'local') throw new Error('后台字幕任务目前仅支持本机资源')
    const source = await resolver.resolve(target)
    const subtitles = (await discoverSubtitleFiles(source.locator)).map(file => path.basename(file))
    let release: (() => void) | undefined
    try {
      release = await getLocalModels().acquireSubtitleRuntime()
      const metadata = await inspectSubtitleMedia(getLocalModels().subtitleRuntime().paths(), source.locator, AbortSignal.timeout(35000))
      await resolver.validate(source)
      return { source, ...metadata, subtitles, error: null }
    } catch (cause) {
      return { source, duration: null, audio: [], subtitles, error: cause instanceof Error ? cause.message : '无法读取音轨，请检查模型运行环境' }
    } finally { release?.() }
  }
  appCommandAdapter.register(IPC.SUBTITLE_TASKS_PREPARE, async target => {
    const { duration, audio, subtitles, error } = await prepareSubtitles(target)
    return { duration, audio, subtitles, error }
  })
  appCommandAdapter.register(IPC.SUBTITLE_TASKS_COMMAND, async command => {
    if (command.action === 'enqueue') {
      const prepared = await prepareSubtitles(command.target)
      if (prepared.duration == null) throw new Error(prepared.error ?? '无法读取影片时长')
      if (!prepared.audio.some(audio => audio.index === command.audioIndex)) throw new Error('所选音轨已变化，请刷新后重试')
      await subtitleTasks.enqueue(prepared.source, command.audioIndex, prepared.duration, command.output)
    } else if (command.action === 'save-as' || command.action === 'export-srt') {
      const job = (await subtitleTasks.snapshot()).tasks.find(job => job.id === command.id)
      if (!job) throw new Error('字幕任务不存在')
      const window = getWindow()
      if (!window || window.isDestroyed()) throw new Error('应用窗口已关闭')
      const srt = command.action === 'export-srt'
      const destination = await subtitleTasks.destination(job.id)
      const selected = await dialog.showSaveDialog(window, { title: srt ? '导出 SRT 字幕' : '保存 AI 字幕（同名文件将替换）',
        defaultPath: srt ? destination.replace(/\.ass$/i, '.srt') : destination,
        filters: [{ name: srt ? 'SRT 字幕' : 'ASS 字幕', extensions: [srt ? 'srt' : 'ass'] }], properties: ['showOverwriteConfirmation'] })
      if (!selected.canceled && selected.filePath) await subtitleTasks.action(job.id, 'retry-save', { filename: selected.filePath, replace: true, srt })
    } else await subtitleTasks.action(command.id, command.action)
    return subtitleTasks.snapshot()
  })
  appCommandAdapter.register(IPC.PLAYBACK_SUBTITLE_REFRESH, async id => {
    if (session.snapshot()?.sessionId !== id) throw new Error('播放会话已变化')
    await subtitleDiscovery.refresh()
    return subtitleDiscovery.notice()
  })
  const open = async (target: PlaybackTarget): Promise<PlayResult> => {
    runtimePreload.beginPlayback()
    renderMode = forceCpu ? 'cpu' : (await settings.read()).playbackRenderMode ?? 'auto'
    const available = availability()
    if (!available.available) return { ok: false, error: available.reason ?? '内置播放不可用' }
    try {
      bind()
      if (!await session.open(target)) return { ok: false, error: '播放请求已更新或取消' }
      return { ok: true }
    }
    catch (error) {
      const failure = playbackFailure(error)
      console.warn('[playback] open failed', failure.code)
      return { ok: false, error: failure.message, ...(failure.code === 'missing' ? { fileMissing: true } : {}) }
    }
  }
  appCommandAdapter.register(IPC.PLAYBACK_OPEN, open)
  appCommandAdapter.register(IPC.PLAYBACK_CONTROL, (id, command) => {
    if (session.snapshot()?.sessionId === id && command.kind === 'track' && command.type === 'sub') {
      subtitleDiscovery.selected(command.id)
      if (command.id !== Number.MAX_SAFE_INTEGER) aiSubtitles.selectionChanged()
    }
    return session.control(id, command)
  })
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
    aiSubtitles.selectionChanged()
    subtitleDiscovery.manual(file)
  })
  return open
}
