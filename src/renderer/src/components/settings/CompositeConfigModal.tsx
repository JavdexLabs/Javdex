import { useMemo, useRef, useState } from 'react'
import {
  ACTRESS_SCRAPE_FIELD_OPTIONS,
  VIDEO_SCRAPE_FIELD_OPTIONS,
  type CompositeScraperInput,
  type ScraperPluginDescriptor
} from '@shared/scrapeTypes'
import Modal from '../Modal'
import Button from '../Button'
import SelectControl from '../SelectControl'
import { useSettingsFormGuard } from '../../settings/SettingsLeaveGuard'
import type { CompositeEditState, PluginKind } from './PluginConfigModals'
import styles from './CompositeConfigModal.module.css'

export default function CompositeConfigModal({
  state,
  plugins,
  saving = false,
  onSave,
  onCancel
}: {
  state: CompositeEditState
  plugins: ScraperPluginDescriptor[]
  saving?: boolean
  onSave: (kind: PluginKind, originalName: string | null, input: CompositeScraperInput) => void
  onCancel: () => void
}): JSX.Element {
  const { kind, plugin } = state
  const fields = kind === 'video' ? VIDEO_SCRAPE_FIELD_OPTIONS : ACTRESS_SCRAPE_FIELD_OPTIONS
  const sources = plugins.filter((item) => item.kind === kind && item.source !== 'composite')
  const readySources = sources.filter(
    (item) =>
      item.configured !== false && fields.some((field) => item.supportedFields.includes(field.id))
  )
  const initial = useRef({
    name: plugin?.name ?? '',
    description: plugin?.description ?? '',
    fieldPluginMap: { ...plugin?.fieldPluginMap } as Record<string, string>
  }).current
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  const [mapping, setMapping] = useState(initial.fieldPluginMap)
  const [baseSource, setBaseSource] = useState(
    () =>
      [...readySources].sort((a, b) => b.supportedFields.length - a.supportedFields.length)[0]
        ?.name ?? ''
  )
  const [undo, setUndo] = useState<Record<string, string> | null>(null)
  const [notice, setNotice] = useState('')
  const selected = readySources.find((source) => source.name === baseSource)
  const supported = fields.filter((field) => selected?.supportedFields.includes(field.id))
  const assigned = fields.filter((field) => Boolean(mapping[field.id]))
  const invalid = assigned.filter(
    (field) =>
      !readySources.some(
        (source) => source.name === mapping[field.id] && source.supportedFields.includes(field.id)
      )
  )
  const duplicate = plugins.some(
    (item) => item.kind === kind && item.name === name.trim() && item.name !== plugin?.name
  )
  const dirty = useMemo(
    () =>
      name !== initial.name ||
      description !== initial.description ||
      fields.some(
        (field) => (mapping[field.id] ?? '') !== (initial.fieldPluginMap[field.id] ?? '')
      ),
    [name, description, fields, mapping, initial]
  )
  const requestLeave = useSettingsFormGuard({
    label: '组合插件',
    dirty,
    busy: saving,
    discard: () => {}
  })
  const problem = duplicate
    ? '名称已被使用，请换一个名称。'
    : invalid.length
      ? `请调整不可用来源：${invalid.map((field) => field.label).join('、')}。`
      : null
  const canSave = dirty && Boolean(name.trim()) && assigned.length > 0 && !problem && !saving
  const applySource = (): void => {
    if (!selected || saving) return
    setUndo({ ...mapping })
    setMapping((current) => ({
      ...current,
      ...Object.fromEntries(supported.map((field) => [field.id, selected.name]))
    }))
    setNotice(`已将 ${supported.length} 个字段设为 ${selected.name}，其余字段保持不变。`)
  }
  const save = (): void => {
    if (!canSave) return
    onSave(kind, plugin?.name ?? null, {
      name: name.trim(),
      description: description.trim(),
      fieldPluginMap: Object.fromEntries(assigned.map((field) => [field.id, mapping[field.id]]))
    })
  }
  return (
    <Modal
      title={
        plugin
          ? `编辑组合插件：${plugin.name}`
          : `创建${kind === 'video' ? '影片' : '演员'}组合插件`
      }
      hint="将不同插件擅长的字段组合使用。每个字段固定使用一个来源，未分配的字段跳过。"
      size="lg"
      bodyClassName={styles.body}
      busy={saving}
      onCancel={() => requestLeave(onCancel)}
      onConfirm={save}
      actions={
        <>
          <span className={styles.footerHint}>
            {saving
              ? '正在保存…'
              : !name.trim()
                ? '填写名称，并至少分配一个字段'
                : assigned.length === 0
                  ? '至少为一个字段选择来源'
                  : '保存后可在刮削时选用此组合'}
          </span>
          <Button disabled={saving} onClick={() => requestLeave(onCancel)}>
            取消
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={save}>
            {saving ? '保存中…' : plugin ? '保存更改' : '创建组合'}
          </Button>
        </>
      }
    >
      <div className={styles.identity}>
        <label className={styles.field}>
          <span>组合名称</span>
          <input
            className="text-input"
            value={name}
            disabled={saving}
            placeholder={kind === 'video' ? '例如：影片信息与封面' : '例如：演员资料与头像'}
            aria-invalid={duplicate || undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>
            说明 <small>可选</small>
          </span>
          <input
            className="text-input"
            value={description}
            disabled={saving}
            placeholder="记录这个组合的用途"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </div>
      <section className={styles.quickStart} aria-label="批量设置来源">
        <h4>1. 先应用一个插件</h4>
        <div className={styles.applyRow}>
          <SelectControl
            aria-label="起始插件"
            value={baseSource}
            disabled={saving || readySources.length === 0}
            onChange={(event) => setBaseSource(event.target.value)}
          >
            {!selected ? <option value={baseSource}>请选择可用插件</option> : null}
            {sources.map((source) => (
              <option
                key={source.name}
                value={source.name}
                disabled={!readySources.includes(source)}
              >
                {source.name}
                {source.configured === false
                  ? '（待配置）'
                  : `（支持 ${fields.filter((field) => source.supportedFields.includes(field.id)).length} 个字段）`}
              </option>
            ))}
          </SelectControl>
          <Button size="sm" disabled={!selected || saving} onClick={applySource}>
            应用到支持字段
          </Button>
        </div>
        <p>
          {readySources.length === 0
            ? '暂无可用来源，请先返回导入或配置一个刮削插件。'
            : `将替换其支持的 ${supported.length} 个字段来源；不支持的字段保留原设置。`}
        </p>
        <div className={styles.applyStatus}>
          <span role="status">{notice || '应用后，可以在下方将个别字段改为其他来源。'}</span>
          {undo ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setMapping(undo)
                setUndo(null)
                setNotice('已撤销上次批量应用。')
              }}
            >
              撤销应用
            </Button>
          ) : null}
        </div>
      </section>
      <section aria-label="字段来源">
        <div className={styles.sectionHead}>
          <h4>2. 按字段微调</h4>
          <span>
            已分配 {assigned.length}/{fields.length} · 使用{' '}
            {new Set(assigned.map((field) => mapping[field.id])).size} 个插件
          </span>
        </div>
        <div className={styles.mapping}>
          {fields.map((field) => {
            const value = mapping[field.id] ?? ''
            const missing = value && !sources.some((source) => source.name === value)
            return (
              <label key={field.id} className={styles.mappingRow}>
                <span>{field.label}</span>
                <SelectControl
                  aria-label={`${field.label}来源`}
                  aria-invalid={invalid.some((item) => item.id === field.id) || undefined}
                  value={value}
                  disabled={saving}
                  onChange={(event) => {
                    setMapping((current) => ({ ...current, [field.id]: event.target.value }))
                    setUndo(null)
                    setNotice('')
                  }}
                >
                  <option value="">不采集此字段</option>
                  {missing ? (
                    <option value={value} disabled>
                      {value}（已不可用）
                    </option>
                  ) : null}
                  {sources.map((source) => (
                    <option
                      key={source.name}
                      value={source.name}
                      disabled={
                        source.configured === false || !source.supportedFields.includes(field.id)
                      }
                    >
                      {source.name}
                      {source.configured === false
                        ? '（待配置）'
                        : !source.supportedFields.includes(field.id)
                          ? '（不支持）'
                          : ''}
                    </option>
                  ))}
                </SelectControl>
              </label>
            )
          })}
        </div>
      </section>
      {problem ? (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      ) : null}
    </Modal>
  )
}
