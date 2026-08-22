import { useEffect, useMemo, useState } from 'react'
import type { ModelCapabilityState } from '@shared/aiConfigurationTypes'
import type {
  ManagedModelView,
  ManualModelOverrides,
  ModelManagementSnapshot
} from '@shared/modelManagementTypes'
import Button from '../Button'
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
  const [contextWindow, setContextWindow] = useState(model.effective.contextWindow)
  const [maxTokens, setMaxTokens] = useState(model.effective.maxTokens)
  const [tools, setTools] = useState<ModelCapabilityState>(model.effective.capabilities.tools)
  const [reasoning, setReasoning] = useState<ModelCapabilityState>(model.effective.capabilities.reasoning)
  const [promptCache, setPromptCache] = useState<ModelCapabilityState>(
    model.effective.cache.supportsPromptCache
  )
  const [longCache, setLongCache] = useState(model.effective.cache.supportsLongCacheRetention)

  useEffect(() => {
    setContextWindow(model.effective.contextWindow)
    setMaxTokens(model.effective.maxTokens)
    setTools(model.effective.capabilities.tools)
    setReasoning(model.effective.capabilities.reasoning)
    setPromptCache(model.effective.cache.supportsPromptCache)
    setLongCache(model.effective.cache.supportsLongCacheRetention)
  }, [model])

  const dirty =
    contextWindow !== model.effective.contextWindow ||
    maxTokens !== model.effective.maxTokens ||
    tools !== model.effective.capabilities.tools ||
    reasoning !== model.effective.capabilities.reasoning ||
    promptCache !== model.effective.cache.supportsPromptCache ||
    longCache !== model.effective.cache.supportsLongCacheRetention

  const save = (): void => {
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
    void apply(
      { type: 'set-model-override', modelRef: model.id, patch },
      `${model.name} 的人工覆盖已保存`
    )
  }

  return (
    <section className={styles.advancedCard}>
      <header className={styles.cardHeader}>
        <div className={styles.modelTitle}>
          <h3 className={`${styles.sectionTitle} ${styles.truncate}`} title={model.name}>{model.name}</h3>
          <p className={`${styles.sectionHint} ${styles.truncate}`} title={model.modelId}>{modelConnectionName(snapshot, model.connectionId)} · {model.modelId}</p>
        </div>
        <div className={styles.cardActions}>
          {model.hasManualOverrides ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void apply(
                { type: 'reset-model-override', modelRef: model.id },
                `${model.name} 已恢复 baseline`
              )}
            >
              恢复 baseline
            </Button>
          ) : null}
          <Button size="sm" variant="primary" disabled={!dirty || busy} onClick={save}>
            {busy ? '保存中…' : dirty ? '保存' : '已保存'}
          </Button>
        </div>
      </header>

      <div className={styles.baselineMeta}>
        <span>Baseline：{model.baseline.cache.evidence.source}</span>
        <span>{new Date(model.baseline.cache.evidence.checkedAt).toLocaleString()}</span>
        {model.hasManualOverrides ? <strong className={styles.overrideBadge}>已人工覆盖</strong> : null}
      </div>

      <div className={styles.advancedGrid}>
        <label className={styles.field}>
          <span>上下文窗口</span>
          <input className={styles.controlInput} type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} />
        </label>
        <label className={styles.field}>
          <span>模型最大输出</span>
          <input className={styles.controlInput} type="number" min="1" value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} />
        </label>
        <label className={styles.field}>
          <span>工具调用</span>
          <SelectControl value={String(tools)} onChange={(event) => setTools(capabilityValue(event.target.value))}>
            <option value="true">支持</option>
            <option value="false">不支持</option>
            <option value="unknown">未知</option>
          </SelectControl>
        </label>
        <label className={styles.field}>
          <span>Reasoning</span>
          <SelectControl value={String(reasoning)} onChange={(event) => setReasoning(capabilityValue(event.target.value))}>
            <option value="true">支持</option>
            <option value="false">不支持</option>
            <option value="unknown">未知</option>
          </SelectControl>
        </label>
        <label className={styles.field}>
          <span>Prompt cache</span>
          <SelectControl value={String(promptCache)} onChange={(event) => setPromptCache(capabilityValue(event.target.value))}>
            <option value="true">支持</option>
            <option value="false">不支持</option>
            <option value="unknown">未知</option>
          </SelectControl>
        </label>
        <label className={styles.field}>
          <span>Long cache</span>
          <SelectControl value={longCache ? 'true' : 'false'} onChange={(event) => setLongCache(event.target.value === 'true')}>
            <option value="true">支持</option>
            <option value="false">不支持</option>
          </SelectControl>
        </label>
      </div>

      <dl className={styles.baselineSummary}>
        <div className={styles.baselineItem}><dt className={styles.baselineLabel}>Tools baseline</dt><dd className={styles.baselineValue}>{capabilityLabel(model.baseline.capabilities.tools)}</dd></div>
        <div className={styles.baselineItem}><dt className={styles.baselineLabel}>Reasoning baseline</dt><dd className={styles.baselineValue}>{capabilityLabel(model.baseline.capabilities.reasoning)}</dd></div>
        <div className={styles.baselineItem}><dt className={styles.baselineLabel}>Prompt cache baseline</dt><dd className={styles.baselineValue}>{capabilityLabel(model.baseline.cache.supportsPromptCache)}</dd></div>
        <div className={styles.baselineItem}><dt className={styles.baselineLabel}>Long cache baseline</dt><dd className={styles.baselineValue}>{model.baseline.cache.supportsLongCacheRetention ? '支持' : '不支持'}</dd></div>
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
  const models = showAll ? snapshot.models : snapshot.models.filter((model) => referenced.has(model.id))

  return (
    <div className={styles.stack}>
      <section className={styles.panelCard}>
        <header className={styles.cardHeader}>
          <div>
            <h3 className={styles.sectionTitle}>模型能力与上限</h3>
            <p className={styles.sectionHint}>默认仅显示三个用途实际引用的模型；人工覆盖会优先于 baseline。</p>
          </div>
          <label className={styles.toggleLabel}>
            <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
            <span>显示全部模型</span>
          </label>
        </header>
      </section>
      {models.map((model) => (
        <ModelOverrideCard key={model.id} snapshot={snapshot} model={model} busy={busy} apply={apply} />
      ))}
      {models.length === 0 ? <div className={styles.empty}>当前没有可编辑的生成模型</div> : null}
    </div>
  )
}
