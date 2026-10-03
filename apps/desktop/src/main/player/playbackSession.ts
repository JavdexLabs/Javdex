import { randomUUID } from 'node:crypto'
import type { PlaybackControl, PlaybackSnapshot, PlaybackTarget, PlaybackViewport, PlaybackTrack } from '@shared/desktop/playback'
import type { NativePlayback, NativePlaybackState } from './nativePlayback'
import type { PlaybackSource } from './playbackSource'
import type { ResumePoint } from './playbackResumeStore'
import { PlaybackFailure, playbackFailure } from './playbackFailure'

const finite = (value: number | undefined): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
function parsedList(value: string | undefined): Array<Record<string, unknown>> {
  try { const list: unknown = JSON.parse(value ?? '[]'); return Array.isArray(list) ? list.filter(item => item && typeof item === 'object').slice(0, 256) : [] }
  catch { return [] }
}
function tracks(raw: NativePlaybackState): PlaybackTrack[] {
  return parsedList(raw['track-list']).flatMap(item => {
    if ((item.type !== 'audio' && item.type !== 'sub') || typeof item.id !== 'number') return []
    const count = item['demux-channel-count']
    return [{ id: item.id, type: item.type, title: typeof item.title === 'string' ? item.title.slice(0, 256) : null,
      language: typeof item.lang === 'string' ? item.lang.slice(0, 64) : null,
      codec: typeof item.codec === 'string' ? item.codec.slice(0, 64) : null,
      channelCountHint: item.type === 'audio' && typeof count === 'number' && Number.isInteger(count) && count > 0 && count <= 64 ? count : null,
      selected: item.selected === true }]
  })
}
interface Dependencies {
  native: NativePlayback
  resolve(target: PlaybackTarget): Promise<PlaybackSource>
  validate(source: PlaybackSource): Promise<void>
  changed(state: PlaybackSnapshot | null): void
  presentation(value: PlaybackSnapshot['presentation']): void
  started(source: PlaybackSource): Promise<void>
  awake(playing: boolean): void
  windowSize(): { width: number; height: number }
  focusControls?(): void
  navigate?(direction: 'back' | 'forward'): void
  readVolume?(): Promise<number>
  volumeChanged?(value: number): void
  progress?: {
    prepare(source: PlaybackSource): Promise<{ enabled: boolean; point: ResumePoint | null }>
    save(source: PlaybackSource, point: ResumePoint | null): void
    clear(source: PlaybackSource): void
  }
  now?(): number
}

