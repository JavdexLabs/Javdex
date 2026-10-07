import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AiSubtitleCommand, AiSubtitleSnapshot } from '@shared/desktop/aiSubtitles'
import type { PlaybackSnapshot } from '@shared/desktop/playback'
import { api } from '../api'
import Button from '../components/Button'
import SelectControl from '../components/SelectControl'
import { playbackTime } from './playbackTime'
import { settingsPath } from '../settings/settingsRoutes'
import styles from './AiSubtitleSettings.module.css'

export default function AiSubtitleSettings({ playback }: { playback: PlaybackSnapshot }): JSX.Element {
  const navigate = useNavigate()
  const [state, setState] = useState<AiSubtitleSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef({ revision: 0, events: 0 })
  useEffect(() => {
    const counter = request.current
    setBusy(false); setError(null)
    let mounted = true, observed = false
    const unsubscribe = api.playback.onAiSubtitleChanged(value => {
      observed = true
      if (mounted) { counter.events++; setState(value) }
    })
    void api.playback.aiSubtitleSnapshot().then(value => { if (mounted && !observed) setState(value) }).catch(() => {
      if (mounted) setError('无法读取离线字幕状态')
    })
    return () => { mounted = false; counter.revision++; unsubscribe() }
  }, [playback.sessionId])
  const enabled = state?.enabled === true && state.sessionId === playback.sessionId
  async function openModels(): Promise<void> {
    const revision = ++request.current.revision
    setBusy(true); setError(null)
    try {
      await api.playback.control(playback.sessionId, { kind: 'presentation', value: 'docked' })
      if (revision === request.current.revision) navigate(settingsPath('models', 'local'))
    } catch { if (revision === request.current.revision) setError('无法打开模型设置，请先收起播放器后打开设置') }
    finally { if (revision === request.current.revision) setBusy(false) }
  }
  const execute = async (command: AiSubtitleCommand): Promise<void> => {
    const revision = ++request.current.revision
    const events = request.current.events
    setBusy(true); setError(null)
    try {
      const value = await api.playback.aiSubtitleCommand(playback.sessionId, command)
      if (revision === request.current.revision && events === request.current.events) setState(value)
    } catch (error) { if (revision === request.current.revision) setError(error instanceof Error ? error.message : '离线字幕操作失败') }
    finally { if (revision === request.current.revision) setBusy(false) }
  }
  const status = !state ? '正在读取状态'
    : !enabled ? state.installed ? '离线模型已就绪' : '请在设置 → AI 模型 → 本地模型下载 Kotoba 和 Qwen3'
      : state.phase === 'preparing' ? '正在准备当前音轨'
        : state.phase === 'recognizing' ? `正在识别 ${playbackTime(state.activeStart ?? 0)} 附近的日语`
          : state.phase === 'translating' ? `正在翻译 ${playbackTime(state.activeStart ?? 0)} 附近的对白`
            : state.phase === 'error' ? '部分字幕未完成，可重试'
              : '已生成字幕可播放'
  return <section className={styles.root} aria-label="离线 AI 日中字幕">
    <div className={styles.heading}>AI 日中字幕</div>
    <p className={styles.note}>Kotoba 识别日语，本机模型翻译中文；音频与字幕文本留在本机。</p>
    <p className={styles.note}>首次生成需要等待，可先暂停预生成；识别与译文可能有误。</p>
    {state?.supported === false ? <p className={styles.note}>当前支持 Windows x64。</p> : <>
      <div className={styles.actions}>
        <Button size="sm" disabled={busy} onClick={() => void openModels()}>管理本地模型</Button>
        {state?.installed && <Button size="sm" variant={enabled ? 'default' : 'primary'}
          disabled={!enabled && (busy || !playback.seekable || playback.duration == null || playback.phase === 'error')}
          onClick={() => void execute({ action: enabled ? 'stop' : 'start' })}>{enabled ? '停止 AI 字幕' : '开启 AI 字幕'}</Button>}
        {enabled && state?.error && <Button size="sm" disabled={busy} onClick={() => void execute({ action: 'retry' })}>重试未完成字幕</Button>}
      </div>
      <p className={styles.status} role="status" aria-live="polite">{status}</p>
      {enabled && <p className={styles.note}>已识别 {playbackTime(state?.recognizedSeconds ?? 0)} · 已翻译 {playbackTime(state?.translatedSeconds ?? 0)} / {playbackTime(playback.duration ?? 0)}</p>}
      {state?.installed && <>
        <label className={styles.field}>AI 字幕显示<SelectControl value={state.display} aria-label="AI 字幕显示" disabled={busy}
          onChange={event => void execute({ action: 'display', value: event.target.value as AiSubtitleSnapshot['display'] })}>
          <option value="bilingual">中日双语</option><option value="chinese">仅中文</option><option value="japanese">仅日语</option>
        </SelectControl></label>
        <label className={styles.field}>AI 字幕字号<SelectControl value={state.fontSize} aria-label="AI 字幕字号" disabled={busy}
          onChange={event => void execute({ action: 'font-size', value: Number(event.target.value) })}>
          {[28, 34, 42, 50, 60].map(size => <option key={size} value={size}>{size}</option>)}
        </SelectControl></label>
        <div className={styles.actions}>
          <Button size="sm" disabled={busy || !enabled || !state.recognizedSeconds} onClick={() => void execute({ action: 'export' })}>导出已生成字幕</Button>
          <Button size="sm" disabled={busy || !enabled} onClick={() => void execute({ action: 'clear-cache' })}>清除本片缓存</Button>
        </div>
        <p className={styles.note}>跳转后优先生成新位置，未译完时先显示日语；停止 AI 字幕后恢复此前字幕。</p>
      </>}
    </>}
    {(error || state?.error) && <p className={styles.error} role="alert">{error || state?.error}</p>}
  </section>
}
