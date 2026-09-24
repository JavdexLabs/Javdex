import Switch from '../Switch'
import { useMemo, useState } from 'react'
import type { ModelCapabilityState } from '@shared/aiConfigurationTypes'
import type {
  ManagedModelView,
  ManualModelOverrides,
  ModelManagementSnapshot
} from '@shared/modelManagementTypes'
import Button from '../Button'
import SettingsFormActions from './SettingsFormActions'
import { useSettingsDraft } from '../../settings/useSettingsDraft'
import { useSettingsFormGuard } from '../../settings/SettingsLeaveGuard'
import SelectControl from '../SelectControl'
import type { ApplyModelManagementCommand } from './ModelSettingsPanel'
import styles from './ModelAdvancedPanel.module.css'
import { modelConnectionName } from './modelSettingsView'

function capabilityLabel(value: ModelCapabilityState): string {
  if (value === true) return '支持'
  if (value === false) return '不支持'
  return '未知'
}

function capabilityValue(value: string): ModelCapabilityState {
  if (value === 'true') return true
  if (value === 'false') return false
  return 'unknown'
}

function ModelOverrideCard({
  snapshot,
  model,
  busy,
  apply
}: {
  snapshot: ModelManagementSnapshot
  model: ManagedModelView
  busy: boolean
  apply: ApplyModelManagementCommand
}): JSX.Element {
  const form = useSettingsDraft({
    contextWindow: model.effective.contextWindow,
    maxTokens: model.effective.maxTokens,
    tools: model.effective.capabilities.tools,
    reasoning: model.effective.capabilities.reasoning,
    promptCache: model.effective.cache.supportsPromptCache,
    longCache: model.effective.cache.supportsLongCacheRetention
  })
  const { contextWindow, maxTokens, tools, reasoning, promptCache, longCache } = form.draft
  const update = <K extends keyof typeof form.draft>(key: K, value: (typeof form.draft)[K]): void =>
    form.setDraft((current) => ({ ...current, [key]: value }))
  const [saving, setSaving] = useState(false)
  const save = async (): Promise<boolean> => {
    setSaving(true)
    const patch: ManualModelOverrides = {
      contextWindow,
      maxTokens,
      capabilities: { tools, reasoning },
      cache: {
        supportsPromptCache: promptCache,
        supportsLongCacheRetention: longCache,
        evidence: {
          source: 'manual',
          checkedAt: new Date().toISOString(),
          note: '用户在模型高级设置中确认'
        }
      }
    }
    try {
      const ok = await apply(
        { type: 'set-model-override', modelRef: model.id, patch },
        `${model.name} 的人工覆盖已保存`
      )
      if (ok) form.accept(form.draft)
      return ok
    } finally {
      setSaving(false)
    }
  }
  useSettingsFormGuard({
    label: model.name,
    dirty: form.dirty,
    busy: saving,
    save,
    discard: form.reset
  })

  return (
    <section className={styles.advancedCard}>
      <header className={styles.cardHeader}>
        <div className={styles.modelTitle}>
          <h3 className={`${styles.sectionTitle} ${styles.truncate}`} title={model.name}>
            {model.name}
          </h3>
          <p className={`${styles.sectionHint} ${styles.truncate}`} title={model.modelId}>
            {modelConnectionName(snapshot, model.connectionId)} · {model.modelId}
          </p>
        </div>
        <div className={styles.cardActions}>
          {model.hasManualOverrides ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void apply(
                  { type: 'reset-model-override', modelRef: model.id },
                  `${model.name} 已恢复自动识别值`
                )
              }
            >
              恢复自动识别值
            </Button>
          ) : null}
          <SettingsFormActions placement="header"
            dirty={form.dirty}
            saving={saving}
            disabled={busy}
            conflict={form.conflict}
            onSave={() => void save()}
            onCancel={form.reset}
          />
        </div>
      </header>

      <div className={styles.baselineMeta}>
        <span>能力来源：{model.baseline.cache.evidence.source}</span>
        <span>{new Date(model.baseline.cache.evidence.checkedAt).toLocaleString()}</span>
        {model.hasManualOverrides ? (
          <strong className={styles.overrideBadge}>已人工覆盖</strong>
        ) : null}
      </div>

      <div className={styles.advancedGrid}>
        <label className={styles.field}>
          <span>上下文窗口</span>
          <input
            className={styles.controlInput}
            type="number"
            min="1"
            value={contextWindow}
            onChange={(event) => update('contextWindow', Number(event.target.value))}
          />
        </label>
        <label className={styles.field}>
          <span>模型最大输出</span>
          <input
            className={styles.controlInput}
            type="number"
            min="1"
            value={maxTokens}
            onChange={(event) => update('maxTokens', Number(event.target.value))}
          />
        </label>
        <label className={styles.field}>
          <span>工具调用</span>
          <SelectControl
            value={String(tools)}
            onChange={(event) => update('tools', capabilityValue(event.target.value))}
          >
            <option value="true">支持</option>
            <option value="false">不支持</option>
            <option value="unknown">未知</option>
          </SelectControl>
        </label>
        <label className={styles.field}>
          <span>推理</span>
          <SelectControl
            value={String(reasoning)}
            onChange={(event) => update('reasoning', capabilityValue(event.target.value))}
          >
            <option value="true">支持</option>
            <option value="false">不支持</option>
            <option value="unknown">未知</option>
          </SelectControl>
        </label>
        <label className={styles.field}>
          <span>提示缓存</span>
          <SelectControl
            value={String(promptCache)}
            onChange={(event) => update('promptCache', capabilityValue(event.target.value))}
          >
            <option value="true">支持</option>
            <option value="false">不支持</option>
            <option value="unknown">未知</option>
          </SelectControl>
        </label>
        <label className={styles.field}>
          <span>长期缓存</span>
          <SelectControl
            value={longCache ? 'true' : 'false'}
            onChange={(event) => update('longCache', event.target.value === 'true')}
          >
            <option value="true">支持</option>
            <option value="false">不支持</option>
          </SelectControl>
        </label>
      </div>

      <dl className={styles.baselineSummary}>
        <div className={styles.baselineItem}>
          <dt className={styles.baselineLabel}>工具调用</dt>
          <dd className={styles.baselineValue}>
            {capabilityLabel(model.baseline.capabilities.tools)}
          </dd>
        </div>
        <div className={styles.baselineItem}>
          <dt className={styles.baselineLabel}>推理能力</dt>
          <dd className={styles.baselineValue}>
            {capabilityLabel(model.baseline.capabilities.reasoning)}
          </dd>
        </div>
        <div className={styles.baselineItem}>
          <dt className={styles.baselineLabel}>提示缓存</dt>
          <dd className={styles.baselineValue}>
            {capabilityLabel(model.baseline.cache.supportsPromptCache)}
          </dd>
        </div>
        <div className={styles.baselineItem}>
          <dt className={styles.baselineLabel}>长期缓存</dt>
          <dd className={styles.baselineValue}>
            {model.baseline.cache.supportsLongCacheRetention ? '支持' : '不支持'}
          </dd>
        </div>
      </dl>
    </section>
  )
}

