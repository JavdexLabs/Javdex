import { useEffect, useRef, useState } from 'react'
import type { LocalModelCommand, LocalModelSnapshot, LocalTranslationMode } from '@shared/desktop/localModels'
import { api } from '../../api'
import Button from '../Button'
import SelectControl from '../SelectControl'
import styles from './LocalModelsPanel.module.css'

export default function LocalModelsPanel(): JSX.Element {
  const [state, setState] = useState<LocalModelSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const lifetime = useRef({ mounted: false, events: 0, request: 0 })
  useEffect(() => {
    const counter = lifetime.current; counter.mounted = true
    const initial = counter.events
    const unsubscribe = api.settings.onLocalModelsChanged(value => { counter.events++; if (counter.mounted) setState(value) })
    void api.settings.getLocalModels().then(value => { if (counter.mounted && initial === counter.events) setState(value) })
      .catch(() => { if (counter.mounted) setFeedback('本地模型状态读取失败，请重新打开此页') })
    return () => { counter.mounted = false; counter.request++; unsubscribe() }
  }, [])
  async function execute(command: LocalModelCommand): Promise<void> {
    const counter = lifetime.current
    if (busy) return
    const request = ++counter.request, events = counter.events
    setBusy(true); setFeedback('')
    try {
      const value = await api.settings.localModelCommand(command)
      if (counter.mounted && request === counter.request) {
        if (events === counter.events) setState(value)
        setFeedback(command.action === 'export' ? '导出操作已结束' : '')
      }
    } catch (cause) {
      if (counter.mounted && request === counter.request) setFeedback(cause instanceof Error ? cause.message : '本地模型操作失败')
    } finally { if (counter.mounted && request === counter.request) setBusy(false) }
  }
  if (!state) return <p role="status">{feedback || '正在读取本地模型…'}</p>
  const working = busy || state.operation !== null
  const anyInUse = state.models.some(model => model.inUse)
  const summary = state.operation === 'download' ? `${state.downloadLabel ?? '模型'} · ${Math.floor(state.downloadBytes / 1048576)} / ${Math.ceil(state.downloadTotal / 1048576)} MB`
    : state.operation === 'relocate' ? '正在迁移并校验模型，原位置在完成前保持有效'
      : state.operation === 'export' ? '正在复制并校验导出模型'
        : state.operation === 'delete' ? '正在删除模型' : feedback || state.error || '模型保存在此电脑，安装后可离线使用'
  return <div className={styles.root}>
    <section className={styles.card} aria-label="本地模型保存位置">
      <h3 className={styles.title}>保存位置</h3>
      <p className={styles.path}>{state.directory}</p>
      <div className={styles.actions}>
        <Button size="sm" disabled={working || anyInUse} onClick={() => void execute({ action: 'choose-location' })}>更改并迁移</Button>
        <Button size="sm" disabled={working || anyInUse || state.directory === state.defaultDirectory}
          onClick={() => void execute({ action: 'reset-location' })}>恢复默认位置</Button>
      </div>
      <p className={styles.note}>选择新目录后复制并校验现有模型，完成后切换保存位置并清理旧副本。模型使用中请先停止 AI 字幕或等待文本翻译完成。</p>
    </section>
    <section className={styles.card} aria-label="AI 文本翻译模型">
      <h3 className={styles.title}>AI 文本翻译</h3>
      <label className={styles.field}>模型来源<SelectControl aria-label="AI 文本翻译模型来源" value={state.translation} disabled={working}
        onChange={event => void execute({ action: 'translation', mode: event.target.value as LocalTranslationMode })}>
        <option value="app-default">应用默认模型</option>
        <option value="local" disabled={!state.models.find(model => model.id === 'qwen3')?.installed}>本地 Qwen3{!state.models.find(model => model.id === 'qwen3')?.installed ? '（未安装）' : ''}</option>
      </SelectControl></label>
      <p className={styles.note}>选择后立即生效，标题、简介等 AI 翻译从下一次调用使用此选择。本地模式不上传文本；模型不可用会报错。AI 字幕始终使用本地模型。</p>
    </section>
    <section className={styles.card} aria-label="本地模型列表">
      <h3 className={styles.title}>模型文件</h3>
      {!state.supported && <p className={styles.note}>内置离线运行库当前支持 Windows x64。</p>}
      {state.models.map(model => <div className={styles.model} key={model.id}>
        <div className={styles.modelHeader}><strong className={styles.modelName}>{model.name}</strong><span>{model.inUse ? '使用中' : model.installed ? '已安装' : '未安装'}</span></div>
        <p className={styles.note}>{model.purpose} · {(model.bytes / 1e9).toFixed(2)} GB</p>
        <div className={styles.actions}>
          <Button size="sm" variant={model.installed ? 'default' : 'primary'} disabled={!state.supported || working || model.inUse}
            onClick={() => void execute({ action: 'download', model: model.id })}>{model.installed ? '校验与修复' : '下载模型'}</Button>
          <Button size="sm" disabled={working || !model.installed} onClick={() => void execute({ action: 'export', model: model.id })}>导出模型</Button>
          <Button size="sm" disabled={working || model.inUse} onClick={() => void execute({ action: 'delete', model: model.id })}>删除模型</Button>
        </div>
      </div>)}
      <p className={styles.note}>下载会包含该模型所需的运行库；取消后可继续下载。导出包含模型文件、来源和许可，不包含影片、字幕缓存或运行库。</p>
    </section>
    <div className={styles.feedback} role={feedback || state.error ? 'alert' : 'status'} aria-live="polite">
      <span className={styles.summary}>{summary}</span>
      {state.operation === 'download' && <Button size="sm" disabled={busy} onClick={() => void execute({ action: 'cancel-download' })}>取消下载</Button>}
      {state.operation === 'download' && <progress className={styles.progress} max={state.downloadTotal || 1} value={state.downloadBytes} aria-label="本地模型下载进度" />}
    </div>
  </div>
}