/** One stable owner. Neither React teardown nor presentation changes owns the decoder. */
export function createPlaybackSession(deps: Dependencies) {
  let source: PlaybackSource | null = null
  let snapshot: PlaybackSnapshot | null = null
  let generation = 0
  let sequence = -1
  let started = false
  let sample: { position: number; frames: number } | null = null
  let validation: Promise<void> | null = null
  let lastValidation = 0
  let lastProgressSave = 0
  let savedProgress = ''
  let pendingSeek: { target: number; requestedAt: number } | null = null
  let subtitleRefresh: { id: number; target: number; requestedAt: number } | null = null
  let openedAt = 0
  let focusSequence = 0
  const now = deps.now ?? Date.now
  const publish = (): void => { deps.changed(snapshot ? structuredClone(snapshot) : null) }
  function saveProgress(force = false): void {
    if (!source || !snapshot || !started || !snapshot.recordingProgress || snapshot.resumePosition != null
      || snapshot.seeking || snapshot.phase === 'error' || snapshot.position == null) return
    if (!force && now() - lastProgressSave < 10000) return
    const point = snapshot.phase === 'ended' ? null : { position: snapshot.position, duration: snapshot.duration }
    const signature = JSON.stringify(point)
    if (signature === savedProgress) return
    lastProgressSave = now()
    try {
      deps.progress?.save(source, point)
      savedProgress = signature
      snapshot.progressError = null
    } catch { snapshot.progressError = '无法保存本机续播进度；播放不受影响' }
  }
  function stop(): void {
    generation++
    saveProgress(true)
    deps.native.destroy()
    deps.focusControls?.()
    deps.awake(false)
    deps.presentation('expanded')
    source = null; snapshot = null; sample = null; started = false; sequence = -1; pendingSeek = null; subtitleRefresh = null; validation = null
    publish()
  }
  function fail(message: string): void {
    deps.native.destroy(); deps.awake(false)
    deps.focusControls?.()
    if (snapshot) {
      snapshot.phase = 'error'; snapshot.error = message; snapshot.paused = true
      snapshot.seeking = false; snapshot.resumePosition = null; pendingSeek = null; subtitleRefresh = null; sample = null
      if (snapshot.presentation !== 'expanded') {
        snapshot.presentation = 'expanded'; snapshot.presentationRevision++; sequence = -1
        deps.presentation('expanded')
      }
      publish()
    }
  }
  function commandNative(command: PlaybackControl): void {
    try { deps.native.command(command) }
    catch { const error = new PlaybackFailure('native'); fail(error.message); throw error }
  }
  function seek(seconds: number): void {
    pendingSeek = { target: seconds, requestedAt: now() }
    if (subtitleRefresh) subtitleRefresh.target = seconds
    commandNative({ kind: 'seek', seconds })
    if (snapshot) snapshot.seeking = true
    sample = null
  }
  function current(id: string): PlaybackSnapshot {
    if (!snapshot || snapshot.sessionId !== id) throw new Error('播放会话已结束或被替换')
    return snapshot
  }
  function stopRecording(): void {
    if (!snapshot) return
    snapshot.recordingProgress = false; snapshot.resumePosition = null; snapshot.progressError = null
    publish()
  }
  function control(id: string, command: PlaybackControl): void {
    const state = current(id)
    if (command.kind === 'stop') { stop(); return }
    if (command.kind === 'private-session') {
      stopRecording(); return
    }
    if (command.kind === 'presentation') {
      if (state.resumePosition != null && command.value === 'fullscreen') return
      if (state.presentation === command.value) return
      state.presentation = command.value
      state.presentationRevision++
      sequence = -1
      // Hide the old rectangle until a geometry from the new presentation arrives.
      deps.native.viewport({ x: 0, y: 0, width: 1, height: 1 }, false, state)
      if (command.value !== 'fullscreen') deps.focusControls?.()
      deps.presentation(command.value); publish(); return
    }
    if (state.phase === 'error') throw new Error('请关闭后重新检查所选资源')
    if (command.kind === 'resume') {
      if (state.resumePosition == null || state.phase === 'opening') return
      if (command.choice === 'continue' && !state.seekable) throw new Error('此资源暂不能续播，可选择从头播放')
      if (command.choice === 'continue' && state.duration != null && state.duration - state.resumePosition <= 30) {
        throw new Error('续播位置已不可用，请从头播放')
      }
      if (state.seekable) {
        seek(command.choice === 'continue' ? Math.min(state.resumePosition, state.duration ?? state.resumePosition) : 0)
      }
      commandNative({ kind: 'pause', paused: false })
      state.resumePosition = null; sample = null
      publish(); return
    }
    // Native hotkeys and transport buttons must not bypass the explicit resume decision.
    if (state.resumePosition != null && (command.kind === 'seek' || command.kind === 'restart'
      || command.kind === 'pause' && !command.paused)) return
    if (command.kind === 'track' && command.id !== null && !state.tracks.some(track => track.id === command.id && track.type === command.type)) {
      throw new Error('所选轨道已不可用')
    }
    if (command.kind === 'seek') {
      if (!state.seekable) throw new Error('此资源暂不能定位')
      const seconds = command.relative ? (pendingSeek?.target ?? state.position ?? 0) + command.seconds : command.seconds
      seek(Math.max(0, Math.min(state.duration ?? seconds, seconds)))
    } else if (command.kind === 'restart') {
      seek(0)
      commandNative({ kind: 'pause', paused: false })
    } else {
      commandNative(command)
      // A paused PGS re-selection needs a same-time refresh, but issuing it in
      // the same batch races decoder reinit. Wait for selected-track feedback;
      // keep the intended time, not an intermediate clock from that reinit.
      if (command.kind === 'track' && command.type === 'sub') {
        subtitleRefresh = null
        if (command.id !== null && state.paused && state.seekable && state.position != null && state.resumePosition == null
          && state.phase !== 'opening' && state.phase !== 'ended') {
          const track = state.tracks.find(track => track.type === 'sub' && track.id === command.id)
          if (track?.codec === 'hdmv_pgs_subtitle' && !track.selected) {
            subtitleRefresh = { id: command.id, target: pendingSeek?.target ?? state.position, requestedAt: now() }
            state.seeking = true; sample = null
          }
        }
      }
      if (command.kind === 'pause' && !command.paused) subtitleRefresh = null
      if (command.kind === 'volume') deps.volumeChanged?.(command.value)
      if (command.kind === 'pause' && command.paused) saveProgress(true)
    }
  }
  return {
    snapshot: (): PlaybackSnapshot | null => snapshot ? structuredClone(snapshot) : null,
    async open(target: PlaybackTarget, privateSession = false): Promise<boolean> {
      const request = ++generation
      if (source && snapshot && snapshot.phase !== 'error' && source.target.resourceId === target.resourceId
        && source.target.libraryId === target.libraryId && source.target.videoId === target.videoId) {
        await deps.validate(source)
        if (request !== generation || !snapshot) return false
        if (privateSession) control(snapshot.sessionId, { kind: 'private-session' })
        control(snapshot.sessionId, { kind: 'presentation', value: 'expanded' }); return true
      }
      const resolved = await deps.resolve(target)
      const volume = await deps.readVolume?.() ?? 50
      if (request !== generation) return false
      let progress: { enabled: boolean; point: ResumePoint | null } = { enabled: false, point: null }
      let progressError: string | null = null
      if (!privateSession && deps.progress) {
        try { progress = await deps.progress.prepare(resolved) }
        catch { progressError = '无法读取本机续播记录，本次从头播放且不保存进度' }
      }
      if (request !== generation) return false
      saveProgress(true)
      deps.native.destroy(); deps.awake(false)
      source = resolved; sequence = -1; started = false; sample = null; validation = null; lastValidation = now(); openedAt = now()
      lastProgressSave = now(); savedProgress = ''; pendingSeek = null; subtitleRefresh = null
      const resumePosition = progress.enabled ? progress.point?.position ?? null : null
      snapshot = {
        sessionId: randomUUID(), target: { ...target }, title: resolved.title, source: resolved.mode,
        presentation: 'expanded', presentationRevision: 0, phase: 'opening', paused: resumePosition != null, seeking: false,
        position: null, duration: null, seekable: false, volume, muted: false, speed: 1,
        subtitleDelay: null, subtitleSize: null,
        tracks: [], chapters: [], error: null,
        resumePosition, recordingProgress: progress.enabled, progressError,
        info: { videoCodec: null, audioCodec: null, width: null, height: null, hardwareDecoder: null, audioOutput: null, droppedFrames: null }
      }
      try {
        deps.native.create()
        deps.native.command({ kind: 'volume', value: volume })
        deps.native.load(resolved.locator, { paused: resumePosition != null })
        deps.presentation('expanded'); publish(); return true
      } catch {
        const error = new PlaybackFailure('runtime')
        fail(error.message)
        throw error
      }
    },
    control,
    fail,
    stopRecording,
    clearProgress(id: string): void {
      current(id)
      if (!source) throw new Error('播放会话已结束')
      deps.progress?.clear(source)
      stopRecording()
    },
    viewport(viewport: PlaybackViewport): void {
      if (!snapshot || viewport.sessionId !== snapshot.sessionId || viewport.presentation !== snapshot.presentation
        || viewport.presentationRevision !== snapshot.presentationRevision
        || viewport.sequence <= sequence) return
      sequence = viewport.sequence
      const { width, height } = deps.windowSize()
      const rect = viewport.rect
      const valid = rect.width >= 1 && rect.height >= 1 && rect.x + rect.width <= width + 1 && rect.y + rect.height <= height + 1
      deps.native.viewport(valid ? rect : { x: 0, y: 0, width: 1, height: 1 }, viewport.visible && valid, snapshot)
    },
    addSubtitle(id: string, file: string): void { current(id); deps.native.addSubtitle(file) },
    tick(): void {
      if (!snapshot || !source || snapshot.phase === 'error') return
      const state = snapshot
      const activeSource = source
      const previousPhase = state.phase
      const raw = deps.native.read()
      if (!raw.alive) { fail(new PlaybackFailure('native').message); return }
      if (raw.error) { fail(new PlaybackFailure(raw.errorKind ?? 'load').message); return }
      state.paused = raw.pause ?? state.paused
      state.phase = raw['eof-reached'] ? 'ended' : raw.loadedFiles ? raw['paused-for-cache'] ? 'buffering' : state.paused ? 'paused' : 'playing' : 'opening'
      if (state.phase === 'opening' && now() - openedAt >= 30000) { fail(new PlaybackFailure('openingTimeout').message); return }
      state.position = finite(raw['time-pos']); state.duration = finite(raw.duration)
      if (pendingSeek != null && !raw.seeking && state.position != null && Math.abs(state.position - pendingSeek.target) < 2) pendingSeek = null
      if (pendingSeek != null && now() - pendingSeek.requestedAt >= 20000) { fail(new PlaybackFailure('seekTimeout').message); return }
      state.seeking = raw.seeking === true || pendingSeek != null
      state.seekable = raw.seekable === true
      state.volume = finite(raw.volume) ?? state.volume; state.muted = raw.mute ?? false; state.speed = finite(raw.speed) ?? state.speed
      state.subtitleDelay = finite(raw['sub-delay']); state.subtitleSize = finite(raw['sub-font-size'])
      state.tracks = tracks(raw)
      const refresh = subtitleRefresh
      if (refresh) {
        if (!state.paused || !state.seekable || state.phase === 'ended' || state.resumePosition != null) subtitleRefresh = null
        else if (state.tracks.some(track => track.type === 'sub' && track.id === refresh.id && track.selected)) {
          const target = pendingSeek?.target ?? refresh.target
          subtitleRefresh = null
          seek(target)
        } else if (now() - refresh.requestedAt >= 20000) { fail(new PlaybackFailure('seekTimeout').message); return }
      }
      state.seeking ||= subtitleRefresh != null
      state.chapters = parsedList(raw['chapter-list']).flatMap((chapter, index) => typeof chapter.time === 'number'
        ? [{ title: typeof chapter.title === 'string' ? chapter.title.slice(0, 256) : `章节 ${index + 1}`, time: chapter.time }] : [])
      state.info = { videoCodec: raw['video-codec'] ?? null, audioCodec: raw['audio-codec'] ?? null,
        width: finite(raw.width), height: finite(raw.height), hardwareDecoder: raw['hwdec-current'] ?? null,
        audioOutput: raw['current-ao'] ?? null, droppedFrames: finite(raw['frame-drop-count']) }
      deps.awake(state.phase === 'playing')
      // Rendering a paused first frame and jumping the clock cannot prove actual playback.
      const frames = raw.presentedFrames ?? 0
      if (!started && state.resumePosition == null && state.phase === 'playing' && !state.seeking && state.position != null) {
        if (sample && frames > sample.frames && state.position > sample.position && state.position - sample.position < 2) {
          started = true
          void deps.started(activeSource).catch(() => { /* Playback must remain usable if optional business work fails. */ })
        }
        sample = { frames, position: state.position }
      } else sample = null
      saveProgress(state.phase === 'ended' || state.phase === 'paused' && previousPhase !== 'paused')
      let pauseIntent = state.paused
      let muteIntent = state.muted
      let volumeIntent = state.volume
      for (const action of raw.actions ?? []) {
        if (snapshot !== state) break
        if (action.kind === 'history-back' || action.kind === 'history-forward') deps.navigate?.(action.kind === 'history-back' ? 'back' : 'forward')
        else if (action.kind === 'toggle-pause') {
          if (state.phase === 'ended' && !state.seeking) { control(state.sessionId, { kind: 'restart' }); pauseIntent = false }
          else { pauseIntent = !pauseIntent; control(state.sessionId, { kind: 'pause', paused: pauseIntent }) }
        }
        else if (action.kind === 'toggle-mute') { muteIntent = !muteIntent; control(state.sessionId, { kind: 'mute', muted: muteIntent }) }
        else if (action.kind === 'focus-forward' || action.kind === 'focus-backward') {
          state.focusRequest = { sequence: ++focusSequence, backwards: action.kind === 'focus-backward' }
          deps.focusControls?.()
        }
        else if (action.kind === 'stop') stop()
        else if (action.kind === 'dock') control(state.sessionId, { kind: 'presentation', value: 'docked' })
        else if (action.kind === 'expand') control(state.sessionId, { kind: 'presentation', value: state.presentation === 'fullscreen' ? 'docked' : 'expanded' })
        else if (action.kind === 'fullscreen') control(state.sessionId, { kind: 'presentation', value: state.presentation === 'fullscreen' ? 'expanded' : 'fullscreen' })
        else if (action.kind === 'seek' && action.value != null) control(state.sessionId, { kind: 'seek', seconds: action.value })
        else if (action.kind === 'seek-relative' && state.seekable && action.value != null) control(state.sessionId, { kind: 'seek', relative: true, seconds: action.value })
        else if ((action.kind === 'volume' || action.kind === 'volume-relative') && action.value != null && Number.isFinite(action.value)) {
          volumeIntent = Math.max(0, Math.min(100, action.kind === 'volume-relative' ? volumeIntent + action.value : action.value))
          control(state.sessionId, { kind: 'volume', value: volumeIntent })
        }
      }
      if (!validation && now() - lastValidation >= 5000) {
        lastValidation = now()
        const check = deps.validate(activeSource).catch(error => {
          if (source === activeSource) fail(playbackFailure(error, 'identity').message)
        }).finally(() => { if (validation === check) validation = null })
        validation = check
      }
      if (snapshot === state) publish()
    },
    pause(): void { if (snapshot && snapshot.phase !== 'error') control(snapshot.sessionId, { kind: 'pause', paused: true }) },
    stop
  }
}
