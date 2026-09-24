import type {
  PluginDevDryRunCase,
  PluginDevDryRunResult,
  PluginExecutionArtifact,
  PluginExecutionCase,
  PluginRunAcceptanceOutcome
} from '@shared/pluginDevTypes'
import { runTargetLabel } from '@shared/pluginDevKindProfile'
import { SquareTerminal } from 'lucide-react'
import { formatParseResultKeyLabel } from '@shared/scrapeFieldPromptDocs'
import EmptyState from '../EmptyState'
import { UI_ICON_SM } from '../iconDefaults'
import type { PluginKind } from './types'
import styles from './PluginDevResultPanel.module.css'

function formatResultValue(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    if (key === 'actresses') {
      return value.map((item) => {
        if (!item || typeof item !== 'object') return String(item)
        const name = 'name' in item ? String((item as { name?: unknown }).name ?? '') : ''
        const gender = 'gender' in item ? String((item as { gender?: unknown }).gender ?? '') : ''
        return name ? (gender ? `${name} (${gender})` : name) : JSON.stringify(item)
      }).join('、')
    }
    if (value.every((item) => typeof item === 'string')) return value.join('、')
    return JSON.stringify(value)
  }
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

function resultRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    )
  }
  return value && typeof value === 'object' ? [value as Record<string, unknown>] : []
}

function objectEntries(result: Record<string, unknown>): Array<{ key: string; value: string }> {
  return Object.entries(result)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ({ key, value: formatResultValue(key, value) }))
}

function ResultKv({ kind, record, prefix }: {
  kind: PluginKind
  record: Record<string, unknown>
  prefix: string
}): JSX.Element {
  const entries = objectEntries(record)
  if (entries.length === 0) return <p className={styles.resultEmpty}>无字段</p>
  return (
    <div className={styles.resultKv}>
      {entries.map((entry) => (
        <div key={`${prefix}:${entry.key}`} className={styles.resultKvRow}>
          <span>{formatParseResultKeyLabel(kind, entry.key)}</span>
          <span title={entry.value}>{entry.value}</span>
        </div>
      ))}
    </div>
  )
}

function ResultRows({ kind, value, prefix }: {
  kind: PluginKind
  value: unknown
  prefix: string
}): JSX.Element {
  if (value == null) return <p className={styles.resultEmpty}>无返回</p>
  if (Array.isArray(value) && value.length === 0) return <p className={styles.resultEmpty}>空数组</p>
  const records = resultRecords(value)
  if (records.length === 0) return <p className={styles.resultEmpty}>无法展示该返回形状</p>
  return (
    <div className={styles.resultGroup}>
      {records.map((record, index) => {
        const recordPrefix = records.length === 1 ? prefix : `${prefix}:${index}`
        return (
          <div key={recordPrefix} className={styles.resultCandidate}>
            {records.length > 1 ? (
              <span className={styles.resultCandidateLabel}>{`候选 ${index + 1}/${records.length}`}</span>
            ) : null}
            <ResultKv kind={kind} record={record} prefix={recordPrefix} />
          </div>
        )
      })}
    </div>
  )
}

function resultHasMultipleRecords(value: unknown): boolean {
  return resultRecords(value).length > 1
}

function ExecutionCaseView({ kind, item }: {
  kind: PluginKind
  item: PluginExecutionCase
}): JSX.Element {
  const label = runTargetLabel(item.target)
  const undeclared = item.manifestCoverage.undeclaredReturnedFieldIds
  const runtimeOnly = item.manifestCoverage.runtimeOnlyKeys
  const open = !item.runtimeAccepted ||
    undeclared.length > 0 ||
    resultHasMultipleRecords(item.pluginResult) ||
    resultHasMultipleRecords(item.effectiveResult)
  return (
    <details className={`plugin-dev-details ${styles.resultCase}`} open={open}>
      <summary>
        <span>{label}</span>
        <span className={item.runtimeAccepted ? styles.statusOk : styles.statusFail}>
          {item.runtimeAccepted ? '运行时接受' : '运行失败'}
        </span>
      </summary>
      {item.error ? <p className={styles.caseError}>{item.error}</p> : null}
      <h5>插件返回</h5>
      <ResultRows kind={kind} value={item.pluginResult} prefix={`${label}:plugin`} />
      <h5>生产有效结果</h5>
      <ResultRows kind={kind} value={item.effectiveResult} prefix={`${label}:effective`} />
      {undeclared.length > 0 ? (
        <div className={`${styles.banner} ${styles.warning}`}>
          <span>插件已返回但 manifest 未声明</span>
          <span>{undeclared.join('、')}</span>
        </div>
      ) : null}
      {runtimeOnly.length > 0 ? (
        <div className={`${styles.banner} ${styles.info}`}>
          <span>运行/调试信息，不属于 supportedFields</span>
          <span>{runtimeOnly.map((entry) => entry.key).join('、')}</span>
        </div>
      ) : null}
    </details>
  )
}

