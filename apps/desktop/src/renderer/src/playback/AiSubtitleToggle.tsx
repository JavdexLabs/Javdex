import { useEffect, useId, useRef, useState } from 'react'
import { Check, Circle, X } from 'lucide-react'
import type { PlaybackSnapshot } from '@shared/desktop/playback'
import Button from '../components/Button'
import IconButton from '../components/IconButton'
import Switch from '../components/Switch'
import { useLocalModels } from '../components/settings/useLocalModels'
import { InteractionLayerOwner, useInteractionLayer } from '../interaction/useInteractionLayer'
import type { AiSubtitleController } from './useAiSubtitles'
import { playbackTime } from './playbackTime'
import styles from './AiSubtitleToggle.module.css'

export default function AiSubtitleToggle({ playback, controller, onOpenModels }: {
  playback: PlaybackSnapshot
  controller: AiSubtitleController
  onOpenModels: (sessionId: string) => Promise<void>
}): JSX.Element {
  const { state, enabled, busy, pending, error, execute } = controller
  const { state: models } = useLocalModels()
  const [open, setOpen] = useState(false)
  const [navigating, setNavigating] = useState(false)
  const [navigationError, setNavigationError] = useState<string | null>(null)
  const anchor = useRef<HTMLLabelElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const id = useId()
  const layer = useInteractionLayer({ enabled: open, rootRef: panel, anchorRef: anchor, onDismiss: () => setOpen(false) })
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const outside = (event: MouseEvent): void => {
      if (layer.isTop() && !layer.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', outside)
    return () => window.removeEventListener('mousedown', outside)
  }, [open, layer])
  const feedback = navigationError || error || state?.error
  const unsupported = state?.supported === false
  const missingFiles = !state?.installed && Boolean(models?.models.length) && !models?.configurationError
  const title = feedback ? 'AI 字幕暂不可用' : unsupported ? '当前环境暂不支持 AI 字幕'
    : missingFiles ? '字幕模型尚未就绪' : '先配置字幕模型'
  const description = feedback || (unsupported ? '请在模型设置中查看可用的运行环境。'
    : missingFiles ? '请在字幕模型设置中下载所选模型及所需文件。' : '选择日语识别和中文翻译模型，并下载所需文件。')
  const canStart = playback.seekable && playback.duration != null && playback.phase !== 'opening' && playback.phase !== 'error'
  const disabled = pending === 'stop' || !enabled && (busy || !state && !error || state?.installed && !canStart)
  const positionText = (value: number | null | undefined): string => value == null
    ? pending === 'start' || state?.phase === 'preparing' ? '准备中' : '等待处理'
    : playbackTime(value)
  const positions = [
    { label: '识别至', value: state?.enabled ? state.recognizedUntil : null, complete: Boolean(state?.duration && state.recognizedSeconds >= state.duration), className: styles.recognition },
    { label: '翻译至', value: state?.enabled ? state.translatedUntil : null, complete: Boolean(state?.duration && state.translatedSeconds >= state.duration), className: styles.translation }
  ]
  async function openModels(): Promise<void> {
    if (navigating) return
    setNavigating(true); setNavigationError(null)
    try { await onOpenModels(playback.sessionId) }
    catch { if (mounted.current) setNavigationError('无法打开模型设置，请先收起播放器后打开设置') }
    finally { if (mounted.current) setNavigating(false) }
  }
  async function toggle(): Promise<void> {
    if (disabled) return
    if (!enabled && (!state?.installed || unsupported)) { setOpen(value => !value); return }
    setOpen(false)
    const succeeded = await execute({ action: enabled ? 'stop' : 'start' })
    if (!succeeded && mounted.current) setOpen(true)
  }
  return <div className={styles.root}>
    <div className={styles.card} data-enabled={enabled}>
      <div className={styles.progress} aria-hidden={!enabled}>
        {enabled && <div id={`${id}-position`} className={styles.positions} role="group" aria-label="AI 字幕处理位置">
          {positions.map(position => <div key={position.label} className={styles.position}>
            <span className={styles.mark} aria-hidden="true">{position.complete ? <Check size={12} className={position.className} />
              : <Circle size={6} fill="currentColor" className={position.className} />}</span>
            <span className={styles.positionLabel}>{position.label}</span>
            <span className={styles.time}>{positionText(position.value)}</span>
          </div>)}
        </div>}
      </div>
      <label ref={anchor} className={styles.toggle} title={enabled ? '停止 AI 字幕并恢复此前字幕' : state?.installed && !canStart ? '当前影片暂不能生成 AI 字幕' : 'AI 日中字幕'}>
        <span>AI 字幕</span>
        <Switch checked={enabled} disabled={Boolean(disabled)} aria-label="AI 字幕"
          aria-expanded={open} aria-controls={open ? id : undefined}
          aria-describedby={open ? `${id}-description` : enabled ? `${id}-position` : undefined}
          onChange={() => void toggle()} />
      </label>
    </div>
    {open && <InteractionLayerOwner.Provider value={layer.owner}>
      <div ref={panel} id={id} role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
        tabIndex={-1} className={styles.guide} style={layer.style} data-native-playback-occluder>
        <div className={styles.heading}>
          <h3 id={`${id}-title`}>{title}</h3>
          <IconButton size="sm" icon={<X size={16} />} label="关闭 AI 字幕引导" onClick={() => setOpen(false)} />
        </div>
        <p id={`${id}-description`} className={styles.description} role={feedback ? 'alert' : undefined}>{description}</p>
        <p className={styles.note}>音频和字幕留在本机</p>
        <div className={styles.actions}>
          <Button size="sm" onClick={() => setOpen(false)}>暂不</Button>
          <Button size="sm" variant="primary" disabled={navigating} onClick={() => void openModels()}>前往配置</Button>
        </div>
      </div>
    </InteractionLayerOwner.Provider>}
  </div>
}
