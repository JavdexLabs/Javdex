import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX, X, SlidersHorizontal, PanelTop } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import type { PlaybackControl } from '@shared/desktop/playback'
import { api } from '../api'
import Button from '../components/Button'
import IconButton from '../components/IconButton'
import SelectControl from '../components/SelectControl'
import { playbackTime } from './playbackTime'
import { useToast } from '../components/Toast'
import { InteractionLayerOwner, useInteractionLayer } from '../interaction/useInteractionLayer'
import { interactionLayers } from '../interaction/interactionLayers'
import { useOverlayHistory } from '../interaction/OverlayHistoryContext'
import type { OverlayTraversalResult } from '../interaction/overlayHistory'
import { createPlaybackHistory, type PlaybackViewState } from './playbackHistory'
import { usePlaybackPointerGestures } from './usePlaybackPointerGestures'
import { playbackTrackLabel } from './playbackTrackLabel'
import styles from './PlaybackPanel.module.css'
import AiSubtitleSettings from './AiSubtitleSettings'
import AiSubtitleToggle from './AiSubtitleToggle'
import { useAiSubtitles } from './useAiSubtitles'
import { settingsPath } from '../settings/settingsRoutes'
import { mediaLibraryVideoDetailPath } from '../listView/mediaLibraryRoutes'

function recoveryLabel(reason: string): string {
  if (reason === 'DISPLAY_SELF_TEST_FAILED') return 'GPU 画面通道检查未通过'
  if (reason === 'DISPLAY_SELF_TEST_TIMEOUT' || reason === 'RECEIVER_NOT_READY') return '等待 GPU 画面超时'
  if (reason === 'TEXTURE_IMPORT_FAILED' || reason === 'FRAME_CHANNEL_FAILED') return '共享画面传输失败'
  if (reason === 'GPU_PROCESS_EXITED') return 'GPU 进程退出'
  if (reason === 'HELPER_HEARTBEAT_TIMEOUT' || reason === 'FRAME_RELEASE_TIMEOUT') return 'GPU 播放通道未响应'
  return '当前 GPU 播放路径不可用'
}

let viewportSequence = 0

