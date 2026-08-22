import { useEffect, useMemo, useState } from 'react'
import type {
  ModelManagementSnapshot,
  ModelWorkloadAssignmentView,
  ModelWorkloadId,
  WorkloadModelSelection
} from '@shared/modelManagementTypes'
import Button from '../Button'
import SelectControl from '../SelectControl'
import type { ApplyModelManagementCommand } from './ModelSettingsPanel'
import styles from './ModelUsagePanel.module.css'
import { modelConnectionName } from './modelSettingsView'

function ModelSelect({
  snapshot,
  value,
  onChange,
  agentOnly = false
}: {
  snapshot: ModelManagementSnapshot
  value: string
  onChange: (value: string) => void
  agentOnly?: boolean
}): JSX.Element {
  const readyConnections = new Set(
    snapshot.connections.filter((connection) => connection.status === 'ready').map((connection) => connection.id)
  )
  const models = snapshot.models.filter(
    (model) =>
      model.kind === 'chat' &&
      readyConnections.has(model.connectionId) &&
      (!agentOnly || model.effective.capabilities.tools === true)
  )
  return (
    <SelectControl value={value} onChange={(event) => onChange(event.target.value)}>
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {modelConnectionName(snapshot, model.connectionId)} · {model.name}
        </option>
      ))}
    </SelectControl>
  )
}

function AgentAssignmentCard({
  snapshot,
  assignment,
  busy,
  apply
}: {
  snapshot: ModelManagementSnapshot
  assignment: ModelWorkloadAssignmentView
  busy: boolean
  apply: ApplyModelManagementCommand
}): JSX.Element {
  const [draft, setDraft] = useState(assignment)
  useEffect(() => setDraft(assignment), [assignment])
  const title = assignment.workloadId === 'plugin-developer'
    ? '插件开发 Agent'
    : '媒体库整理 Agent'
  const inherited = draft.model.mode === 'inherit-default'
  const selectedRef = draft.model.mode === 'explicit'
    ? draft.model.modelRef
    : assignment.resolution.modelRef ?? ''
  const updateSelection = (mode: WorkloadModelSelection['mode'], modelRef = selectedRef): void => {
    setDraft((current) => ({
      ...current,
      model: mode === 'inherit-default' ? { mode } : { mode, modelRef }
    }))
  }
  const dirty = JSON.stringify({
    model: draft.model,
    runtime: draft.runtime,
    compaction: draft.compaction,
    limits: draft.limits
  }) !== JSON.stringify({
    model: assignment.model,
    runtime: assignment.runtime,
    compaction: assignment.compaction,
    limits: assignment.limits
  })
  const setNumber = (
    section: 'runtime' | 'limits' | 'compaction',
    key: string,
    value: number
  ): void => setDraft((current) => ({
    ...current,
    [section]: { ...current[section], [key]: value }
  }))

  return (
    <section className={styles.assignmentCard}>
      <header className={styles.cardHeader}>
        <div>
          <h3 className={styles.sectionTitle}>{title}</h3>
          <p className={styles.sectionHint}>
            {inherited ? '当前继承：' : ''}
            {assignment.resolution.providerName ?? '未配置'} · {assignment.resolution.modelName ?? '未选择'}
          </p>
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty || busy}
          onClick={() => void apply({
            type: 'set-workload-assignment',
            workloadId: assignment.workloadId as Exclude<ModelWorkloadId, 'app-default'>,
            model: draft.model,
            runtime: draft.runtime,
            compaction: draft.compaction,
            limits: draft.limits
          }, `${title}设置已保存`)}
        >
          {busy ? '保存中…' : dirty ? '保存' : '已保存'}
        </Button>
      </header>
      <div className={styles.gridTwo}>
        <label className={styles.field}>
          <span>模型来源</span>
          <SelectControl
            value={draft.model.mode}
            onChange={(event) => updateSelection(event.target.value as WorkloadModelSelection['mode'])}
          >
            <option value="inherit-default">继承应用默认</option>
            <option value="explicit">独立指定</option>
          </SelectControl>
        </label>
        <label className={styles.field}>
          <span>实际模型</span>
          <ModelSelect
            snapshot={snapshot}
            value={selectedRef}
            agentOnly
            onChange={(modelRef) => updateSelection('explicit', modelRef)}
          />
        </label>
        <label className={styles.field}>
          <span>思考强度</span>
          <SelectControl
            value={draft.runtime.thinkingLevel}
            onChange={(event) => setDraft((current) => ({
              ...current,
              runtime: {
                ...current.runtime,
                thinkingLevel: event.target.value as typeof current.runtime.thinkingLevel
              }
            }))}
          >
            <option value="minimal">Minimal</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </SelectControl>
        </label>
        <label className={styles.field}>
          <span>缓存保留</span>
          <SelectControl
            value={draft.runtime.cacheRetention}
            onChange={(event) => setDraft((current) => ({
              ...current,
              runtime: {
                ...current.runtime,
                cacheRetention: event.target.value as typeof current.runtime.cacheRetention
              }
            }))}
          >
            <option value="none">不保留</option>
            <option value="short">短期</option>
            <option value="long">长期</option>
          </SelectControl>
        </label>
        <label className={styles.field}>
          <span>最大输出（0 = 模型上限）</span>
          <input className={styles.controlInput} type="number" min="0" value={draft.runtime.maxTokens} onChange={(event) =>
            setNumber('runtime', 'maxTokens', Number(event.target.value))} />
        </label>
        <label className={styles.field}>
          <span>超时（秒）</span>
          <input className={styles.controlInput} type="number" min="1" value={Math.round(draft.runtime.timeoutMs / 1000)} onChange={(event) =>
            setNumber('runtime', 'timeoutMs', Number(event.target.value) * 1000)} />
        </label>
        <label className={styles.field}>
          <span>每次最大轮次（0 = 不限）</span>
          <input className={styles.controlInput} type="number" min="0" value={draft.limits.maxTurns} onChange={(event) =>
            setNumber('limits', 'maxTurns', Number(event.target.value))} />
        </label>
        <label className={styles.field}>
          <span>最大上下文</span>
          <input className={styles.controlInput} type="number" min="1" value={draft.limits.maxContextTokens} onChange={(event) =>
            setNumber('limits', 'maxContextTokens', Number(event.target.value))} />
        </label>
        <label className={styles.field}>
          <span>上下文压缩</span>
          <SelectControl
            value={draft.compaction.enabled ? 'enabled' : 'disabled'}
            onChange={(event) => setDraft((current) => ({
              ...current,
              compaction: { ...current.compaction, enabled: event.target.value === 'enabled' }
            }))}
          >
            <option value="enabled">启用</option>
            <option value="disabled">关闭</option>
          </SelectControl>
        </label>
        <label className={styles.field}>
          <span>压缩保留 / 最近 tokens</span>
          <div className={styles.inlineInputs}>
            <input className={styles.controlInput} type="number" min="0" value={draft.compaction.reserveTokens} onChange={(event) =>
              setNumber('compaction', 'reserveTokens', Number(event.target.value))} />
            <input className={styles.controlInput} type="number" min="0" value={draft.compaction.keepRecentTokens} onChange={(event) =>
              setNumber('compaction', 'keepRecentTokens', Number(event.target.value))} />
          </div>
        </label>
      </div>
    </section>
  )
}