function LegacyCaseView({ kind, item }: { kind: PluginKind; item: PluginDevDryRunCase }): JSX.Element {
  return (
    <details className={`plugin-dev-details ${styles.resultCase}`} open={!item.ok}>
      <summary>
        <span>{item.target}</span>
        <span className={item.ok ? styles.statusOk : styles.statusFail}>{item.ok ? '通过' : '失败'}</span>
      </summary>
      {item.error ? <p className={styles.caseError}>{item.error}</p> : null}
      <ResultRows kind={kind} value={item.result} prefix={item.target} />
    </details>
  )
}

export default function PluginDevResultPanel({
  kind,
  dryRun,
  execution,
  acceptance,
  stale,
  installState
}: {
  kind: PluginKind
  dryRun: PluginDevDryRunResult | null
  execution: PluginExecutionArtifact | null
  acceptance: PluginRunAcceptanceOutcome | null
  stale: boolean
  installState: 'not-installed' | 'dirty' | 'synced'
}): JSX.Element {
  if (!dryRun && !execution) {
    return (
      <EmptyState
        variant="fill"
        className="plugin-dev-agent-empty"
        icon={<SquareTerminal {...UI_ICON_SM} aria-hidden />}
        title="暂无运行结果"
        description="Agent 运行 plugin_dry_run 后，插件原始返回和生产有效结果会显示在这里。"
      />
    )
  }

  const installLabel = installState === 'synced'
    ? '已与安装版本同步'
    : installState === 'dirty' ? '有未安装更改' : '尚未安装'
  const installStateClass = installState === 'not-installed'
    ? styles.notInstalled
    : styles[installState]
  const fullExecutionReady = execution?.scope === 'all' && acceptance?.ready === true

  return (
    <div className={styles.panel}>
      <div className={`${styles.installState} ${installStateClass}`}>
        {installLabel}
      </div>
      {stale ? (
        <div className={`${styles.banner} ${styles.warning}`}>
          <span>运行结果已过期</span>
          <span>当前插件内容已变化，需要重新执行完整 plugin_dry_run。</span>
        </div>
      ) : null}
      {dryRun && !dryRun.ok && dryRun.error ? (
        <div className={`${styles.banner} ${styles.failure}`}>
          <span>手工调试失败</span>
          <span>{dryRun.error}</span>
        </div>
      ) : null}
      {execution ? (
        <section className={styles.resultSection}>
          <h4>生产运行 · {execution.cases.filter((item) => item.runtimeAccepted).length}/{execution.cases.length}</h4>
          {execution.cases.map((item) => (
            <ExecutionCaseView
              key={`${item.target.kind}:${runTargetLabel(item.target)}`}
              kind={kind}
              item={item}
            />
          ))}
          <div className={`${styles.banner} ${fullExecutionReady ? styles.success : styles.warning}`}>
            <span>{execution.scope === 'targeted' ? '局部诊断结果' : fullExecutionReady ? '机械验收通过，可安装' : '机械验收未通过'}</span>
            <span>{execution.runtimeVersion} · {execution.scope === 'all' ? '全部目标' : '局部目标'}</span>
          </div>
        </section>
      ) : null}
      {!execution && dryRun?.cases?.length ? (
        <section className={styles.resultSection}>
          <h4>手工调试结果</h4>
          {dryRun.cases.map((item) => <LegacyCaseView key={item.target} kind={kind} item={item} />)}
        </section>
      ) : null}
      {!execution && dryRun && !dryRun.cases?.length ? (
        <ResultRows kind={kind} value={dryRun.result} prefix="manual" />
      ) : null}
    </div>
  )
}
