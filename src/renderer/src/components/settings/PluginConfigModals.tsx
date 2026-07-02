import { useMemo, useRef, useState } from 'react'
import type {
  ActressScrapeField,
  CompositeScraperInput,
  ScraperPluginDescriptor,
  ScraperPluginUpdateInput,
  VideoScrapeField
} from '@shared/types'
import {
  ACTRESS_SCRAPE_FIELD_OPTIONS,
  ALL_ACTRESS_SCRAPE_FIELDS,
  ALL_VIDEO_SCRAPE_FIELDS,
  VIDEO_SCRAPE_FIELD_OPTIONS
} from '@shared/types'
import Modal from '../Modal'
import { defaultPluginDelay, pluginSourceLabel } from '../../settings/settingsDisplay'

export type PluginKind = 'video' | 'actress'

export interface PluginEditState {
  kind: PluginKind
  plugin: ScraperPluginDescriptor
}

export interface CompositeEditState {
  kind: PluginKind
  plugin?: ScraperPluginDescriptor
}

const UNSAVED_CONFIRM = '有未保存的更改，确定放弃吗？'

function fieldLabel(kind: PluginKind, field: string): string {
  const options = kind === 'video' ? VIDEO_SCRAPE_FIELD_OPTIONS : ACTRESS_SCRAPE_FIELD_OPTIONS
  return options.find((option) => option.id === field)?.label ?? field
}

function allFieldsForKind(kind: PluginKind): Array<VideoScrapeField | ActressScrapeField> {
  return kind === 'video' ? ALL_VIDEO_SCRAPE_FIELDS : ALL_ACTRESS_SCRAPE_FIELDS
}

function requestCloseIfAllowed(isDirty: boolean, onCancel: () => void): void {
  if (isDirty && !window.confirm(UNSAVED_CONFIRM)) return
  onCancel()
}

