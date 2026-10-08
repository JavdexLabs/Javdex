import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { LocalModelId, LocalModelRef, LocalModelSnapshot, LocalModelUsage, LocalTranslationModelId } from '@shared/desktop/localModels'
import Button from '../Button'
import SelectControl from '../SelectControl'
import SettingsFormActions from './SettingsFormActions'
import SettingsFeedback from './SettingsFeedback'
import { useLocalModels } from './useLocalModels'
import { useSettingsDraft } from '../../settings/useSettingsDraft'
import { useSettingsFormGuard } from '../../settings/SettingsLeaveGuard'
import { preservesModelUsageDraft, settingsPath } from '../../settings/settingsRoutes'
import styles from './ModelUsagePanel.module.css'

function ModelBinding({ title, state, value, models, disabled, inline = false, onChange }: {
  title: string
  state: LocalModelSnapshot
  value: LocalModelRef
  models: LocalModelId[]
  disabled: boolean
  inline?: boolean
  onChange: (value: LocalModelRef) => void
}): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const family = state.models.find(model => model.id === value.model)
  const variant = family?.variants.find(item => item.id === value.variant)
  const status = !variant?.installed ? '未下载' : variant.readiness === 'unsupported' ? '当前平台不支持运行'
    : variant.ready ? '已就绪' : '运行依赖待修复'
  const openFiles = (): void => {
    const query = new URLSearchParams(location.search)
    query.set('model', value.model); query.set('variant', value.variant)
    navigate({ pathname: settingsPath('models', 'local'), search: `?${query}`, hash: '' })
  }
  return <div className={inline ? styles.inlineBinding : styles.binding}>
    <label className={styles.field}>
      <span>{title}</span>
      <SelectControl aria-label={`${title}模型`} value={value.model} disabled={disabled} onChange={event => {
        const model = state.models.find(item => item.id === event.target.value)!
        onChange({ model: model.id, variant: model.variants.find(item => item.recommended)?.id ?? model.selectedVariant })
      }}>
        {state.models.filter(model => models.includes(model.id)).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </SelectControl>
    </label>
    <label className={styles.field}>
      <span>精度与发布者</span>
      <SelectControl aria-label={`${title}精度与发布者`} value={value.variant} disabled={disabled} onChange={event => onChange({ ...value, variant: event.target.value })}>
        {family?.variants.map(item => <option key={item.id} value={item.id}>
          {item.precision} · {item.publisher}{!item.installed ? ' · 未下载' : !item.ready ? ' · 待修复' : ''}
        </option>)}
      </SelectControl>
    </label>
    <div className={`${styles.bindingStatus} ${inline ? styles.inlineBindingStatus : ''}`} role="status">
      <span className={styles.bindingStatusLabel} data-ready={variant?.ready === true}>{status}</span>
      <Button size="sm" disabled={disabled} onClick={openFiles}>{variant?.installed ? '管理文件' : '前往下载'}</Button>
    </div>
  </div>
}

function SubtitleUsage({ state, busy, execute, operationError }: {
  state: LocalModelSnapshot
  busy: boolean
  execute: ReturnType<typeof useLocalModels>['execute']
  operationError: string | null
}): JSX.Element {
  const form = useSettingsDraft({ subtitleRecognition: state.usage.subtitleRecognition, subtitleTranslation: state.usage.subtitleTranslation })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<boolean> => {
    setSaving(true); setError(null)
    try {
      const ok = await execute({ action: 'usage', expectedRevision: state.revision, usage: { ...state.usage, ...form.draft } })
      if (ok) form.accept(form.draft)
      else setError('字幕模型未保存，请检查模型状态后重试。')
      return ok
    } finally { setSaving(false) }
  }
  useSettingsFormGuard({ label: 'AI 字幕模型', dirty: form.dirty, busy: saving, save,
    discard: form.reset, preserveOnNavigate: preservesModelUsageDraft })
  return <section id="ai-subtitles" className={styles.assignmentCard}>
    <header className={styles.cardHeader}>
      <div><h3 className={styles.sectionTitle}>AI 字幕</h3><p className={styles.sectionHint}>日语识别 → 中文翻译 · 两个阶段均在本机运行，保存后用于新任务。</p></div>
      <SettingsFormActions placement="header" dirty={form.dirty} saving={saving} disabled={busy}
        conflict={form.conflict} error={error ? operationError ?? error : null} onSave={() => void save()} onCancel={() => { form.reset(); setError(null) }} />
    </header>
    <div className={styles.gridTwo}>
      <ModelBinding title="语音识别" state={state} models={['kotoba']} value={form.draft.subtitleRecognition}
        disabled={saving} onChange={value => form.setDraft(current => ({ ...current, subtitleRecognition: { ...value, model: 'kotoba' } }))} />
      <ModelBinding title="字幕翻译" state={state} models={['qwen3', 'hy-mt2-7b', 'index-translate-9b']} value={form.draft.subtitleTranslation}
        disabled={saving} onChange={value => form.setDraft(current => ({ ...current, subtitleTranslation: { ...value, model: value.model as LocalTranslationModelId } }))} />
    </div>
  </section>
}

