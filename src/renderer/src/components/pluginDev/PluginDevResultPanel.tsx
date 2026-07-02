import type {
  PluginDevDryRunCase,
  PluginDevDryRunResult,
  PluginDevFieldVerification,
  PluginDevVerificationReport
} from '@shared/types'
import { formatParseResultKeyLabel } from '@shared/scrapeFieldPromptDocs'
import type { PluginKind } from './types'

function formatResultValue(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    if (key === 'actresses') {
      return value
        .map((item) => {
          if (!item || typeof item !== 'object') return String(item)
          const name = 'name' in item ? String((item as { name?: unknown }).name ?? '') : ''
          const gender =
            'gender' in item ? String((item as { gender?: unknown }).gender ?? '') : ''
          if (!name) return JSON.stringify(item)
          return gender ? `${name} (${gender})` : name
        })
        .join('、')
    }
    if (value.every((item) => typeof item === 'string')) {
      return value.join('、')
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

function resultEntries(result: Record<string, unknown> | null): Array<{ key: string; value: string }> {
  if (!result || typeof result !== 'object') return []
  return Object.entries(result)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ({
      key,
      value: formatResultValue(key, value)
    }))
}

function splitVerificationField(field: string): { target: string; key: string } {
  const index = field.indexOf('.')
  if (index <= 0 || index >= field.length - 1) return { target: '', key: field }
  return { target: field.slice(0, index), key: field.slice(index + 1) }
}

export default function PluginDevResultPanel({
  kind,
  dryRun,
  verification,
  stale,
  installState
}: {
  kind: PluginKind
  dryRun: PluginDevDryRunResult | null
  verification: PluginDevVerificationReport | null
  stale: boolean
  installState: 'not-installed' | 'dirty' | 'synced'
}): JSX.Element {
  if (!dryRun) {
    return (
      <div className="plugin-dev-agent-empty">
        <strong>暂无调试结果</strong>
        <span>Agent 调试后，字段摘要会显示在这里。</span>
      </div>
    )
  }

  const entries =
    dryRun.result && typeof dryRun.result === 'object'
      ? resultEntries(dryRun.result as Record<string, unknown>)
      : []
  const cases = dryRun.cases ?? []
  const showSingleResult = cases.length === 0 && entries.length > 0
  const verificationGroups =
    verification?.items.reduce<Array<{ target: string; items: PluginDevFieldVerification[] }>>(
      (groups, item) => {
        const parsed = splitVerificationField(item.field)
        const target = parsed.target || '字段验证'
        const existing = groups.find((group) => group.target === target)
        const normalized = { ...item, field: parsed.key }
        if (existing) {
          existing.items.push(normalized)
        } else {
          groups.push({ target, items: [normalized] })
        }
        return groups
      },
      []
    ) ?? []
  const verificationPassedGroupCount = verificationGroups.filter((group) =>
    group.items.every((item) => item.status === 'ok')
  ).length
  const installLabel =
    installState === 'synced'
      ? '已与安装版本同步'
      : installState === 'dirty'
        ? '有未安装更改'
        : '尚未安装'

  const renderCase = (item: PluginDevDryRunCase): JSX.Element => {
    const caseEntries =
      item.result && typeof item.result === 'object'
        ? resultEntries(item.result as Record<string, unknown>)
        : []
    return (
      <details key={item.target} className="plugin-dev-details plugin-dev-result-case" open={!item.ok}>
        <summary>
          <span>{item.target}</span>
          <span className={item.ok ? 'is-ok' : 'is-fail'}>{item.ok ? '通过' : '失败'}</span>
        </summary>
        {item.error ? <p className="plugin-dev-result-case-error">{item.error}</p> : null}
        {caseEntries.length > 0 ? (
          <div className="plugin-dev-result-kv">
            {caseEntries.map((entry) => (
              <div key={`${item.target}:${entry.key}`} className="plugin-dev-result-kv-row">
                <span>{formatParseResultKeyLabel(kind, entry.key)}</span>
                <span title={entry.value}>{entry.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </details>
    )
  }

  return (
    <div className="plugin-dev-result-panel">
      <div className={`plugin-dev-install-state plugin-dev-install-state--${installState}`}>
        {installLabel}
      </div>
      {stale ? (
        <div className="plugin-dev-result-banner is-warn">
          <span>结果可能已过期</span>
          <span>当前插件内容已变化，建议重新运行 Agent 调试与验证。</span>
        </div>
      ) : null}
      {!dryRun.ok && dryRun.error ? (
        <div className="plugin-dev-result-banner is-fail">
          <span>调试失败</span>
          <span>{dryRun.error}</span>
        </div>
      ) : null}
      {cases.length > 0 ? (
        <section className="plugin-dev-result-section">
          <h4>调试结果 · {cases.filter((item) => item.ok).length}/{cases.length}</h4>
          {cases.map(renderCase)}
        </section>
      ) : null}
      {showSingleResult && (
        <div className="plugin-dev-result-kv">
          {entries.map((entry) => (
            <div key={entry.key} className="plugin-dev-result-kv-row">
              <span>{formatParseResultKeyLabel(kind, entry.key)}</span>
              <span title={entry.value}>{entry.value}</span>
            </div>
          ))}
        </div>
      )}
      {verification ? (
        <section className="plugin-dev-result-section plugin-dev-verification-section">
          <h4>
            字段验证 · {verificationPassedGroupCount}/{verificationGroups.length}
          </h4>
          {verificationGroups.map((group) => {
            const badCount = group.items.filter((item) => item.status !== 'ok').length
            return (
              <details
                key={group.target}
                className="plugin-dev-details plugin-dev-result-case plugin-dev-verification-target"
                open={badCount > 0}
              >
                <summary>
                  <span>{group.target}</span>
                  <span className={badCount === 0 ? 'is-ok' : 'is-fail'}>
                    {badCount === 0 ? '通过' : `${badCount} 项`}
                  </span>
                </summary>
                <div className="plugin-dev-verification-list">
                  {group.items.map((item) => (
                    <div
                      key={`${group.target}:${item.field}:${item.status}:${item.note}`}
                      className={`plugin-dev-verification-row is-${item.status}`}
                    >
                      <div className="plugin-dev-verification-row-head">
                        <span>{formatParseResultKeyLabel(kind, item.field)}</span>
                        <strong>{item.status}</strong>
                      </div>
                      <div className="plugin-dev-verification-compare">
                        {item.pageHint ? (
                          <span>
                            <b>应为</b>
                            {item.pageHint}
                          </span>
                        ) : null}
                        {item.actual ? (
                          <span>
                            <b>当前</b>
                            {item.actual}
                          </span>
                        ) : null}
                        <span>
                          <b>说明</b>
                          {item.note}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )
          })}
        </section>
      ) : null}
    </div>
  )
}