export function PluginConfigModal({
  state,
  saving = false,
  onSave,
  onCancel
}: {
  state: PluginEditState
  saving?: boolean
  onSave: (kind: PluginKind, name: string, input: ScraperPluginUpdateInput) => void
  onCancel: () => void
}): JSX.Element {
  const { kind, plugin } = state
  const editableMeta = plugin.source === 'user'
  const delay = defaultPluginDelay(plugin.delay)
  const initialRef = useRef({
    description: plugin.description,
    minSeconds: String(Math.round(delay.minMs / 1000)),
    maxSeconds: String(Math.round(delay.maxMs / 1000))
  })
  const [description, setDescription] = useState(initialRef.current.description)
  const [minSeconds, setMinSeconds] = useState(initialRef.current.minSeconds)
  const [maxSeconds, setMaxSeconds] = useState(initialRef.current.maxSeconds)
  const allFields = allFieldsForKind(kind)
  const supportedFieldSet = new Set(plugin.supportedFields)
  const supportedCount = supportedFieldSet.size
  const versionLabel = plugin.version === 'built-in' ? '内置' : plugin.version?.trim() || '—'
  const homepageLabel = (plugin.homepage ?? '').trim() || '—'
  const authorLabel = (plugin.author ?? '').trim() || '—'

  const isDirty = useMemo(() => {
    const initial = initialRef.current
    const metaDirty = editableMeta && description !== initial.description
    const delayDirty = minSeconds !== initial.minSeconds || maxSeconds !== initial.maxSeconds
    return metaDirty || delayDirty
  }, [description, editableMeta, maxSeconds, minSeconds])

  const handleCancel = (): void => {
    requestCloseIfAllowed(isDirty, onCancel)
  }

  return (
    <Modal
      title={`编辑插件：${plugin.name}`}
      confirmText={saving ? '保存中…' : '保存'}
      confirmDisabled={saving}
      size="lg"
      className="modal-plugin-editor"
      onCancel={handleCancel}
      onConfirm={() =>
        onSave(kind, plugin.name, {
          description: editableMeta ? description : undefined,
          delay: {
            minMs: Math.max(0, Number(minSeconds) || 0) * 1000,
            maxMs: Math.max(Number(minSeconds) || 0, Number(maxSeconds) || 0) * 1000
          }
        })
      }
    >
      <div className="plugin-edit-form plugin-edit-form--config">
        {(plugin.overridesBuiltIn || !editableMeta) && (
          <header className="plugin-config-hero">
            <div className="plugin-config-hero-top">
              <span
                className={`plugin-source-badge plugin-source-badge--${
                  plugin.source === 'user'
                    ? 'user'
                    : plugin.source === 'composite'
                      ? 'composite'
                      : 'builtin'
                }`}
              >
                {pluginSourceLabel(plugin)}
              </span>
              {plugin.overridesBuiltIn && <span className="plugin-config-note">覆盖内置同名插件</span>}
            </div>
            {!editableMeta && (
              <p className="plugin-config-hint">
                内置插件仅可调整访问间隔；查看或调试代码请使用卡片菜单「AI 调试」。
              </p>
            )}
          </header>
        )}

        <section className="plugin-config-panel">
          <h4 className="plugin-config-panel-title">基本信息</h4>
          {editableMeta ? (
            <div className="plugin-config-meta-stack">
              <dl className="plugin-config-meta">
                <div className="plugin-config-meta-row">
                  <dt>版本</dt>
                  <dd>{versionLabel}</dd>
                </div>
                <div className="plugin-config-meta-row">
                  <dt>主页</dt>
                  <dd className="plugin-config-meta-value--truncate" title={homepageLabel}>
                    {homepageLabel}
                  </dd>
                </div>
                <div className="plugin-config-meta-row">
                  <dt>作者</dt>
                  <dd>{authorLabel}</dd>
                </div>
              </dl>
              <label className="plugin-edit-control plugin-config-description-field">
                <span>说明</span>
                <input
                  className="text-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
            </div>
          ) : (
            <dl className="plugin-config-meta">
              <div className="plugin-config-meta-row">
                <dt>版本</dt>
                <dd>{versionLabel}</dd>
              </div>
              <div className="plugin-config-meta-row">
                <dt>主页</dt>
                <dd className="plugin-config-meta-value--truncate" title={homepageLabel}>
                  {homepageLabel}
                </dd>
              </div>
              <div className="plugin-config-meta-row">
                <dt>作者</dt>
                <dd>{authorLabel}</dd>
              </div>
              <div className="plugin-config-meta-row plugin-config-meta-row--wide">
                <dt>说明</dt>
                <dd>{description.trim() || '—'}</dd>
              </div>
            </dl>
          )}
        </section>

        <section className="plugin-config-panel plugin-config-panel--accent">
          <div className="plugin-config-panel-head">
            <h4 className="plugin-config-panel-title">访问间隔</h4>
            <span className="plugin-config-panel-caption">批量刮削时按站点独立计算</span>
          </div>
          <div className="plugin-config-delay">
            <label className="plugin-config-delay-field">
              <span>最小（秒）</span>
              <input
                className="text-input"
                type="number"
                min={0}
                value={minSeconds}
                onChange={(e) => setMinSeconds(e.target.value)}
              />
            </label>
            <span className="plugin-config-delay-sep" aria-hidden>
              —
            </span>
            <label className="plugin-config-delay-field">
              <span>最大（秒）</span>
              <input
                className="text-input"
                type="number"
                min={0}
                value={maxSeconds}
                onChange={(e) => setMaxSeconds(e.target.value)}
              />
            </label>
          </div>
        </section>

        <section className="plugin-config-panel">
          <div className="plugin-config-panel-head">
            <h4 className="plugin-config-panel-title">支持字段</h4>
            <span className="plugin-config-field-count">
              {supportedCount}/{allFields.length}
            </span>
          </div>
          <p className="plugin-config-panel-caption plugin-config-panel-caption--block">
            由插件实现决定，不可在此修改
          </p>
          <div className="plugin-config-field-grid" role="list" aria-label="支持字段">
            {allFields.map((field) => {
              const supported = supportedFieldSet.has(field)
              return (
                <span
                  key={field}
                  role="listitem"
                  className={`plugin-config-field-chip${supported ? ' is-on' : ' is-off'}`}
                >
                  {fieldLabel(kind, field)}
                </span>
              )
            })}
          </div>
        </section>
      </div>
    </Modal>
  )
}