function TextUsage({ state, busy, execute, operationError }: {
  state: LocalModelSnapshot
  busy: boolean
  execute: ReturnType<typeof useLocalModels>['execute']
  operationError: string | null
}): JSX.Element {
  const form = useSettingsDraft(state.usage.textTranslation)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const local = form.draft.mode === 'local'
  const save = async (): Promise<boolean> => {
    setSaving(true); setError(null)
    try {
      const usage: LocalModelUsage = { ...state.usage, textTranslation: form.draft }
      const ok = await execute({ action: 'usage', expectedRevision: state.revision, usage })
      if (ok) form.accept(form.draft)
      else setError('文本翻译模型未保存，请检查模型状态后重试。')
      return ok
    } finally { setSaving(false) }
  }
  useSettingsFormGuard({ label: '文本翻译模型', dirty: form.dirty, busy: saving, save,
    discard: form.reset, preserveOnNavigate: preservesModelUsageDraft })
  return <section className={styles.assignmentCard}>
    <header className={styles.cardHeader}>
      <div><h3 className={styles.sectionTitle}>文本翻译</h3><p className={styles.sectionHint}>影片标题与简介翻译；与字幕翻译分别设置。</p></div>
      <SettingsFormActions placement="header" dirty={form.dirty} saving={saving} disabled={busy}
        conflict={form.conflict} error={error ? operationError ?? error : null} onSave={() => void save()} onCancel={() => { form.reset(); setError(null) }} />
    </header>
    <div className={styles.textBinding}>
    <label className={styles.field}>
      <span>模型来源</span>
      <SelectControl aria-label="文本翻译模型来源" value={form.draft.mode} disabled={saving} onChange={event => form.setDraft(current => ({ ...current, mode: event.target.value as typeof current.mode }))}>
        <option value="app-default">继承应用默认模型</option><option value="local">使用本地模型</option>
      </SelectControl>
    </label>
      <ModelBinding title="本地文本" inline state={state} models={['qwen3', 'hy-mt2-7b', 'index-translate-9b']}
        value={form.draft} disabled={!local || saving} onChange={value => form.setDraft(current => ({ ...current, ...value, model: value.model as LocalTranslationModelId }))} />
    </div>
  </section>
}

export default function LocalModelUsagePanel(): JSX.Element {
  const { state, busy, execute, error } = useLocalModels()
  const location = useLocation()
  const anchor = useRef<HTMLDivElement>(null)
  const loaded = state !== null
  useEffect(() => {
    if (loaded && location.pathname === settingsPath('models', 'usage') && location.hash === '#ai-subtitles') {
      anchor.current?.querySelector('#ai-subtitles')?.scrollIntoView?.({ block: 'start' })
    }
  }, [location.pathname, location.hash, loaded])
  return <div className={styles.stack} ref={anchor}>
    {state?.configurationError ? <section className={styles.assignmentCard}>
      <header className={styles.cardHeader}>
        <div><h3 className={styles.sectionTitle}>用途配置需要修复</h3><p className={styles.sectionHint}>暂用推荐模型与精度。恢复后可重新选择，已下载文件和保存位置保留。</p></div>
        <Button size="sm" busy={busy} disabled={busy || state.operation !== null} onClick={() => void execute({
          action: 'usage', expectedRevision: state.revision, usage: state.usage
        })}>恢复用途配置</Button>
      </header>
      <SettingsFeedback error message="模型用途配置无法读取" detail={error ?? state.configurationError} />
    </section> : null}
    {state ? <><SubtitleUsage state={state} busy={busy || state.operation !== null} execute={execute} operationError={error} /><TextUsage state={state} busy={busy || state.operation !== null} execute={execute} operationError={error} /></>
      : <section className={styles.assignmentCard} role="status">{error ?? '正在读取本地模型用途配置…'}</section>}
  </div>
}