export default function PlaybackPanel(): JSX.Element | null {
  const navigate = useNavigate()
  const [view, setView] = useState<PlaybackViewState>({ snapshot: null, activation: null })
  const state = view.snapshot
  const aiSubtitles = useAiSubtitles(state?.sessionId ?? null)
  const [seekDraft, setSeekDraft] = useState<number | null>(null)
  const seekDraftRef = useRef<number | null>(null)
  const pendingSeekRef = useRef<{ sessionId: string; seconds: number } | null>(null)
  const [remaining, setRemaining] = useState(false)
  const [options, setOptions] = useState(false)
  const [optionTab, setOptionTab] = useState<'playback' | 'subtitle' | 'info'>('playback')
  const settingsId = useId()
  const [chromeVisible, setChromeVisible] = useState(true)
  const [htmlControlsFocused, setControlsFocused] = useState(false)
  const controlsFocused = htmlControlsFocused
  const [hoveredChrome, setHoveredChrome] = useState<'header' | 'controls' | null>(null)
  const [childLayerActive, setChildLayerActive] = useState(false)
  const keyboardChrome = useRef(false)
  const [adjusting, setAdjusting] = useState(false)
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null)
  const pendingVolume = useRef<{ sessionId: string; value: number } | null>(null)
  const [recoverySession, setRecoverySession] = useState<string | null>(null)
  const recoveryRef = useRef<string | null>(null)
  const [sources, setSources] = useState<{ sessionId: string; items: Array<{ id: number; label: string }>; error: string | null } | null>(null)
  const [videoTitle, setVideoTitle] = useState<{ sessionId: string; label: string } | null>(null)
  const [chromeActivity, setChromeActivity] = useState(0)
  const revealChrome = useCallback(() => { setChromeVisible(true); setChromeActivity(value => value + 1) }, [])
  const stateRef = useRef(state)
  stateRef.current = state
  const root = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLButtonElement>(null)
  const settingsToggle = useRef<HTMLButtonElement>(null)
  const previousOptions = useRef(options)
  const { cancel: cancelVideoClick, onMouseDown: videoMouseDown, click: videoClick } = usePlaybackPointerGestures(state)
  const header = useRef<HTMLElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const toast = useToast()
  const history = useOverlayHistory()
  const send = useRef((id: string, command: PlaybackControl): void => { void api.playback.control(id, command).catch(error => toast.show((error as Error).message, 'error')) })
  send.current = (id, command) => {
    cancelVideoClick()
    void api.playback.control(id, command).catch(error => toast.show((error as Error).message, 'error'))
  }
  const viewingHistory = useRef<ReturnType<typeof createPlaybackHistory>>()
  if (!viewingHistory.current) viewingHistory.current = createPlaybackHistory(history, (id, command) => send.current(id, command), setOptions)
  const presentationHistory = viewingHistory.current
  const control = useCallback((command: PlaybackControl): void => {
    const id = stateRef.current?.sessionId
    if (id) void api.playback.control(id, command).catch(error => toast.show((error as Error).message, 'error'))
  }, [toast])
  const changeVolume = useCallback((sessionId: string, value: number): void => {
    const pending = { sessionId, value }
    pendingVolume.current = pending; setVolumeDraft(value)
    void api.playback.control(sessionId, { kind: 'volume', value }).catch(error => {
      if (pendingVolume.current !== pending) return
      pendingVolume.current = null; setVolumeDraft(null); toast.show((error as Error).message, 'error')
    })
  }, [toast])
  const transport = (command: Extract<PlaybackControl, { kind: 'pause' | 'restart' | 'resume' | 'stop' | 'presentation' }>): void => {
    cancelVideoClick()
    control(command)
  }
  const openSubtitleModels = async (sessionId: string): Promise<void> => {
    // Docking unmounts the subtitle controls before IPC can acknowledge it.
    // Keep navigation in the stable panel and reject acknowledgements for old sessions.
    cancelVideoClick()
    await api.playback.control(sessionId, { kind: 'presentation', value: 'docked' })
    if (stateRef.current?.sessionId !== sessionId) return
    presentationHistory.closeForNavigation()
    // Overlay history.go is asynchronous and would otherwise undo the settings route.
    const result = await new Promise<OverlayTraversalResult>(resolve => { history.afterTraversal(resolve) })
    if (result === 'failed') { toast.show('观看窗口收起失败，请重试跳转', 'error'); return }
    if (result !== 'completed') return
    if (stateRef.current?.sessionId === sessionId) navigate({ pathname: settingsPath('models', 'usage'), hash: '#ai-subtitles' })
  }
  const layer = useInteractionLayer({
    enabled: Boolean(state && state.presentation !== 'docked'), rootRef: root, modal: true, restoring: view.activation?.restoring ?? true,
    restorationKey: history, activationKey: view.activation?.key,
    onDismiss: () => {
      if (stateRef.current?.phase === 'error') transport({ kind: 'stop' })
      else if (options) presentationHistory.setOptions(false)
      else transport({ kind: 'presentation', value: stateRef.current?.presentation === 'fullscreen' ? 'expanded' : 'docked' })
    }
  })
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const key = event.key
      const seek = key === 'ArrowLeft' || key === 'ArrowRight'
      const volumeKey = key === 'ArrowUp' || key === 'ArrowDown'
      const letter = key.toLowerCase()
      if (!seek && !volumeKey && key !== ' ' && letter !== 'm' && letter !== 'f') return
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey
        || !document.hasFocus() || event.repeat && (key === ' ' || letter === 'm' || letter === 'f')) return
      const current = stateRef.current
      if (!current || current.phase === 'error') return
      const target = event.target
      const insidePlayer = typeof Node !== 'undefined' && target instanceof Node && Boolean(root.current?.contains(target))
      const page = target === window || target === document || target === document.body || target === document.documentElement
      if (current.presentation === 'docked' ? !insidePlayer || interactionLayers.hasModal() : !layer.isTop() || !insidePlayer && !page) return
      const focusedPlayerSlider = (seek || volumeKey) && typeof Element !== 'undefined' && target instanceof Element && (
        target.matches('input[type="range"][aria-label="音量"]')
        || volumeKey && target.matches('input[type="range"][aria-label="播放进度"]'))
      if (typeof Element !== 'undefined' && target instanceof Element) {
        if (!focusedPlayerSlider && target.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="combobox"],[role="listbox"],[role="slider"],[aria-haspopup="listbox"]')) return
        if (key === ' ' && target.closest('button,[role="button"],a[href],summary')) return
      }
      if (seek && (current.phase === 'opening' || current.resumePosition != null || !current.seekable)) {
        if (focusedPlayerSlider) event.preventDefault()
        return
      }
      if (key === ' ' && (current.phase === 'opening' || current.resumePosition != null)) return
      if (letter === 'f' && current.resumePosition != null) return
      event.preventDefault()
      if (current.presentation === 'fullscreen') revealChrome()
      if (seek) control({ kind: 'seek', relative: true, seconds: (key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 30 : 5) })
      else if (volumeKey) {
        const from = pendingVolume.current?.sessionId === current.sessionId ? pendingVolume.current.value : current.volume
        const value = Math.max(0, Math.min(100, from + (key === 'ArrowUp' ? 5 : -5)))
        if (value !== from) changeVolume(current.sessionId, value)
      } else if (key === ' ') {
        cancelVideoClick()
        control(current.phase === 'ended' ? { kind: 'restart' } : { kind: 'pause', paused: !current.paused })
      } else if (letter === 'm') control({ kind: 'mute', muted: !current.muted })
      else {
        cancelVideoClick()
        control({ kind: 'presentation', value: current.presentation === 'fullscreen' ? 'expanded' : 'fullscreen' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancelVideoClick, changeVolume, control, layer, revealChrome])
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
    const disconnect = presentationHistory.connect(api.playback, setView)
    return () => { stateRef.current = null; disconnect() }
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
  useEffect(() => { setRecoverySession(null); recoveryRef.current = null }, [state?.sessionId])
  const sessionId = state?.sessionId
  const libraryId = state?.target.libraryId
  const videoId = state?.target.videoId
  const presentation = state?.presentation
  useEffect(() => {
    if ((!options && presentation !== 'docked') || !sessionId || libraryId == null || videoId == null) return
    let disposed = false
    setSources(null)
    void api.videos.get({ kind: 'library', libraryId }, videoId).then(detail => {
      if (disposed) return
      if (!detail || detail.activeLibraryId !== libraryId) throw new Error('Video no longer belongs to this library')
      setVideoTitle({ sessionId, label: [detail.code?.trim(), detail.title?.trim()].filter(Boolean).join(' ') })
      const items = detail.resources.filter(resource => resource.kind === 'local' && resource.library_id === libraryId && resource.video_id === videoId)
        .map(resource => ({ id: resource.id, label: resource.display_name?.trim() || resource.display_locator.split(/[\\/]/).pop() || '当前文件' }))
      setSources({ sessionId, items, error: null })
    }).catch(() => {
      if (!disposed) setSources({ sessionId, items: [], error: '无法读取播放来源，请关闭再打开播放选项重试。' })
    })
    return () => { disposed = true }
  }, [options, sessionId, libraryId, videoId, presentation])
  const sharedTextureSurface = state?.phase === 'error' ? undefined : state?.sharedTextureSurface
  useLayoutEffect(() => {
    if (!sharedTextureSurface) return
    return api.playback.bindSharedTextureSurface(sharedTextureSurface)
  }, [sharedTextureSurface])
  const presentationRevision = state?.presentationRevision
  const rendererFullscreen = presentation === 'fullscreen'
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
    const wasOpen = previousOptions.current
    previousOptions.current = options
    if (wasOpen && !options && state?.presentation !== 'docked' && state?.phase !== 'error'
      && (!document.activeElement || document.activeElement === document.body || document.activeElement === settingsToggle.current)) {
      video.current?.focus({ preventScroll: true })
    }
  }, [options, state?.presentation, state?.phase])
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
        && document.visibilityState !== 'hidden'
      const rect = { x: Math.max(0, bounds.x), y: Math.max(0, bounds.y), width: bounds.width, height: bounds.height }
      const key = JSON.stringify([rect, visible, window.devicePixelRatio])
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
  const trackSelect = (type: 'audio' | 'sub'): JSX.Element => <SelectControl aria-label={type === 'audio' ? '音轨' : '字幕'}
    disabled={disabled}
    value={state.tracks.find(track => track.type === type && track.selected)?.id ?? 'no'}
    onChange={event => control({ kind: 'track', type, id: event.target.value === 'no' ? null : Number(event.target.value) })}>
    <option value="no">{type === 'audio' ? '关闭音轨' : '关闭字幕'}</option>
    {state.tracks.filter(track => track.type === type).map(track => <option key={track.id} value={track.id}>{playbackTrackLabel(track)}</option>)}
  </SelectControl>
  const speedSelect = (quick = false): JSX.Element => <SelectControl aria-label={quick ? '快捷倍速' : '倍速'}
    className={quick ? styles.quickSelect : undefined} displayLabel={quick ? `${state.speed}×` : undefined}
    value={state.speed} disabled={disabled} onChange={event => control({ kind: 'speed', value: Number(event.target.value) })}>
    {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map(value => <option key={value} value={value}>{value}×</option>)}
  </SelectControl>
  const volume = volumeDraft ?? state.volume
  const position = seekDraft ?? state.position ?? 0
  const dockedTitle = (videoTitle?.sessionId === state.sessionId && videoTitle.label) || state.title
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
        : await api.playback.open({ ...current.target, resourceId: resourceId ?? current.target.resourceId })
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
        setControlsFocused(Boolean(target.closest?.('[data-playback-overlay-surface]') && !root.current?.contains(target))
          || keyboardChrome.current && target !== root.current && target !== video.current)
      }}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget) && !(event.relatedTarget as HTMLElement | null)?.closest?.('[data-playback-overlay-surface]')) setControlsFocused(false)
      }}>
      {!docked && <header ref={header} className={styles.header} hidden={!headerShown && !rendererFullscreen}
        data-chrome-visible={headerShown} aria-hidden={rendererFullscreen && !headerShown || undefined} data-playback-overlay-surface={rendererFullscreen || undefined}>
        <div className={styles.heading}><span className={styles.title}>{state.title}</span><span className={styles.caption}>{state.source === 'remote' ? '远程原文件' : '本机文件'}</span></div>
        <IconButton icon={<ChevronDown size={18} />} label="收起到底栏" disabled={state.phase === 'error'} onClick={() => transport({ kind: 'presentation', value: 'docked' })} />
        <IconButton icon={<X size={18} />} label="停止播放" onClick={() => transport({ kind: 'stop' })} />
      </header>}
      <div className={styles.middle}>
        {state.phase === 'error' ? <div className={styles.failure}>
          <p className={styles.failureMessage} role="alert">{state.error}</p>
          {state.info.videoCodec && <p className={styles.note}>{state.info.videoCodec} · {state.info.width ?? '?'}×{state.info.height ?? '?'}</p>}
          <div className={styles.adjustment}>
            <Button size="sm" variant="primary" disabled={recoverySession === state.sessionId} onClick={() => void recover(false)}>重试所选资源</Button>
            <Button size="sm" disabled={recoverySession === state.sessionId} onClick={() => void recover(true)}>使用外部播放器打开</Button>
            <Button size="sm" onClick={() => transport({ kind: 'stop' })}>关闭播放器</Button>
          </div>
          <p className={styles.note}>重试会重新检查同一资源，不自动切换资源或播放器。</p>
        </div> : <button ref={video} className={styles.video} tabIndex={0}
          aria-label={docked ? '恢复展开播放器' : options ? '视频画面，关闭播放设置' : '视频画面，单击播放或暂停，双击全屏'}
          onMouseDown={event => { if (options) cancelVideoClick(); else videoMouseDown(event) }}
          onClick={event => {
            if (options) { cancelVideoClick(); presentationHistory.setOptions(false); return }
            const activate = (): void => {
              const current = stateRef.current
              if (!current || current.sessionId !== state.sessionId || current.presentation !== state.presentation || current.phase === 'error') return
              control(current.presentation === 'docked' ? { kind: 'presentation', value: 'expanded' }
                : current.phase === 'ended' ? { kind: 'restart' } : { kind: 'pause', paused: !current.paused })
            }
            videoClick(event?.detail ?? 0, Boolean(sharedTextureSurface && !docked), activate)
          }}
          onDoubleClick={sharedTextureSurface && !docked ? () => {
            transport({ kind: 'presentation', value: fullscreen ? 'expanded' : 'fullscreen' })
          } : undefined}>
          {sharedTextureSurface && <video key={sharedTextureSurface} className={styles.sharedTexture} data-playback-surface={sharedTextureSurface}
              muted playsInline disablePictureInPicture disableRemotePlayback tabIndex={-1} aria-hidden="true" />}
        </button>}
        {options && !docked && state.phase !== 'error' && <aside className={styles.options} aria-label="播放设置" id={settingsId} data-playback-overlay-surface={rendererFullscreen || undefined}>
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
          {state.chapters.length > 0 && <label>章节<SelectControl aria-label="章节" value="none" disabled={seekDisabled} onChange={event => control({ kind: 'seek', seconds: Number(event.target.value) })}>
            <option value="none">跳到章节…</option>{state.chapters.map((chapter, index) => <option key={index} value={chapter.time}>{chapter.title}</option>)}
          </SelectControl></label>}
          </div>
          <div className={styles.optionBody} role="tabpanel" id={`${settingsId}-subtitle`} aria-labelledby={`${settingsId}-subtitle-tab`} hidden={optionTab !== 'subtitle'}>
          <AiSubtitleSettings playback={state} onOpenModels={openSubtitleModels} controller={aiSubtitles} />
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
            {state.info.playbackMode ? <><dt>播放模式</dt><dd>{state.info.playbackMode === 'cpu' ? 'CPU 兼容' : 'GPU'}{state.info.playbackFallback ? '（自动回退）' : ''}</dd></> : null}<dt>实际硬解</dt><dd>{state.info.hardwareDecoder && state.info.hardwareDecoder !== 'no' ? state.info.hardwareDecoder : '软件解码'}{state.info.playbackDiagnostics?.decoderFallback ? '（已从硬解切换）' : ''}</dd><dt>音频</dt><dd>{state.info.audioCodec ?? '无'} / {state.info.audioOutput ?? '无输出'}</dd>
            {state.info.playbackDiagnostics?.displayProbe !== 'not-applicable' && state.info.playbackDiagnostics ? <><dt>画面通道</dt><dd>{state.info.playbackDiagnostics.displayProbe === 'passed' ? '导入与显示检查通过' : '正在检查'}</dd></> : null}
            {state.info.playbackDiagnostics?.fallbackReason ? <><dt>回退原因</dt><dd>{recoveryLabel(state.info.playbackDiagnostics.fallbackReason)}</dd></> : null}
          </dl>
          <section className={styles.shortcuts} aria-label="画面快捷键">
            <h3>画面快捷键</h3>
            <dl>
              <div><dt className={styles.shortcutAction}>播放 / 暂停</dt><dd className={styles.shortcutKeys}><kbd className={styles.shortcutKey}>Space</kbd></dd></div>
              <div><dt className={styles.shortcutAction}>跳转 5 秒</dt><dd className={styles.shortcutKeys}><kbd className={styles.shortcutKey}>←</kbd><span>/</span><kbd className={styles.shortcutKey}>→</kbd></dd></div>
              <div><dt className={styles.shortcutAction}>跳转 30 秒</dt><dd className={styles.shortcutKeys}><kbd className={styles.shortcutKey}>Shift</kbd><span>+</span><kbd className={styles.shortcutKey}>←</kbd><span>/</span><kbd className={styles.shortcutKey}>→</kbd></dd></div>
              <div><dt className={styles.shortcutAction}>音量 ±5%</dt><dd className={styles.shortcutKeys}><kbd className={styles.shortcutKey}>↑</kbd><span>/</span><kbd className={styles.shortcutKey}>↓</kbd></dd></div>
              <div><dt className={styles.shortcutAction}>静音</dt><dd className={styles.shortcutKeys}><kbd className={styles.shortcutKey}>M</kbd></dd></div>
              <div><dt className={styles.shortcutAction}>全屏</dt><dd className={styles.shortcutKeys}><kbd className={styles.shortcutKey}>F</kbd></dd></div>
              <div><dt className={styles.shortcutAction}>返回</dt><dd className={styles.shortcutKeys}><kbd className={styles.shortcutKey}>Esc</kbd></dd></div>
            </dl>
          </section>
          </div>
        </aside>}
      </div>
      {waitingResume && !fullscreen && <div className={styles.resume} role="group" aria-label="选择续播方式">
        <span>上次播放到 {playbackTime(state.resumePosition)}</span>
        <Button size="sm" variant="primary" disabled={disabled || !state.seekable || state.duration != null && state.duration - state.resumePosition! <= 30}
          onClick={() => transport({ kind: 'resume', choice: 'continue' })}>继续 {playbackTime(state.resumePosition)}</Button>
        <Button size="sm" disabled={disabled} onClick={() => transport({ kind: 'resume', choice: 'start' })}>从头播放</Button>
      </div>}
      {state.phase !== 'error' && <div ref={toolbar} className={styles.controls} hidden={!chromeShown && !rendererFullscreen}
        data-chrome-visible={chromeShown} aria-hidden={rendererFullscreen && !chromeShown || undefined} data-playback-overlay-surface={rendererFullscreen || undefined}>
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
          {docked && <Link className={`${styles.title} ${styles.titleLink}`} draggable={false}
            to={mediaLibraryVideoDetailPath(state.target.libraryId, state.target.videoId)}
            title={dockedTitle} aria-label={`查看影片详情：${dockedTitle}`}>{dockedTitle}</Link>}
          <IconButton size="control" tone="accent" icon={state.phase === 'ended' ? <RotateCcw size={18} /> : state.paused ? <Play size={18} /> : <Pause size={18} />}
            label={state.phase === 'ended' ? '从头重播' : state.paused ? '播放' : '暂停'} disabled={disabled || waitingResume}
            onClick={() => transport(state.phase === 'ended' ? { kind: 'restart' } : { kind: 'pause', paused: !state.paused })} />
          {!docked && <><Button size="sm" variant="ghost" className={styles.skip} aria-label="后退 5 秒" disabled={seekDisabled} onClick={() => control({ kind: 'seek', relative: true, seconds: -5 })}><RotateCcw size={16} />5</Button>
            <Button size="sm" variant="ghost" className={styles.skip} aria-label="前进 5 秒" disabled={seekDisabled} onClick={() => control({ kind: 'seek', relative: true, seconds: 5 })}><RotateCw size={16} />5</Button></>}
          <div className={styles.volumeGroup}>
            <IconButton size="control" icon={state.muted ? <VolumeX size={18} /> : <Volume2 size={18} />} label={state.muted ? '取消静音' : '静音'} onClick={() => control({ kind: 'mute', muted: !state.muted })} />
            <input className={`${styles.range} ${styles.volume}`} aria-label="音量" type="range" min={0} max={100} style={rangeFill(volume, 100)} value={volume}
              onPointerDown={() => setAdjusting(true)} onPointerUp={() => {
                setAdjusting(false)
                if (!docked && layer.isTop()) video.current?.focus({ preventScroll: true })
              }} onPointerCancel={() => setAdjusting(false)} onBlur={() => setAdjusting(false)}
              onChange={event => changeVolume(state.sessionId, Number(event.target.value))} aria-valuetext={`${volume}%`} />
            <span className={styles.volumeValue}>{volume}%</span>
          </div>
          {!docked && <><span className={styles.spacer} /><AiSubtitleToggle key={`${state.sessionId}-${state.presentation}`} playback={state} controller={aiSubtitles} onOpenModels={openSubtitleModels} /><span className={styles.separator} /><div className={styles.quickControls}>{speedSelect(true)}</div>
            <span className={styles.separator} /><IconButton ref={settingsToggle} size="control" icon={<SlidersHorizontal size={18} />} label="播放设置" aria-expanded={options} aria-controls={settingsId} aria-pressed={options} onClick={() => presentationHistory.setOptions(!options)} /></>}
          <IconButton size="control" icon={docked ? <PanelTop size={18} /> : fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            label={docked ? '恢复展开' : fullscreen ? '退出全屏' : '全屏'} disabled={waitingResume && !docked}
            onClick={() => transport({ kind: 'presentation', value: docked || fullscreen ? 'expanded' : 'fullscreen' })} />
          {docked && <IconButton size="control" icon={<X size={18} />} label="停止播放" onClick={() => transport({ kind: 'stop' })} />}
          <span className={styles.status} role="status">{status}</span>
        </div>
      </div>}
    </div>
  </InteractionLayerOwner.Provider>
}
