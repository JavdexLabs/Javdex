import { useEffect, useRef, useState } from 'react'
import type { LocalModelCommand, LocalModelId, LocalModelSnapshot, LocalTranslationMode, LocalTranslationModelId } from '@shared/desktop/localModels'
import { api } from '../../api'
import Button from '../Button'
import SelectControl from '../SelectControl'
import styles from './LocalModelsPanel.module.css'

export default function LocalModelsPanel(): JSX.Element {
  const [state, setState] = useState<LocalModelSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [browsing, setBrowsing] = useState<Partial<Record<LocalModelId, string>>>({})
  const [installedOnly, setInstalledOnly] = useState(false)
  const lifetime = useRef({ mounted: false, events: 0, request: 0, requestBusy: false })
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
    if (busy || lifetime.current.requestBusy) return
    lifetime.current.requestBusy = true
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
    } finally {
      counter.requestBusy = false
      if (counter.mounted && request === counter.request) setBusy(false)
    }
  }
  if (!state) return <p role="status">{feedback || '正在读取本地模型…'}</p>
  const working = busy || state.operation !== null
  const anyInUse = state.models.some(model => model.inUse)
  const localTranslator = state.models.find(model => model.id === state.translationModel)!
  const translatorInUse = state.models.some(model => model.id !== 'kotoba' && model.inUse)
  const summary = state.operation === 'download' ? `${state.downloadLabel ?? '模型'} · ${Math.floor(state.downloadBytes / 1048576)} / ${Math.ceil(state.downloadTotal / 1048576)} MB`
    : state.operation === 'relocate' ? '正在迁移并校验模型，原位置在完成前保持有效'
      : state.operation === 'export' ? '正在复制并校验导出模型'
        : state.operation === 'delete' ? '正在删除模型' : feedback || state.error || (state.supported
          ? '模型保存在此电脑，安装后可离线使用' : '模型文件保存在此电脑；此平台暂不支持本地推理')
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
        <option value="local" disabled={!state.supported || !localTranslator.installed}>本地 {localTranslator.name}{!state.supported ? '（此平台暂不支持运行）' : !localTranslator.installed ? '（未安装）' : ''}</option>
      </SelectControl></label>
      <label className={styles.field}>本地翻译模型<SelectControl aria-label="本地翻译模型" value={state.translationModel} disabled={working || translatorInUse}
        onChange={event => void execute({ action: 'translation-model', model: event.target.value as LocalTranslationModelId })}>
        {state.models.filter(model => model.id !== 'kotoba').map(model => <option key={model.id} value={model.id} disabled={!model.installed}>
          {model.name}{!model.installed ? '（当前精度未安装）' : ''}
        </option>)}
      </SelectControl></label>
      <p className={styles.note}>先在商店下载并选择精度，再选择本地翻译模型。AI 字幕始终使用此本地模型；文本翻译仅在来源选择本地时使用它，从下一次调用生效，不改变应用默认或 Agent 用途配置。本地模式不上传文本，不可用会报错，不自动回退。</p>
    </section>
    <section className={styles.card} aria-label="本地模型商店">
      <div className={styles.catalogHeading}>
        <h3 className={styles.title}>模型商店</h3>
        <SelectControl aria-label="模型商店范围" value={installedOnly ? 'installed' : 'all'}
          onChange={event => setInstalledOnly(event.target.value === 'installed')}>
          <option value="all">全部精度</option><option value="installed">已下载精度</option>
        </SelectControl>
      </div>
      {!state.supported && <p className={styles.note}>此平台可以下载、管理和导出模型文件。本地推理支持 Windows x64、macOS 13.3+ arm64／x64 和 Linux arm64／x64（glibc 2.38+、GCC 14 C++ 运行库，例如已更新的 Ubuntu 24.04），下载不代表能在其他平台运行。</p>}
      {state.models.map(model => {
        const variants = model.variants.filter(variant => !installedOnly || variant.installed)
        if (!variants.length) return null
        const variant = variants.find(item => item.id === (browsing[model.id] ?? model.selectedVariant)) ?? variants[0]
        const current = model.variants.find(item => item.id === model.selectedVariant)!
        return <article className={styles.model} key={model.id} aria-label={`${model.name} 模型精度`}>
          <div className={styles.modelHeader}><strong className={styles.modelName}>{model.name}</strong>
            <span>{model.inUse ? '使用中' : `已下载 ${model.variants.filter(item => item.installed).length} / ${model.variants.length} 个精度版本`}</span></div>
          <p className={styles.note}>{model.version} · {model.purpose}</p>
          <p className={styles.note}>当前选择：{current.precision} · {current.publisher}{!model.installed ? '（未安装）' : ''}</p>
          <label className={styles.field}>查看精度<SelectControl aria-label={`${model.name} 查看精度`} value={variant.id}
            disabled={working} onChange={event => setBrowsing(value => ({ ...value, [model.id]: event.target.value }))}>
            {variants.map(item => <option value={item.id} key={item.id}>
              {item.precision} · {item.publisher} · {(item.bytes / 1e9).toFixed(2)} GB{item.recommended ? ' · 推荐' : ''}{item.installed ? ' · 已下载' : ''}
            </option>)}
          </SelectControl></label>
          <p className={styles.note}>{variant.format} · {(variant.bytes / 1e9).toFixed(2)} GB · {variant.installed ? '已下载' : '未下载'}
            {variant.id === model.selectedVariant ? ' · 当前选择' : ''}</p>
          <details className={styles.details}><summary className={styles.detailsToggle}>来源与适用范围</summary>
            <p className={styles.path}>{variant.source}</p>
            <p className={styles.note}>固定仓库版本与 SHA-256 校验；只列实际发布的精度。更低精度占用较小，但效果和速度需按本机验证；BF16 等较大模型需要更多内存。</p>
            {model.id === 'kotoba' && <p className={styles.note}>这里提供 v2.0 GGML 基础识别权重。Kotoba 2.2 的角色区分及标点增强还需要独立后处理依赖，单独下载这些权重不代表已具备完整 2.2 能力。</p>}
            {model.id === 'hy-mt2-7b' && <p className={styles.note}>腾讯官方 HY-MT2 7B 普通 GGUF，Apache-2.0。提供 Q4_K_M、Q6_K、Q8_0，不包含特殊低比特版本。文件大小不是运行内存需求；速度和翻译效果需要按本机验证。</p>}
            {model.id === 'index-translate-9b' && <p className={styles.note}>B站官方 Index-Translate 9B，提供全部 12 档纯文本 GGUF 精度，不包含视觉附件或语音模型。上游声明 Apache-2.0，许可正文来自官方项目。文件大小不是运行内存需求；速度和日中翻译效果需要按本机验证。</p>}
          </details>
          <div className={styles.actions}>
            <Button size="sm" variant={variant.installed ? 'default' : 'primary'} disabled={working || model.inUse || (model.id !== 'kotoba' && translatorInUse)}
              onClick={() => void execute({ action: 'download', model: model.id, variant: variant.id })}>{variant.installed ? '校验与修复' : '下载模型'}</Button>
            <Button size="sm" disabled={working || model.inUse || !variant.installed || variant.id === model.selectedVariant}
              onClick={() => void execute({ action: 'select', model: model.id, variant: variant.id })}>使用此精度</Button>
            <Button size="sm" disabled={working || !variant.installed} onClick={() => void execute({ action: 'export', model: model.id, variant: variant.id })}>导出模型</Button>
            <Button size="sm" variant="danger" disabled={working || model.inUse} onClick={() => void execute({ action: 'delete', model: model.id, variant: variant.id })}>删除此精度</Button>
          </div>
        </article>
      })}
      {installedOnly && !state.models.some(model => model.variants.some(variant => variant.installed)) && <p className={styles.note}>尚未下载模型精度，请切换到“全部精度”下载。</p>}
      <p className={styles.note}>支持的平台会同时安装对应运行库；macOS 13.3+ 的识别与音频工具随应用提供，翻译运行库按需下载。Linux 需要 glibc 2.38+、GCC 14 C++ 运行库和 xz-utils（例如已更新的 Ubuntu 24.04）；其他系统只下载模型文件。取消后可续传；下载不会自动切换模型或精度。选择“使用此精度”只改变该模型的精度；启用其他翻译模型还需修改上方“本地翻译模型”。导出含来源、精度和许可，不含影片、字幕缓存或运行库。</p>
    </section>
    <div className={styles.feedback} role={feedback || state.error ? 'alert' : 'status'} aria-live="polite">
      <span className={styles.summary}>{summary}</span>
      {state.operation === 'download' && <Button size="sm" disabled={busy} onClick={() => void execute({ action: 'cancel-download' })}>取消下载</Button>}
      {state.operation === 'download' && <progress className={styles.progress} max={state.downloadTotal || 1} value={state.downloadBytes} aria-label="本地模型下载进度" />}
    </div>
  </div>
}