export default function ModelUsagePanel({
  snapshot,
  busy,
  apply
}: {
  snapshot: ModelManagementSnapshot
  busy: boolean
  apply: ApplyModelManagementCommand
}): JSX.Element {
  const defaultAssignment = snapshot.assignments.find((item) => item.workloadId === 'app-default')!
  const agentAssignments = useMemo(
    () => snapshot.assignments.filter((item) => item.workloadId !== 'app-default'),
    [snapshot.assignments]
  )
  const defaultRef = defaultAssignment.model.mode === 'explicit'
    ? defaultAssignment.model.modelRef
    : ''
  const [draftDefault, setDraftDefault] = useState(defaultRef)
  useEffect(() => setDraftDefault(defaultRef), [defaultRef])

  return (
    <div className={styles.stack}>
      <section className={styles.assignmentCard}>
        <header className={styles.cardHeader}>
          <div>
            <h3 className={styles.sectionTitle}>应用默认模型</h3>
            <p className={styles.sectionHint}>{defaultAssignment.resolution.providerName ?? '未配置'} · {defaultAssignment.resolution.modelName ?? '未选择'}</p>
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={!draftDefault || draftDefault === defaultRef || busy}
            onClick={() => void apply(
              { type: 'set-default-model', modelRef: draftDefault },
              '应用默认模型已保存'
            )}
          >
            {busy ? '保存中…' : draftDefault === defaultRef ? '已保存' : '保存'}
          </Button>
        </header>
        <div className={styles.singleField}>
          <label className={styles.field}>
            <span>提供商与模型</span>
            <ModelSelect snapshot={snapshot} value={draftDefault} onChange={setDraftDefault} />
          </label>
        </div>
      </section>
      {agentAssignments.map((assignment) => (
        <AgentAssignmentCard
          key={assignment.workloadId}
          snapshot={snapshot}
          assignment={assignment}
          busy={busy}
          apply={apply}
        />
      ))}
    </div>
  )
}
