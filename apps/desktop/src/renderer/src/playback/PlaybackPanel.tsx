import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX, X, SlidersHorizontal, PanelTop } from 'lucide-react'
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
import { playbackOcclusions } from './playbackOcclusion'
import styles from './PlaybackPanel.module.css'
import AiSubtitleSettings from './AiSubtitleSettings'

let viewportSequence = 0

export default function PlaybackPanel(): JSX.Element | null {
  const [state, setState] = useState<PlaybackSnapshot | null>(null)
  const [seekDraft, setSeekDraft] = useState<number | null>(null)
  const seekDraftRef = useRef<number | null>(null)
  const pendingSeekRef = useRef<{ sessionId: string; seconds: number } | null>(null)
  const [exactTime, setExactTime] = useState('')
  const [timeError, setTimeError] = useState<string | null>(null)
  const [remaining, setRemaining] = useState(false)
  const timeHelpId = useId()
  const [options, setOptions] = useState(false)
  const [optionTab, setOptionTab] = useState<'playback' | 'subtitle' | 'info'>('playback')
  const settingsId = useId()
  const [chromeVisible, setChromeVisible] = useState(true)
  const [htmlControlsFocused, setControlsFocused] = useState(false)
  const controlsFocused = htmlControlsFocused && state?.nativeVideoFocused !== true
  const [hoveredChrome, setHoveredChrome] = useState<'header' | 'controls' | null>(null)
  const [childLayerActive, setChildLayerActive] = useState(false)
  const handledFocus = useRef<number | undefined>()
  const keyboardChrome = useRef(false)
  const [adjusting, setAdjusting] = useState(false)
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null)
  const pendingVolume = useRef<{ sessionId: string; value: number } | null>(null)
  const [clearProgress, setClearProgress] = useState<string | null>(null)
  const [recoverySession, setRecoverySession] = useState<string | null>(null)
  const recoveryRef = useRef<string | null>(null)
  const [sources, setSources] = useState<{ sessionId: string; items: Array<{ id: number; label: string }>; error: string | null } | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const root = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLButtonElement>(null)
  const header = useRef<HTMLElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
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
  const locatePointer = useCallback((y: number): void => {
    const bounds = root.current?.getBoundingClientRect()
    const top = bounds?.top ?? 0, height = bounds?.height ?? window.innerHeight
    const headerHeight = header.current?.getBoundingClientRect().height || 64
    const toolbarHeight = toolbar.current?.getBoundingClientRect().height || 96
    setHoveredChrome(y < top || y >= top + height ? null : y < top + headerHeight ? 'header'
      : y >= top + height - toolbarHeight ? 'controls' : null)
    setChildLayerActive(!layer.isTop() && interactionLayers.isActiveModal(layer.id))
  }, [layer])
  useEffect(() => {
    if (!api.playback) return
    let disposed = false
    let revision = 0
    const off = api.playback.onChanged(value => { revision++; presentationHistory.observe(value); setState(value) })
    void api.playback.snapshot().then(value => { if (!disposed && revision === 0) { presentationHistory.observe(value, true); setState(value) } })
    return () => { disposed = true; off() }
  }, [presentationHistory])
  useEffect(() => {
    seekDraftRef.current = null; pendingSeekRef.current = null; setSeekDraft(null)
    pendingVolume.current = null; setVolumeDraft(null); setAdjusting(false); setChromeVisible(state?.presentation !== 'fullscreen'); setHoveredChrome(null)
  }, [state?.sessionId, state?.presentation])
  useEffect(() => {
    const pending = pendingVolume.current
    if (pending && state && (state.phase === 'error' || Math.abs(state.volume - pending.value) < 0.5)) {
      pendingVolume.current = null; setVolumeDraft(null)
    }
  }, [state])
  useEffect(() => {
    const pending = pendingSeekRef.current
    if (!pending || !state || state.sessionId !== pending.sessionId) return
    // IPC completion only accepts the command. Keep its thumb until the native
    // clock confirms the seek, rather than redisplaying the pre-seek snapshot.
    if (state.phase === 'error' || !state.seeking && state.position != null && Math.abs(state.position - pending.seconds) < 2) {
      pendingSeekRef.current = null
      if (seekDraftRef.current == null) setSeekDraft(null)
    }
  }, [state])
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
  const rendererFullscreen = presentation === 'fullscreen' && state?.rendererFullscreenControls === true
  const [chromeActivity, setChromeActivity] = useState(0)
  const revealChrome = useCallback(() => { setChromeVisible(true); setChromeActivity(value => value + 1) }, [])
  useEffect(() => {
    if (rendererFullscreen && state?.fullscreenPointerY != null) locatePointer(state.fullscreenPointerY)
  }, [rendererFullscreen, state?.fullscreenPointerY, locatePointer])
  useEffect(() => {
    if (!rendererFullscreen) { setChildLayerActive(false); return }
    const sync = (): void => setChildLayerActive(!layer.isTop() && interactionLayers.isActiveModal(layer.id))
    const timer = window.setInterval(sync, 100)
    return () => window.clearInterval(timer)
  }, [rendererFullscreen, layer])
  useEffect(() => {
    const blur = (): void => setControlsFocused(false)
    window.addEventListener('blur', blur)
    return () => window.removeEventListener('blur', blur)
  }, [])
  useEffect(() => {
    if (!rendererFullscreen) { setChromeVisible(true); return }
    if (options || adjusting || controlsFocused) return
    const hide = (): void => {
      // Portaled quick menus keep their anchor visible even while focus remains
      // on the mouse-clicked trigger. Retry after the child layer is dismissed.
      if (!layer.isTop()) { timer = window.setTimeout(hide, 3000); return }
      setChromeVisible(false)
    }
    let timer = window.setTimeout(hide, 3000)
    return () => window.clearTimeout(timer)
  }, [rendererFullscreen, options, adjusting, controlsFocused, chromeActivity, layer])
  const previousPresentation = useRef(presentation)
  useLayoutEffect(() => {
    const previous = previousPresentation.current
    previousPresentation.current = presentation
    if (previous === 'fullscreen' && presentation === 'expanded' && layer.isTop()) video.current?.focus()
  }, [presentation, layer])
  useLayoutEffect(() => {
    const current = stateRef.current
    if (!current?.focusRequest || current.presentation === 'fullscreen' && !current.rendererFullscreenControls || !root.current || !video.current) return
    if (handledFocus.current === current.focusRequest.sequence) return
    if (current.rendererFullscreenControls && !chromeVisible) { setChromeVisible(true); return }
    if (current.presentation === 'docked' ? interactionLayers.hasModal() : !layer.isTop()) return
    const elements = Array.from(root.current.querySelectorAll<HTMLElement>('button,input,select,textarea,[tabindex]'))
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert],[aria-hidden="true"]') && element.getClientRects().length > 0)
    const index = elements.indexOf(video.current)
    if (index < 0 || !elements.length) return
    const next = (index + (current.focusRequest.backwards ? -1 : 1) + elements.length) % elements.length
    keyboardChrome.current = true
    elements[next]?.focus()
    handledFocus.current = current.focusRequest.sequence
  }, [sessionId, focusSequence, layer, chromeVisible])
  useLayoutEffect(() => {
    if (!sessionId || !presentation || presentationRevision == null) return
    let last = ''
    let disposed = false
    const report = (): void => {
      const current = stateRef.current
      const element = video.current
      if (!current || current.sessionId !== sessionId || !element || disposed) return
      const bounds = element.getBoundingClientRect()
      const occlusions = playbackOcclusions(bounds, document.querySelectorAll<HTMLElement>('[data-native-playback-occluder]'))
      const visible = current.phase !== 'error' && bounds.width > 0 && bounds.height > 0
        && document.visibilityState !== 'hidden' && !element.closest('[inert]')
        && (presentation === 'docked' ? !interactionLayers.hasModal() : interactionLayers.isActiveModal(layer.id))
        && (current.rendererFullscreenControls || occlusions.length === 0)
      const rect = { x: Math.max(0, bounds.x), y: Math.max(0, bounds.y), width: bounds.width, height: bounds.height }
      const popupRects = current.rendererFullscreenControls ? occlusions.slice(0, 32) : undefined
      const key = JSON.stringify([rect, visible, popupRects, window.devicePixelRatio])
      if (key === last) return
      last = key
      void api.playback.viewport({ sessionId, sequence: ++viewportSequence, presentation, presentationRevision, rect, visible,
        ...(popupRects ? { occlusions: popupRects } : {}) }).catch(() => { /* Old session geometry is disposable. */ })
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
  const nativeFullscreen = fullscreen && !state.rendererFullscreenControls
  const headerShown = !rendererFullscreen || chromeVisible || hoveredChrome === 'header' || options
  const chromeShown = !rendererFullscreen || chromeVisible || hoveredChrome === 'controls' || options || adjusting || controlsFocused || childLayerActive
  const disabled = state.phase === 'opening' || state.phase === 'error'
  const waitingResume = state.resumePosition != null
  const seekDisabled = disabled || waitingResume || !state.seekable
  const commitSeek = (): void => {
    const seconds = seekDraftRef.current
    seekDraftRef.current = null
    if (seconds == null) return
    const pending = { sessionId: state.sessionId, seconds }
    pendingSeekRef.current = pending
    void api.playback.control(pending.sessionId, { kind: 'seek', seconds }).catch(error => {
      if (pendingSeekRef.current !== pending) return
      pendingSeekRef.current = null
      if (seekDraftRef.current == null) setSeekDraft(null)
      toast.show((error as Error).message, 'error')
    })
  }
  const subtitle = state.tracks.find(track => track.type === 'sub' && track.selected)
  const sizeSupported = Boolean(subtitle?.codec && ['subrip', 'srt', 'webvtt', 'text', 'mov_text'].includes(subtitle.codec))
  const trackSelect = (type: 'audio' | 'sub', quick = false): JSX.Element => <SelectControl aria-label={quick ? type === 'audio' ? '快捷音轨' : '快捷字幕' : type === 'audio' ? '音轨' : '字幕'}
    className={quick ? styles.quickSelect : undefined} displayLabel={quick ? type === 'audio' ? '音轨' : '字幕' : undefined}
    disabled={disabled}
    value={state.tracks.find(track => track.type === type && track.selected)?.id ?? 'no'}
    onChange={event => control({ kind: 'track', type, id: event.target.value === 'no' ? null : Number(event.target.value) })}>
    <option value="no">{type === 'audio' ? '关闭音轨' : '关闭字幕'}</option>
    {state.tracks.filter(track => track.type === type).map(track => <option key={track.id} value={track.id}>{playbackTrackLabel(track)}</option>)}
  </SelectControl>
  const speedSelect = (quick = false): JSX.Element => <SelectControl aria-label={quick ? '快捷倍速' : '倍速'}
    className={quick ? styles.quickSelect : undefined} displayLabel={quick ? `${state.speed}×` : undefined}
    value={state.speed} disabled={disabled} onChange={event => control({ kind: 'speed', value: Number(event.target.value) })}>
    {[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
  </SelectControl>
  const volume = volumeDraft ?? state.volume
  const position = seekDraft ?? state.position ?? 0
  const rangeFill = (value: number, max: number): CSSProperties => ({ '--playback-fill': `${Math.max(0, Math.min(100, value / Math.max(1, max) * 100))}%` } as CSSProperties)
  const status = state.error ?? state.progressError ?? (waitingResume ? '等待续播选择' : { opening: '打开中…', buffering: '缓冲中…', paused: '', ended: '播放结束', playing: '', error: '播放错误' }[state.phase])
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
      data-controls-visible={chromeShown} data-header-visible={headerShown} data-renderer-fullscreen={rendererFullscreen || undefined}
      role={docked ? 'region' : 'dialog'} aria-modal={docked ? undefined : true} aria-label="内置播放器" tabIndex={-1}
      onPointerMove={rendererFullscreen ? event => locatePointer(event.clientY) : undefined}
      onPointerLeave={rendererFullscreen ? () => locatePointer(-1) : undefined}
      onPointerDownCapture={() => { keyboardChrome.current = false; setControlsFocused(false) }}
      onKeyDownCapture={event => { if (event.key === 'Tab') keyboardChrome.current = true }}
      onFocusCapture={event => {
        const target = event.target as HTMLElement
        if (keyboardChrome.current && target !== root.current) revealChrome()
        setControlsFocused(Boolean(target.closest?.('[data-native-playback-occluder]') && !root.current?.contains(target))
          || keyboardChrome.current && target !== root.current && target !== video.current)
      }}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget) && !(event.relatedTarget as HTMLElement | null)?.closest?.('[data-native-playback-occluder]')) setControlsFocused(false)
      }}
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
      {!docked && !nativeFullscreen && <header ref={header} className={styles.header} hidden={!headerShown && !rendererFullscreen}
        data-chrome-visible={headerShown} aria-hidden={rendererFullscreen && !headerShown || undefined} data-native-playback-occluder={rendererFullscreen || undefined}>
        <div className={styles.heading}><span className={styles.title}>{state.title}</span><span className={styles.caption}>{state.source === 'remote' ? '远程原文件' : '本机文件'}</span></div>
        <IconButton icon={<ChevronDown size={18} />} label="收起到底栏" disabled={state.phase === 'error'} onClick={() => control({ kind: 'presentation', value: 'docked' })} />
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
        </div> : <button ref={video} className={styles.video} aria-hidden={nativeFullscreen || undefined} tabIndex={nativeFullscreen ? -1 : 0}
          aria-label={docked ? '恢复展开播放器' : '视频画面，单击播放或暂停，双击全屏'}
          onClick={() => control(docked ? { kind: 'presentation', value: 'expanded' }
            : state.phase === 'ended' ? { kind: 'restart' } : { kind: 'pause', paused: !state.paused })} />}
        {options && !docked && !nativeFullscreen && state.phase !== 'error' && <aside className={styles.options} aria-label="播放设置" id={settingsId} data-native-playback-occluder={rendererFullscreen || undefined}>
          <div className={styles.optionsHeader}><span>播放设置</span><IconButton size="sm" icon={<X size={16} />} label="关闭播放设置" onClick={() => presentationHistory.setOptions(false)} /></div>
          <div className={styles.tabs} role="tablist" aria-label="播放设置分类">
            {(['playback', 'subtitle', 'info'] as const).map(tab => <button type="button" role="tab" key={tab}
              id={`${settingsId}-${tab}-tab`} aria-controls={`${settingsId}-${tab}`} aria-selected={optionTab === tab} tabIndex={optionTab === tab ? 0 : -1}
              onClick={() => setOptionTab(tab)} onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault(); event.stopPropagation()
                const tabs = ['playback', 'subtitle', 'info'] as const
                const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowLeft' ? 2 : 1)) % tabs.length]
                setOptionTab(next); document.getElementById(`${settingsId}-${next}-tab`)?.focus()
              }}>{({ playback: '播放', subtitle: '字幕', info: '信息' })[tab]}</button>)}
          </div>
          <div className={styles.optionBody} role="tabpanel" id={`${settingsId}-playback`} aria-labelledby={`${settingsId}-playback-tab`} hidden={optionTab !== 'playback'}>
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
          <label>音轨{trackSelect('audio')}</label>
          <p className={styles.note}>声道数来自文件标记，不代表设备实际输出。</p>
          <label>倍速{speedSelect()}</label>
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
          </div>
          <div className={styles.optionBody} role="tabpanel" id={`${settingsId}-subtitle`} aria-labelledby={`${settingsId}-subtitle-tab`} hidden={optionTab !== 'subtitle'}>
          <AiSubtitleSettings playback={state} />
          <label>字幕{trackSelect('sub')}</label>
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
          </div>
          <div className={styles.optionBody} role="tabpanel" id={`${settingsId}-info`} aria-labelledby={`${settingsId}-info-tab`} hidden={optionTab !== 'info'}>
          <dl className={styles.info}><dt>来源</dt><dd>{state.source === 'remote' ? '远程原文件' : '本机文件'}</dd>
            <dt>视频</dt><dd>{state.info.videoCodec ?? '未知'} · {state.info.width ?? '?'}×{state.info.height ?? '?'}</dd>
            <dt>实际硬解</dt><dd>{state.info.hardwareDecoder || '软件解码'}</dd><dt>音频</dt><dd>{state.info.audioCodec ?? '无'} / {state.info.audioOutput ?? '无输出'}</dd>
          </dl>
          <p className={styles.note}>{state.recordingProgress ? '本次播放在此电脑保存续播进度。' : '本次播放不保存续播进度。'}</p>
          {state.recordingProgress && <Button size="sm" onClick={() => control({ kind: 'private-session' })}>本次停止保存进度</Button>}
          <Button size="sm" variant="ghost" onClick={() => setClearProgress(state.sessionId)}>清除此资源续播进度</Button>
          <p className={styles.note}>画面快捷键：空格播放/暂停，←/→ 跳转 5 秒，Shift+←/→ 跳转 30 秒，M 静音，F 全屏，Esc 返回。</p>
          </div>
        </aside>}
      </div>
      {waitingResume && !fullscreen && <div className={styles.resume} role="group" aria-label="选择续播方式">
        <span>上次播放到 {playbackTime(state.resumePosition)}</span>
        <Button size="sm" variant="primary" disabled={disabled || !state.seekable || state.duration != null && state.duration - state.resumePosition! <= 30}
          onClick={() => control({ kind: 'resume', choice: 'continue' })}>继续 {playbackTime(state.resumePosition)}</Button>
        <Button size="sm" disabled={disabled} onClick={() => control({ kind: 'resume', choice: 'start' })}>从头播放</Button>
        <Button size="sm" variant="ghost" onClick={() => control({ kind: 'private-session' })}>本次不保存进度</Button>
      </div>}
      {!nativeFullscreen && state.phase !== 'error' && <div ref={toolbar} className={styles.controls} hidden={!chromeShown && !rendererFullscreen}
        data-chrome-visible={chromeShown} aria-hidden={rendererFullscreen && !chromeShown || undefined} data-native-playback-occluder={rendererFullscreen || undefined}>
        <div className={styles.progress}>
          <span className={styles.currentTime}>{playbackTime(seekDraft ?? state.position)}</span>
          <input className={styles.range} aria-label="播放进度" type="range" min={0} max={state.duration || 1} step={0.1} disabled={seekDisabled || !state.duration}
            style={rangeFill(position, state.duration || 1)} value={position} onChange={event => { seekDraftRef.current = Number(event.target.value); setSeekDraft(seekDraftRef.current) }}
            onKeyDown={event => {
              if (event.defaultPrevented || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || !document.hasFocus()
                || seekDisabled || !state.duration || (docked ? interactionLayers.hasModal() : !layer.isTop())) return
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault(); event.stopPropagation()
              keyboardChrome.current = true; setControlsFocused(true); revealChrome()
              const pending = pendingSeekRef.current
              const from = seekDraftRef.current ?? (pending?.sessionId === state.sessionId ? pending.seconds : null) ?? state.position ?? 0
              const seconds = Math.max(0, Math.min(state.duration, from + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 30 : 5)))
              seekDraftRef.current = seconds; setSeekDraft(seconds); commitSeek()
            }}
            onPointerDown={event => { setAdjusting(true); event.currentTarget.setPointerCapture(event.pointerId) }}
            onPointerUp={() => { setAdjusting(false); commitSeek() }} onKeyUp={commitSeek} onBlur={() => { setAdjusting(false); commitSeek() }} onPointerCancel={() => { setAdjusting(false); seekDraftRef.current = null; setSeekDraft(null) }}
            aria-valuetext={`${playbackTime(seekDraft ?? state.position)} / ${playbackTime(state.duration)}`} />
          <Button className={styles.time} size="sm" variant="ghost" aria-label={remaining ? '切换显示总时长' : '切换显示剩余时间'} onClick={() => setRemaining(value => !value)}>
            {remaining ? `−${playbackTime(state.duration == null || state.position == null ? null : state.duration - (seekDraft ?? state.position))}` : playbackTime(state.duration)}
          </Button>
        </div>
        <div className={styles.transport} aria-label="播放控制">
          {docked && <span className={styles.title}>{state.title}</span>}
          <IconButton size="control" tone="accent" icon={state.phase === 'ended' ? <RotateCcw size={18} /> : state.paused ? <Play size={18} /> : <Pause size={18} />}
            label={state.phase === 'ended' ? '从头重播' : state.paused ? '播放' : '暂停'} disabled={disabled || waitingResume}
            onClick={() => control(state.phase === 'ended' ? { kind: 'restart' } : { kind: 'pause', paused: !state.paused })} />
          {!docked && <><Button size="sm" variant="ghost" className={styles.skip} aria-label="后退 5 秒" disabled={seekDisabled} onClick={() => control({ kind: 'seek', relative: true, seconds: -5 })}><RotateCcw size={16} />5</Button>
            <Button size="sm" variant="ghost" className={styles.skip} aria-label="前进 5 秒" disabled={seekDisabled} onClick={() => control({ kind: 'seek', relative: true, seconds: 5 })}><RotateCw size={16} />5</Button></>}
          <div className={styles.volumeGroup}>
            <IconButton size="control" icon={state.muted ? <VolumeX size={18} /> : <Volume2 size={18} />} label={state.muted ? '取消静音' : '静音'} onClick={() => control({ kind: 'mute', muted: !state.muted })} />
            <input className={`${styles.range} ${styles.volume}`} aria-label="音量" type="range" min={0} max={100} style={rangeFill(volume, 100)} value={volume}
              onPointerDown={() => setAdjusting(true)} onPointerUp={() => setAdjusting(false)} onPointerCancel={() => setAdjusting(false)} onBlur={() => setAdjusting(false)}
              onChange={event => {
                const pending = { sessionId: state.sessionId, value: Number(event.target.value) }
                pendingVolume.current = pending; setVolumeDraft(pending.value)
                void api.playback.control(pending.sessionId, { kind: 'volume', value: pending.value }).catch(error => {
                  if (pendingVolume.current !== pending) return
                  pendingVolume.current = null; setVolumeDraft(null); toast.show((error as Error).message, 'error')
                })
              }} aria-valuetext={`${volume}%`} />
            <span className={styles.volumeValue}>{volume}%</span>
          </div>
          {!docked && <><span className={styles.spacer} /><div className={styles.quickControls}>{trackSelect('audio', true)}{trackSelect('sub', true)}{speedSelect(true)}</div>
            <span className={styles.separator} /><IconButton size="control" icon={<SlidersHorizontal size={18} />} label="播放设置" aria-expanded={options} aria-controls={settingsId} aria-pressed={options} onClick={() => presentationHistory.setOptions(!options)} /></>}
          <IconButton size="control" icon={docked ? <PanelTop size={18} /> : fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            label={docked ? '恢复展开' : fullscreen ? '退出全屏' : '全屏'} disabled={waitingResume && !docked}
            onClick={() => control({ kind: 'presentation', value: docked || fullscreen ? 'expanded' : 'fullscreen' })} />
          {docked && <IconButton size="control" icon={<X size={18} />} label="停止播放" onClick={() => control({ kind: 'stop' })} />}
          <span className={styles.status} role="status">{status}</span>
        </div>
      </div>}
      {clearProgress && <Modal title="清除此资源续播进度" confirmText="清除进度" danger onCancel={() => setClearProgress(null)}
        onConfirm={async () => { await api.playback.clearProgress({ scope: 'current', sessionId: clearProgress }); setClearProgress(null) }}>
        <p>清除此资源在这台电脑上的续播位置，无法撤销。本次播放停止保存进度，影片和资料保留。</p>
      </Modal>}
    </div>
  </InteractionLayerOwner.Provider>
}
