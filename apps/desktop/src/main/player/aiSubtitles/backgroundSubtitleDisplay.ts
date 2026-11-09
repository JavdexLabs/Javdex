import path from 'node:path'
import type { AiSubtitleCommand, AiSubtitleSnapshot } from '@shared/desktop/aiSubtitles'
import type { PlaybackSnapshot } from '@shared/desktop/playback'
import type { PlaybackSource } from '../playbackSource'
import type { NativePlayback } from '../nativePlayback'
import type { SubtitleTasks } from './subtitleTasks'
import { renderSubtitleAss, renderSubtitleSrt } from './subtitleDocument'
import { createSubtitleLog } from './subtitleLog'

interface Dependencies {
  jobs: SubtitleTasks
  root: string
  native: NativePlayback
  playback(): PlaybackSnapshot | null
  source(id: string): PlaybackSource
  base(): AiSubtitleSnapshot
  changed(state: AiSubtitleSnapshot): void
  exportFile(content: { ass: string; srt: string }): Promise<void>
  openLog?(content: string): Promise<void>
}
/** The player is only a subscriber. Detaching never cancels the durable job. */
export function createBackgroundSubtitleDisplay(deps: Dependencies) {
  let attached: { session: string; job: string; audio: number; file: string; previous: number | null; controller: AbortController } | null = null
  let selectedSession: string | null = null, revision = 0, closed = false
  let display: AiSubtitleSnapshot['display'] = 'bilingual', fontSize = 42
  let first = false, document = '', rendering: Promise<void> | null = null, displayError: string | null = null
  let remoteBusy = false
  const snapshot = (): AiSubtitleSnapshot => {
    const state = deps.base(), value = attached ? deps.jobs.state(attached.job) : null
    return { ...state, sessionId: selectedSession, enabled: !!attached, display, fontSize,
      ...(value ? { taskId: value.job.id, taskStatus: value.job.status, duration: value.job.duration,
        phase: value.job.status === 'failed' ? 'error' : value.progress?.phase ?? 'ready',
        recognizedSeconds: value.job.recognizedSeconds, translatedSeconds: value.job.translatedSeconds,
        activeStart: value.progress?.activeStart ?? null, recognizedUntil: value.progress?.recognizedUntil ?? (value.job.status === 'completed' ? value.job.duration : null),
        translatedUntil: value.progress?.translatedUntil ?? (value.job.status === 'completed' && value.job.output === 'bilingual' ? value.job.duration : null), error: displayError ?? value.job.error } : {}) }
  }
  function render(): void {
    const owner = attached
    if (!owner || rendering || displayError || deps.playback()?.sessionId !== owner.session) return
    const cues = deps.jobs.state(owner.job)?.cues ?? []
    const body = renderSubtitleAss(cues, display, fontSize)
    if (body === document) return
    rendering = (async () => {
      await deps.native.updateGeneratedSubtitle?.(owner.file, first, owner.controller.signal, body)
      if (attached === owner && !owner.controller.signal.aborted) { document = body; first = false }
    })().catch(cause => {
      if (attached === owner && !owner.controller.signal.aborted) displayError = cause instanceof Error ? cause.message : '字幕显示失败'
    }).finally(() => { rendering = null; if (attached === owner && !displayError) render() })
  }
  function observe(): void {
    const playback = deps.playback()
    const owns = attached && playback?.sessionId === attached.session && (first || deps.native.generatedSubtitleSelected?.(attached.file))
    deps.jobs.observe(remoteBusy || !!playback && !playback.paused && playback.phase !== 'ended' && playback.phase !== 'error', owns ? attached!.job : null, playback?.position ?? 0)
  }
  const changed = (): void => {
    if (closed) return
    if (attached && !deps.jobs.state(attached.job)) { void detach(); return }
    if (selectedSession) { render(); deps.changed(snapshot()) }
  }
  const unsubscribe = deps.jobs.subscribe(changed)
  async function detach(invalidate = true): Promise<void> {
    if (invalidate) revision++
    const old = attached; attached = null; old?.controller.abort()
    await rendering
    if (old && deps.playback()?.sessionId === old.session) {
      try { await deps.native.removeGeneratedSubtitle?.(old.file, old.previous) } catch { /* Session teardown may already remove the overlay. */ }
    }
    document = ''; displayError = null; observe(); changed()
  }
  return {
    selectionChanged(): void { revision++; first = false },
    snapshot: (): AiSubtitleSnapshot | null => selectedSession === deps.playback()?.sessionId ? snapshot() : null,
    stop: detach,
    async command(id: string, command: AiSubtitleCommand): Promise<AiSubtitleSnapshot> {
      const playback = deps.playback()
      if (closed || playback?.sessionId !== id) throw new Error('播放会话已变化')
      selectedSession = id
      if (command.action === 'start') {
        if (attached?.session === id) return snapshot()
        if (!playback.seekable || playback.duration == null) throw new Error('请等待影片加载完成')
        const audio = deps.native.selectedAudioStream?.()
        if (audio == null) throw new Error('请选择影片内的音轨')
        const request = ++revision
        await detach(false)
        if (request !== revision || closed || deps.playback()?.sessionId !== id) return snapshot()
        const job = await deps.jobs.enqueue(deps.source(id), audio, playback.duration)
        if (request !== revision || closed || deps.playback()?.sessionId !== id) return snapshot()
        attached = { session: id, job, audio, file: path.join(deps.root, job, 'display.ass'),
          previous: playback.tracks.find(track => track.type === 'sub' && track.selected)?.id ?? null, controller: new AbortController() }
        first = true; document = ''; displayError = null; observe(); changed()
      } else if (command.action === 'stop') await detach()
      else if (command.action === 'display') { display = command.value; changed() }
      else if (command.action === 'font-size') { fontSize = command.value; changed() }
      else if (command.action === 'retry' && attached) {
        displayError = null; document = ''; first = true
        const state = deps.jobs.state(attached.job)
        await deps.jobs.action(attached.job, state?.job.status === 'awaiting-save' ? 'retry-save' : 'resume'); changed()
      } else if (command.action === 'clear-cache') throw new Error('后台任务的断点用于恢复，请在字幕任务中移除任务；已保存的字幕不会删除')
      else if (command.action === 'export') {
        const cues = attached ? deps.jobs.state(attached.job)?.cues : null
        if (!cues?.length) throw new Error('暂无可导出的字幕')
        await deps.exportFile({ ass: renderSubtitleAss(cues, display, fontSize), srt: renderSubtitleSrt(cues, display) })
      } else if (command.action === 'view-log') {
        const log = createSubtitleLog(); log.write('后台字幕任务', attached ? deps.jobs.state(attached.job)?.job : '尚未创建任务')
        await deps.openLog?.(log.html())
      }
      return snapshot()
    },
    tick(playback: PlaybackSnapshot | null, remoteInference = false): void {
      if (closed) return
      remoteBusy = remoteInference
      if (attached && (playback?.sessionId !== attached.session || playback.phase === 'error')) void detach()
      else if (attached && deps.native.selectedAudioStream?.() != null && deps.native.selectedAudioStream() !== attached.audio) void detach()
      observe()
    },
    async close(): Promise<void> { closed = true; unsubscribe(); await detach() }
  }
}
