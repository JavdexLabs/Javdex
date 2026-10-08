import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AiSubtitleCommand, AiSubtitleSnapshot } from '@shared/desktop/aiSubtitles'
import type { PlaybackSnapshot } from '@shared/desktop/playback'
import type { NativePlayback } from '../nativePlayback'
import type { PlaybackSource } from '../playbackSource'
import { createAiRuntimeInstaller, aiSubtitleSupported } from './runtimeInstaller'
import { atomicWrite, createSubtitleCache, subtitleCacheKey } from './subtitleCache'
import { createOfflineSubtitleInference } from './offlineInference'
import { createSubtitleScheduler } from './subtitleScheduler'
import { renderSubtitleAss, renderSubtitleSrt, type SubtitleCue } from './subtitleDocument'
import { createSubtitleLog } from './subtitleLog'

interface Dependencies {
  root: string
  native: NativePlayback
  playback(): PlaybackSnapshot | null
  source(id: string): { source: PlaybackSource; privateSession: boolean }
  resolve(source: PlaybackSource): Promise<PlaybackSource>
  changed(state: AiSubtitleSnapshot): void
  exportFile(content: { ass: string; srt: string }): Promise<void>
  openLog?(content: string): Promise<void>
  runtime?: Pick<ReturnType<typeof createAiRuntimeInstaller>, 'installed' | 'paths'>
  inference?: typeof createOfflineSubtitleInference
  acquireRuntime?: () => Promise<() => void>
  onRuntimeChanged?: (listener: () => void) => () => void
}
const cleanedRoots = new Set<string>()
async function cleanStaleWork(root: string): Promise<void> {
  if (cleanedRoots.has(root)) return
  cleanedRoots.add(root)
  // Crash leftovers contain extracted audio and display text; never treat them as persistent caches.
  await Promise.all(['active', 'work'].map(name => fs.rm(path.join(root, name), { recursive: true, force: true })))
}
export function createAiSubtitleController(deps: Dependencies) {
  const log = createSubtitleLog()
  let logSession: string | null = null
  const installer = deps.runtime ?? createAiRuntimeInstaller(path.join(deps.root, 'models'))
  let inference: ReturnType<typeof createOfflineSubtitleInference> | null = null
  let scheduler: ReturnType<typeof createSubtitleScheduler> | null = null
  let cache: ReturnType<typeof createSubtitleCache> | null = null
  let stopping: Promise<void> | null = null
  let task: AbortController | null = null
  let audioIndex: number | null = null
  let privateSession = false
  let releaseRuntime: (() => void) | null = null
  let file: string | null = null
  let stoppingFile: string | null = null
  let previousSubtitle: number | null = null
  let cues: SubtitleCue[] = []
  let document = '', requestedDocument = '', renderLoop: Promise<void> | null = null
  let firstSelection = false
  let intent = 0
  let runtimeRevision = 0, closed = false
  const state: AiSubtitleSnapshot = { sessionId: null, supported: aiSubtitleSupported(), installed: false,
    enabled: false, phase: 'idle', activeStart: null, recognizedSeconds: 0, translatedSeconds: 0,
    duration: null, display: 'bilingual', fontSize: 42, error: null }
  const snapshot = (): AiSubtitleSnapshot => structuredClone(state)
  const publish = (): void => deps.changed(snapshot())
  async function refreshRuntime(): Promise<void> {
    const revision = ++runtimeRevision
    const value = await installer.installed()
    if (closed || revision !== runtimeRevision) return
    state.installed = value; publish()
  }
  const initialization = cleanStaleWork(deps.root).then(refreshRuntime)
    .catch(() => { if (!closed) { state.error = '离线字幕工作目录无法清理，请检查本机存储权限'; publish() } })
  const unsubscribe = deps.onRuntimeChanged?.(() => {
    void refreshRuntime().catch(() => {})
  })
  function current(id: string): PlaybackSnapshot {
    const playback = deps.playback()
    if (!playback || playback.sessionId !== id || playback.phase === 'error') throw new Error('播放会话已结束或不可用')
    return playback
  }
  function render(): void {
    if (!state.enabled || !task || !file) return
    requestedDocument = renderSubtitleAss(cues, state.display, state.fontSize)
    if (renderLoop || requestedDocument === document) return
    const generation = task, filename = file
    renderLoop = (async () => {
      while (!generation.signal.aborted && requestedDocument !== document) {
        const value = requestedDocument
        await atomicWrite(filename, value)
        if (generation.signal.aborted || file !== filename || deps.playback()?.sessionId !== state.sessionId) return
        deps.native.updateGeneratedSubtitle?.(filename, firstSelection)
        firstSelection = false; document = value
      }
    })().catch(() => {
      if (!generation.signal.aborted) { state.error = '字幕显示更新失败；播放不受影响，可停止后重新生成'; publish() }
    }).finally(() => { renderLoop = null })
  }
  function stop(invalidate = true): Promise<void> {
    if (invalidate) intent++
    if (stopping) return stopping
    stopping = (async () => {
      task?.abort(); task = null
      const oldScheduler = scheduler; scheduler = null
      const oldFile = file; file = null
      stoppingFile = oldFile
      state.enabled = false; state.phase = 'idle'; state.activeStart = null
      const oldEngine = inference; inference = null
      const oldRelease = releaseRuntime; releaseRuntime = null
      await oldEngine?.close()
      if (oldFile && deps.playback()?.sessionId === state.sessionId) {
        try { deps.native.removeGeneratedSubtitle?.(oldFile, previousSubtitle) } catch { /* Closing playback already destroys the track. */ }
      }
      await oldScheduler?.stop()
      await renderLoop
      oldRelease?.()
      if (oldFile) {
        await fs.rm(oldFile, { force: true }).catch(() => {})
        await fs.rmdir(path.dirname(oldFile)).catch(() => {})
      }
      cues = []; document = ''; requestedDocument = ''; cache = null; audioIndex = null
      stoppingFile = null
      state.sessionId = null; state.recognizedSeconds = 0; state.translatedSeconds = 0; state.duration = null
      publish()
    })().finally(() => { stopping = null })
    return stopping
  }
  async function start(id: string): Promise<void> {
    const request = ++intent
    await initialization
    if (request !== intent) return
    const playback = current(id)
    if (!state.installed) throw new Error('请先下载离线字幕模型与运行库')
    if (!playback.seekable || playback.duration == null) throw new Error('请等待影片加载完成；AI 字幕需要可定位的影片')
    if (!deps.native.updateGeneratedSubtitle) throw new Error('播放运行库不支持 AI 字幕更新')
    const selected = deps.native.selectedAudioStream?.()
    if (selected == null) throw new Error('当前音轨暂不能识别，请选择影片内的音轨')
    const source = deps.source(id)
    const ownedFile = file ?? stoppingFile
    const restoreSubtitle = state.sessionId === id && ownedFile && deps.native.generatedSubtitleSelected?.(ownedFile) ? previousSubtitle
      : playback.tracks.find(track => track.type === 'sub' && track.selected)?.id ?? null
    await stop(false)
    if (request !== intent) return
    current(id)
    const release = await deps.acquireRuntime?.()
    if (request !== intent) { release?.(); return }
    releaseRuntime = release ?? null
    const generation = new AbortController(); task = generation
    audioIndex = selected; privateSession = source.privateSession
    previousSubtitle = restoreSubtitle
    state.sessionId = id; state.enabled = true; state.error = null; state.phase = 'preparing'; state.duration = playback.duration
    firstSelection = true
    // mpv sub-reload resets the track title to the filename, so keep a readable stable basename.
    file = path.join(deps.root, 'active', randomUUID(), 'AI 日中字幕.ass')
    const runtimePaths = installer.paths()
    log.clear(); logSession = id
    log.write('开始 AI 字幕', { audioIndex: selected, translationModel: runtimePaths.translationModelId ?? 'qwen3' })
    const engine = (deps.inference ?? createOfflineSubtitleInference)(runtimePaths, path.join(deps.root, 'work'), {
      log: (stage, value) => { if (task === generation && !generation.signal.aborted) log.write(stage, value) }
    })
    inference = engine
    publish()
    try {
      const resolved = await deps.resolve(source.source)
      generation.signal.throwIfAborted(); current(id)
      const stream = await engine.probe(resolved.locator, selected, generation.signal)
      generation.signal.throwIfAborted()
      const storage = createSubtitleCache(path.join(deps.root, 'cache'), subtitleCacheKey(resolved, stream.identity, runtimePaths.asrVersion),
        !privateSession, runtimePaths.translationVersion)
      cache = storage
      const run = createSubtitleScheduler(playback.duration, {
        read: async index => {
          const chunk = await storage.read(index)
          if (chunk) log.write('字幕缓存命中（未重新推理）', { index })
          return chunk
        }, write: chunk => storage.write(chunk),
        recognize: async (start, end, signal) => {
          const renewed = await deps.resolve(source.source)
          signal.throwIfAborted()
          return engine.recognize(renewed.locator, stream.index, start, end, signal)
        },
        translate: (cues, signal, updated) => engine.translate(cues, signal, updated),
        changed: value => {
          if (generation.signal.aborted || task !== generation) return
          if (value.error && value.error !== state.error) log.write('字幕任务失败', value.error)
          cues = value.cues
          log.update(cues, value.error)
          state.phase = value.phase; state.activeStart = value.activeStart; state.error = value.error
          state.recognizedSeconds = value.recognizedSeconds; state.translatedSeconds = value.translatedSeconds
          if (cues.length) render()
          publish()
        }
      })
      scheduler = run; run.position(deps.playback()?.position ?? 0); run.start()
    } catch (error) {
      if (!generation.signal.aborted) {
        state.phase = 'error'; state.error = error instanceof Error ? error.message : '离线字幕初始化失败'
        log.write('字幕初始化失败', state.error); log.update([], state.error); publish()
      }
    }
  }
  return {
    snapshot,
    async command(id: string, command: AiSubtitleCommand): Promise<AiSubtitleSnapshot> {
      current(id); await initialization
      if (command.action === 'view-log') {
        if (!deps.openLog) throw new Error('当前环境不支持查看日志')
        if (logSession !== id) { log.clear(); logSession = id }
        await deps.openLog(log.html())
      } else if (command.action === 'start') { if (!state.enabled) await start(id) }
      else if (command.action === 'stop') await stop()
      else if (command.action === 'retry') {
        if (scheduler) { state.error = null; scheduler.retry() }
        else await start(id)
      } else if (command.action === 'display') { state.display = command.value; render(); publish() }
      else if (command.action === 'font-size') { state.fontSize = command.value; render(); publish() }
      else if (command.action === 'clear-cache') { const selectedCache = cache; await stop(); await selectedCache?.clear() }
      else if (command.action === 'export') {
        if (!cues.length || state.sessionId !== id) throw new Error('当前暂无可导出的 AI 字幕')
        await deps.exportFile({ ass: renderSubtitleAss(cues, state.display, state.fontSize), srt: renderSubtitleSrt(cues, state.display) })
      }
      return snapshot()
    },
    tick(playback: PlaybackSnapshot | null): void {
      if (!state.enabled) return
      if (!playback || playback.sessionId !== state.sessionId || playback.phase === 'error') { void stop(); return }
      const selected = deps.native.selectedAudioStream?.()
      if (selected == null) return
      const privateNow = deps.source(playback.sessionId).privateSession
      if (selected !== audioIndex || privateNow !== privateSession) {
        if (state.phase !== 'preparing') void start(playback.sessionId).catch(() => { void stop() })
        return
      }
      if (playback.position != null) scheduler?.position(playback.position)
    },
    async close(): Promise<void> { closed = true; runtimeRevision++; unsubscribe?.(); await stop() }
  }
}