export function CompositeConfigModal({
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
  const sourcePlugins = plugins.filter((item) => item.source !== 'composite')
  const allFields = allFieldsForKind(kind)
  const initialRef = useRef({
    name: plugin?.name ?? '',
    description: plugin?.description ?? '',
    fieldPluginMap: { ...(plugin?.fieldPluginMap ?? {}) } as Record<string, string>
  })
  const [name, setName] = useState(initialRef.current.name)
  const [description, setDescription] = useState(initialRef.current.description)
  const [fieldPluginMap, setFieldPluginMap] = useState<Record<string, string>>(
    () => ({ ...initialRef.current.fieldPluginMap })
  )

  const isDirty = useMemo(() => {
    const initial = initialRef.current
    if (name !== initial.name || description !== initial.description) return true
    const keys = new Set([...Object.keys(initial.fieldPluginMap), ...Object.keys(fieldPluginMap)])
    for (const key of keys) {
      if ((fieldPluginMap[key] ?? '') !== (initial.fieldPluginMap[key] ?? '')) return true
    }
    return false
  }, [description, fieldPluginMap, name])

  const handleCancel = (): void => {
    requestCloseIfAllowed(isDirty, onCancel)
  }

  return (
    <Modal
      title={plugin ? `编辑组合插件：${plugin.name}` : '新增组合插件'}
      confirmText={saving ? '保存中…' : '保存'}
      confirmDisabled={saving}
      size="lg"
      className="modal-plugin-editor"
      onCancel={handleCancel}
      onConfirm={() =>
        onSave(kind, plugin?.name ?? null, {
          name,
          description,
          fieldPluginMap
        })
      }
    >
      <div className="plugin-edit-form">
        <div className="plugin-edit-summary">
          <div>
            <span className="plugin-source-badge plugin-source-badge--composite">组合</span>
          </div>
          <span>
            已映射 {Object.values(fieldPluginMap).filter(Boolean).length}/{allFields.length} · 复用字段站点间隔
          </span>
        </div>
        <div className="plugin-edit-section">
          <div className="plugin-edit-section-head">
            <span>基本信息</span>
            <span>组合插件按字段调用不同站点</span>
          </div>
          <div className="plugin-edit-grid">
            <label className="plugin-edit-control plugin-edit-control--short">
              <span>名称</span>
              <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="plugin-edit-control">
              <span>说明</span>
              <input
                className="text-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </div>
        </div>
        <div className="plugin-edit-section">
          <div className="plugin-edit-section-head">
            <span>字段来源</span>
            <span>不支持该字段的站点不可选</span>
          </div>
          <div className="composite-field-map">
            {allFields.map((field) => (
              <label key={field} className="composite-field-row">
                <span>{fieldLabel(kind, field)}</span>
                <select
                  className="select"
                  value={fieldPluginMap[field] ?? ''}
                  onChange={(e) =>
                    setFieldPluginMap((prev) => ({
                      ...prev,
                      [field]: e.target.value
                    }))
                  }
                >
                  <option value="">不使用</option>
                  {sourcePlugins.map((sourcePlugin) => (
                    <option
                      key={`${sourcePlugin.source}:${sourcePlugin.name}:${field}`}
                      value={sourcePlugin.name}
                      disabled={!sourcePlugin.supportedFields.includes(field)}
                    >
                      {sourcePlugin.name}
                      {!sourcePlugin.supportedFields.includes(field) ? '（不支持）' : ''}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}