export default function ModelAdvancedPanel({
  snapshot,
  busy,
  apply
}: {
  snapshot: ModelManagementSnapshot
  busy: boolean
  apply: ApplyModelManagementCommand
}): JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const referenced = useMemo(
    () => new Set(snapshot.assignments.flatMap((item) => item.resolution.modelRef ?? [])),
    [snapshot.assignments]
  )
  const models = showAll
    ? snapshot.models
    : snapshot.models.filter((model) => referenced.has(model.id))

  return (
    <div className={styles.stack}>
      <section className={styles.panelCard}>
        <header className={styles.cardHeader}>
          <div>
            <h3 className={styles.sectionTitle}>模型能力与上限</h3>
            <p className={styles.sectionHint}>
              默认仅显示三个用途实际引用的模型；人工覆盖会优先于自动识别值。
            </p>
          </div>
          <label className={styles.toggleLabel}>
            <Switch checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
            <span>显示全部模型</span>
          </label>
        </header>
      </section>
      {models.map((model) => (
        <ModelOverrideCard
          key={model.id}
          snapshot={snapshot}
          model={model}
          busy={busy}
          apply={apply}
        />
      ))}
      {models.length === 0 ? <div className={styles.empty}>当前没有可编辑的生成模型</div> : null}
    </div>
  )
}
