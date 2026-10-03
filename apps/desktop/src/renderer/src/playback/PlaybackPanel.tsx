import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Maximize, Pause, Play, RotateCcw, Volume2, VolumeX, X, SlidersHorizontal } from 'lucide-react'
import type { PlaybackControl, PlaybackSnapshot } from '@shared/desktop/playback'
import { api } from '../api'
import Button from '../components/Button'
import IconButton from '../components/IconButton'
import SelectControl from '../components/SelectControl'
import TextInput from '../components/TextInput'
import Modal from '../components/Modal'
import { parsePlaybackTime, playbackTime } from './playbackTime'
import { useToast } from '../components/Toast'
import { InteractionLayerOwner, useInteractionLayer } from '../interaction/useInteractionLayer'
import { interactionLayers } from '../interaction/interactionLayers'
import { useOverlayHistory } from '../interaction/OverlayHistoryContext'
import { createPlaybackHistory } from './playbackHistory'
import { playbackTrackLabel } from './playbackTrackLabel'
import { hasPlaybackOcclusion } from './playbackOcclusion'
import styles from './PlaybackPanel.module.css'

let viewportSequence = 0

export default function PlaybackPanel(): JSX.Element | null {
  const [state, setState] = useState<PlaybackSnapshot | null>(null)
  const [seekDraft, setSeekDraft] = useState<number | null>(null)
  const seekDraftRef = useRef<number | null>(null)
  const [exactTime, setExactTime] = useState('')
  const [timeError, setTimeError] = useState<string | null>(null)
  const [remaining, setRemaining] = useState(false)
  const timeHelpId = useId()
  const [options, setOptions] = useState(false)
  const [clearProgress, setClearProgress] = useState<string | null>(null)
  const [recoverySession, setRecoverySession] = useState<string | null>(null)
  const recoveryRef = useRef<string | null>(null)
  const [sources, setSources] = useState<{ sessionId: string; items: Array<{ id: number; label: string }>; error: string | null } | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const root = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLButtonElement>(null)
  const toast = useToast()
  const history = useOverlayHistory()
  const send = useRef((id: string, command: PlaybackControl): void => { void api.playback.control(id, command).catch(error => toast.show((error as Error).message, 'error')) })
  send.current = (id, command) => { void api.playback.control(id, command).catch(error => toast.show((error as Error).message, 'error')) }
  const viewingHistory = useRef<ReturnType<typeof createPlaybackHistory>>()
  if (!viewingHistory.current) viewingHistory.current = createPlaybackHistory(history, (id, command) => send.current(id, command), setOptions)
  const presentationHistory = viewingHistory.current
  const control = useCallback((command: PlaybackControl): void => {
    const id = stateRef.current?.sessionId
    if (id) void api.playback.control(id, command).catch(error => toast.show((error as Error).message, 'error'))
  }, [toast])
  const layer = useInteractionLayer({
    enabled: Boolean(state && state.presentation !== 'docked'), rootRef: root, modal: true,
    onDismiss: () => {
      if (stateRef.current?.phase === 'error') control({ kind: 'stop' })
      else if (options) presentationHistory.setOptions(false)
      else control({ kind: 'presentation', value: stateRef.current?.presentation === 'fullscreen' ? 'expanded' : 'docked' })
    }
  })
  useEffect(() => {
    if (!api.playback) return
    let disposed = false
    let revision = 0
    const off = api.playback.onChanged(value => { revision++; presentationHistory.observe(value); setState(value) })
    void api.playback.snapshot().then(value => { if (!disposed && revision === 0) { presentationHistory.observe(value, true); setState(value) } })
    return () => { disposed = true; off() }
  }, [presentationHistory])
  useEffect(() => { seekDraftRef.current = null; setSeekDraft(null) }, [state?.sessionId, state?.presentation])
  useEffect(() => { setExactTime(''); setTimeError(null); setClearProgress(null); setRecoverySession(null); recoveryRef.current = null }, [state?.sessionId])
  const sessionId = state?.sessionId
  const libraryId = state?.target.libraryId
  const videoId = state?.target.videoId
  useEffect(() => {
    if (!options || !sessionId || libraryId == null || videoId == null) return
    let disposed = false
    setSources(null)
    void api.videos.get({ kind: 'library', libraryId }, videoId).then(detail => {
      if (disposed) return
      if (!detail || detail.activeLibraryId !== libraryId) throw new Error('Video no longer belongs to this library')
      const items = detail.resources.filter(resource => resource.kind === 'local' && resource.library_id === libraryId && resource.video_id === videoId)
        .map(resource => ({ id: resource.id, label: resource.display_name?.trim() || `来源 ${resource.id}` }))
      setSources({ sessionId, items, error: null })
    }).catch(() => {
      if (!disposed) setSources({ sessionId, items: [], error: '无法读取播放来源，请关闭再打开播放选项重试。' })
    })
    return () => { disposed = true }
  }, [options, sessionId, libraryId, videoId])
  const presentation = state?.presentation
  const presentationRevision = state?.presentationRevision
  const focusSequence = state?.focusRequest?.sequence
  const previousPresentation = useRef(presentation)
  useLayoutEffect(() => {
    const previous = previousPresentation.current
    previousPresentation.current = presentation
    if (previous === 'fullscreen' && presentation === 'expanded' && layer.isTop()) video.current?.focus()
  }, [presentation, layer])
  useLayoutEffect(() => {
    const current = stateRef.current
    if (!current?.focusRequest || current.presentation === 'fullscreen' || !root.current || !video.current) return
    if (current.presentation === 'docked' ? interactionLayers.hasModal() : !layer.isTop()) return
    const elements = Array.from(root.current.querySelectorAll<HTMLElement>('button,input,select,textarea,[tabindex]'))
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') && element.getClientRects().length > 0)
    const index = elements.indexOf(video.current)
    if (index < 0 || !elements.length) return
    const next = (index + (current.focusRequest.backwards ? -1 : 1) + elements.length) % elements.length
    elements[next]?.focus()
  }, [sessionId, focusSequence, layer])
  useLayoutEffect(() => {
    if (!sessionId || !presentation || presentationRevision == null) return
    let last = ''
    let disposed = false
    const report = (): void => {
      const current = stateRef.current
      const element = video.current
      if (!current || current.sessionId !== sessionId || !element || disposed) return
      const bounds = element.getBoundingClientRect()
      const visible = current.phase !== 'error' && bounds.width > 0 && bounds.height > 0
        && document.visibilityState !== 'hidden' && !element.closest('[inert]')
        && (presentation === 'docked' ? !interactionLayers.hasModal() : layer.isTop())
        && !hasPlaybackOcclusion(bounds, document.querySelectorAll<HTMLElement>('[data-native-playback-occluder]'))
      const rect = { x: Math.max(0, bounds.x), y: Math.max(0, bounds.y), width: bounds.width, height: bounds.height }
      const key = JSON.stringify([rect, visible])
      if (key === last) return
      last = key
      void api.playback.viewport({ sessionId, sequence: ++viewportSequence, presentation, presentationRevision, rect, visible }).catch(() => { /* Old session geometry is disposable. */ })
    }
    report()
    const observer = new ResizeObserver(report)
    if (video.current) observer.observe(video.current)
    // Also follows portal/modal ownership, visual occluders and full-screen transitions.
    const timer = window.setInterval(report, 100)
    window.addEventListener('resize', report)
    return () => { disposed = true; observer.disconnect(); window.clearInterval(timer); window.removeEventListener('resize', report) }
  }, [sessionId, presentation, presentationRevision, layer])
  if (!state) return null
  const docked = state.presentation === 'docked'
  const fullscreen = state.presentation === 'fullscreen'
  const disabled = state.phase === 'opening' || state.phase === 'error'
  const waitingResume = state.resumePosition != null
  const seekDisabled = disabled || waitingResume || !state.seekable
  const commitSeek = (): void => {
    const seconds = seekDraftRef.current
    seekDraftRef.current = null
    if (seconds != null) { control({ kind: 'seek', seconds }); setSeekDraft(null) }
  }
  const subtitle = state.tracks.find(track => track.type === 'sub' && track.selected)
  const sizeSupported = Boolean(subtitle?.codec && ['subrip', 'srt', 'webvtt', 'text', 'mov_text'].includes(subtitle.codec))
  const trackSelect = (type: 'audio' | 'sub'): JSX.Element => <SelectControl aria-label={type === 'audio' ? '音轨' : '字幕'}
    disabled={disabled}
    value={state.tracks.find(track => track.type === type && track.selected)?.id ?? 'no'}
    onChange={event => control({ kind: 'track', type, id: event.target.value === 'no' ? null : Number(event.target.value) })}>
    <option value="no">{type === 'audio' ? '关闭音轨' : '关闭字幕'}</option>
    {state.tracks.filter(track => track.type === type).map(track => <option key={track.id} value={track.id}>{playbackTrackLabel(track)}</option>)}
  </SelectControl>
  const recover = async (external: boolean, resourceId?: number): Promise<void> => {
    const current = stateRef.current
    if (!current || recoveryRef.current === current.sessionId) return
    if (!external && resourceId == null && current.phase !== 'error') return
    if (resourceId != null && (disabled || resourceId === current.target.resourceId || sources?.sessionId !== current.sessionId
      || !sources.items.some(item => item.id === resourceId))) return
    recoveryRef.current = current.sessionId
    setRecoverySession(current.sessionId)
    try {
      const result = external
        ? await api.player.openResource(current.target.libraryId, current.target.resourceId, current.target.videoId, 'external')
        : await api.playback.open({ ...current.target, resourceId: resourceId ?? current.target.resourceId }, { privateSession: !current.recordingProgress })
      if (stateRef.current?.sessionId !== current.sessionId) return
      if (!result.ok) toast.show(result.error ?? '无法打开所选资源', 'error')
      else if (external) await api.playback.control(current.sessionId, { kind: 'stop' })
    } catch (error) {
      if (stateRef.current?.sessionId === current.sessionId) toast.show((error as Error).message, 'error')
    } finally {
      if (recoveryRef.current === current.sessionId) recoveryRef.current = null
      setRecoverySession(value => value === current.sessionId ? null : value)
    }
  }
  return <InteractionLayerOwner.Provider value={layer.owner}>
    <div ref={root} className={styles.root} data-presentation={state.presentation} data-playback-session={state.sessionId}
      role={docked ? 'region' : 'dialog'} aria-modal={docked ? undefined : true} aria-label="内置播放器" tabIndex={-1}
      onKeyDown={event => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || !document.hasFocus()) return
        if ((event.target as HTMLElement).closest('input,select,textarea,[contenteditable="true"]')) return
        if (!docked && !layer.isTop()) return
        if (state.phase === 'error') return
        if (event.key === ' ' && event.target === root.current) { event.preventDefault(); control(state.phase === 'ended' ? { kind: 'restart' } : { kind: 'pause', paused: !state.paused }) }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); control({ kind: 'seek', relative: true, seconds: (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 30 : 5) }) }
        else if (event.key.toLowerCase() === 'm') { event.preventDefault(); control({ kind: 'mute', muted: !state.muted }) }
        else if (event.key.toLowerCase() === 'f') { event.preventDefault(); control({ kind: 'presentation', value: fullscreen ? 'expanded' : 'fullscreen' }) }
      }}>
      {!docked && !fullscreen && <header className={styles.header}>
        <span className={styles.title}>{state.title}</span>
        <IconButton icon={<ChevronDown size={18} />} label="收起到底栏" disabled={state.phase === 'error'} onClick={() => control({ kind: 'presentation', value: 'docked' })} />
        <IconButton icon={<Maximize size={18} />} label="全屏" disabled={waitingResume || state.phase === 'error'} onClick={() => control({ kind: 'presentation', value: 'fullscreen' })} />
        <IconButton icon={<X size={18} />} label="停止播放" onClick={() => control({ kind: 'stop' })} />
      </header>}
      <div className={styles.middle}>
        {state.phase === 'error' ? <div className={styles.failure}>
          <p className={styles.failureMessage} role="alert">{state.error}</p>
          {state.info.videoCodec && <p className={styles.note}>{state.info.videoCodec} · {state.info.width ?? '?'}×{state.info.height ?? '?'}</p>}
          <div className={styles.adjustment}>
            <Button size="sm" variant="primary" disabled={recoverySession === state.sessionId} onClick={() => void recover(false)}>重试所选资源</Button>
            <Button size="sm" disabled={recoverySession === state.sessionId} onClick={() => void recover(true)}>使用外部播放器打开</Button>
            <Button size="sm" onClick={() => control({ kind: 'stop' })}>关闭播放器</Button>
          </div>
          <p className={styles.note}>重试会重新检查同一资源，不自动切换资源或播放器。</p>
        </div> : <button ref={video} className={styles.video} aria-hidden={fullscreen || undefined} tabIndex={fullscreen ? -1 : 0}
          aria-label={docked ? '恢复展开播放器' : '视频画面，单击播放或暂停，双击全屏'}
          onClick={() => control(docked ? { kind: 'presentation', value: 'expanded' }
            : state.phase === 'ended' ? { kind: 'restart' } : { kind: 'pause', paused: !state.paused })} />}
        {options && !docked && !fullscreen && state.phase !== 'error' && <aside className={styles.options} aria-label="播放选项">
          <label>播放来源<SelectControl aria-label="播放来源" value={state.target.resourceId}
            disabled={disabled || recoverySession === state.sessionId || sources?.sessionId !== state.sessionId || !sources.items.some(item => item.id !== state.target.resourceId)}
            onChange={event => void recover(false, Number(event.target.value))}>
            {sources?.sessionId === state.sessionId && sources.items.some(item => item.id === state.target.resourceId)
              ? sources.items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)
              : <><option value={state.target.resourceId}>当前来源</option>{sources?.sessionId === state.sessionId && sources.items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</>}
          </SelectControl></label>
          <p className={styles.note} role={sources?.error ? 'alert' : undefined}>{sources?.sessionId !== state.sessionId ? '正在读取播放来源…'
            : sources.error ?? '仅选择当前影片在此媒体库内的文件；切换会重新打开，不修改主资源。'}</p>
          <Button size="sm" disabled={recoverySession === state.sessionId} onClick={() => void recover(true)}>使用外部播放器打开</Button>
          <label>音轨{trackSelect('audio')}</label><label>字幕{trackSelect('sub')}</label>
          <p className={styles.note}>声道数来自文件标记，不代表设备实际输出。</p>
          <label>倍速<SelectControl aria-label="倍速" value={state.speed} disabled={disabled} onChange={event => control({ kind: 'speed', value: Number(event.target.value) })}>
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
          </SelectControl></label>
          <Button size="sm" onClick={() => void api.playback.subtitle(state.sessionId).catch(error => toast.show((error as Error).message, 'error'))}>选择本机外挂字幕</Button>
          <label>字幕字号<SelectControl aria-label="字幕字号" value={state.subtitleSize ?? ''}
            disabled={disabled || !sizeSupported || state.subtitleSize == null}
            onChange={event => control({ kind: 'subtitle-size', value: Number(event.target.value) })}>
            {state.subtitleSize == null && <option value="">未知</option>}
            {[...new Set([30, 40, 55, 70, 85, ...(state.subtitleSize == null ? [] : [state.subtitleSize])])].sort((a, b) => a - b)
              .map(value => <option key={value} value={value}>{value}</option>)}
          </SelectControl></label>
          <p className={styles.note}>字号仅调整纯文本字幕；ASS 自带样式及图像字幕保持原样。</p>
          <div className={styles.adjustment} role="group" aria-label="字幕延迟">
            <span>延迟 {state.subtitleDelay == null ? '未知' : `${state.subtitleDelay.toFixed(1)} 秒`}</span>
            <Button size="sm" disabled={disabled || !subtitle || state.subtitleDelay == null || state.subtitleDelay <= -60}
              onClick={() => control({ kind: 'subtitle-delay', seconds: Math.max(-60, state.subtitleDelay! - 0.5) })}>提前 0.5 秒</Button>
            <Button size="sm" disabled={disabled || !subtitle || state.subtitleDelay == null || state.subtitleDelay >= 60}
              onClick={() => control({ kind: 'subtitle-delay', seconds: Math.min(60, state.subtitleDelay! + 0.5) })}>延后 0.5 秒</Button>
            <Button size="sm" disabled={disabled || !subtitle || state.subtitleDelay === 0 || state.subtitleDelay == null}
              onClick={() => control({ kind: 'subtitle-delay', seconds: 0 })}>重置延迟</Button>
          </div>
          <form className={styles.exactTime} onSubmit={event => {
            event.preventDefault()
            if (seekDisabled) return
            const seconds = parsePlaybackTime(exactTime)
            if (seconds == null) { setTimeError('请输入秒数、分:秒或时:分:秒，最大 168 小时。'); return }
            if (state.duration != null && seconds > state.duration) { setTimeError('指定时间超过影片时长。'); return }
            setTimeError(null); control({ kind: 'seek', seconds })
          }}>
            <label>指定时间<TextInput aria-label="指定时间" value={exactTime} placeholder="00:12:34" maxLength={12}
              aria-describedby={timeHelpId} aria-invalid={Boolean(timeError)} disabled={seekDisabled}
              onChange={event => { setExactTime(event.target.value); setTimeError(null) }} /></label>
            <p id={timeHelpId} className={styles.note} role={timeError ? 'alert' : undefined}>{timeError ?? (state.seekable ? '支持秒数、分:秒或时:分:秒。' : '此资源当前不能定位。')}</p>
            <Button size="sm" type="submit" disabled={seekDisabled}>跳转到指定时间</Button>
          </form>
          {state.chapters.length > 0 && <label>章节<SelectControl aria-label="章节" value="none" disabled={seekDisabled} onChange={event => control({ kind: 'seek', seconds: Number(event.target.value) })}>
            <option value="none">跳到章节…</option>{state.chapters.map((chapter, index) => <option key={index} value={chapter.time}>{chapter.title}</option>)}
          </SelectControl></label>}
          <dl className={styles.info}><dt>来源</dt><dd>{state.source === 'remote' ? '远程原文件' : '本机文件'}</dd>
            <dt>视频</dt><dd>{state.info.videoCodec ?? '未知'} · {state.info.width ?? '?'}×{state.info.height ?? '?'}</dd>
            <dt>实际硬解</dt><dd>{state.info.hardwareDecoder || '软件解码'}</dd><dt>音频</dt><dd>{state.info.audioCodec ?? '无'} / {state.info.audioOutput ?? '无输出'}</dd>
          </dl>
          <p className={styles.note}>{state.recordingProgress ? '本次播放在此电脑保存续播进度。' : '本次播放不保存续播进度。'}</p>
          {state.recordingProgress && <Button size="sm" onClick={() => control({ kind: 'private-session' })}>本次停止保存进度</Button>}
          <Button size="sm" variant="ghost" onClick={() => setClearProgress(state.sessionId)}>清除此资源续播进度</Button>
          <p className={styles.note}>画面快捷键：空格播放/暂停，←/→ 跳转 5 秒，Shift+←/→ 跳转 30 秒，M 静音，F 全屏，Esc 返回。</p>
        </aside>}
      </div>
      {waitingResume && !fullscreen && <div className={styles.resume} role="group" aria-label="选择续播方式">
        <span>上次播放到 {playbackTime(state.resumePosition)}</span>
        <Button size="sm" variant="primary" disabled={disabled || !state.seekable || state.duration != null && state.duration - state.resumePosition! <= 30}
          onClick={() => control({ kind: 'resume', choice: 'continue' })}>继续 {playbackTime(state.resumePosition)}</Button>
        <Button size="sm" disabled={disabled} onClick={() => control({ kind: 'resume', choice: 'start' })}>从头播放</Button>
        <Button size="sm" variant="ghost" onClick={() => control({ kind: 'private-session' })}>本次不保存进度</Button>
      </div>}
      {!fullscreen && state.phase !== 'error' && <div className={styles.controls}>
        {docked && <span className={styles.title}>{state.title}</span>}
        <IconButton icon={state.phase === 'ended' ? <RotateCcw size={18} /> : state.paused ? <Play size={18} /> : <Pause size={18} />}
          label={state.phase === 'ended' ? '从头重播' : state.paused ? '播放' : '暂停'} disabled={disabled || waitingResume}
          onClick={() => control(state.phase === 'ended' ? { kind: 'restart' } : { kind: 'pause', paused: !state.paused })} />
        {!docked && <><Button size="sm" disabled={seekDisabled} onClick={() => control({ kind: 'seek', relative: true, seconds: -5 })}>−5 秒</Button>
          <Button size="sm" disabled={seekDisabled} onClick={() => control({ kind: 'seek', relative: true, seconds: 5 })}>+5 秒</Button></>}
        <div className={styles.progress}>
          <input className={styles.range} aria-label="播放进度" type="range" min={0} max={state.duration || 1} step={0.1} disabled={seekDisabled || !state.duration}
            value={seekDraft ?? state.position ?? 0} onChange={event => { seekDraftRef.current = Number(event.target.value); setSeekDraft(seekDraftRef.current) }}
            onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
            onPointerUp={commitSeek} onKeyUp={commitSeek} onBlur={commitSeek} onPointerCancel={() => { seekDraftRef.current = null; setSeekDraft(null) }}
            aria-valuetext={`${playbackTime(seekDraft ?? state.position)} / ${playbackTime(state.duration)}`} />
          <Button className={styles.time} size="sm" variant="ghost" aria-label={remaining ? '切换显示总时长' : '切换显示剩余时间'} onClick={() => setRemaining(value => !value)}>
            {playbackTime(seekDraft ?? state.position)} / {remaining ? `剩余 ${playbackTime(state.duration == null || state.position == null ? null : state.duration - (seekDraft ?? state.position))}` : playbackTime(state.duration)}
          </Button>
        </div>
        <IconButton icon={state.muted ? <VolumeX size={18} /> : <Volume2 size={18} />} label={state.muted ? '取消静音' : '静音'} onClick={() => control({ kind: 'mute', muted: !state.muted })} />
        <input className={`${styles.range} ${styles.volume}`} aria-label="音量" type="range" min={0} max={100} value={state.volume} onChange={event => control({ kind: 'volume', value: Number(event.target.value) })} />
        {docked ? <><IconButton icon={<Maximize size={18} />} label="恢复展开" onClick={() => control({ kind: 'presentation', value: 'expanded' })} />
          <IconButton icon={<X size={18} />} label="停止播放" onClick={() => control({ kind: 'stop' })} /></>
          : <IconButton icon={<SlidersHorizontal size={18} />} label="播放选项" aria-expanded={options} onClick={() => presentationHistory.setOptions(!options)} />}
        <span className={styles.status} role="status">{state.error ?? state.progressError ?? (waitingResume ? '等待续播选择' : { opening: '打开中…', buffering: '缓冲中…', paused: '已暂停', ended: '播放结束', playing: '', error: '播放错误' }[state.phase])}</span>
      </div>}
      {clearProgress && <Modal title="清除此资源续播进度" confirmText="清除进度" danger onCancel={() => setClearProgress(null)}
        onConfirm={async () => { await api.playback.clearProgress({ scope: 'current', sessionId: clearProgress }); setClearProgress(null) }}>
        <p>清除此资源在这台电脑上的续播位置，无法撤销。本次播放停止保存进度，影片和资料保留。</p>
      </Modal>}
    </div>
  </InteractionLayerOwner.Provider>
}
