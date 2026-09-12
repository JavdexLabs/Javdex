import { useMemo, useState } from 'react'
import type { ModelManagementSnapshot } from '@shared/modelManagementTypes'
import Button from '../Button'
import type { ApplyModelManagementCommand } from './ModelSettingsPanel'
import ProviderDetailModal from './ProviderDetailModal'
import styles from './ModelProvidersPanel.module.css'

function protocolLabel(value: string): string {
  return value === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI Chat Completions'
}

export default function ModelProvidersPanel({
  snapshot,
  busy,
  apply
}: {
  snapshot: ModelManagementSnapshot
  busy: boolean
  apply: ApplyModelManagementCommand
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [targetProviderId, setTargetProviderId] = useState<string | 'new' | null>(null)
  const [showAvailable, setShowAvailable] = useState(false)
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return snapshot.connections
    return snapshot.connections.filter((item) =>
      `${item.name}\0${item.providerId}\0${item.baseUrl}`.toLowerCase().includes(normalized)
    )
  }, [query, snapshot.connections])
  const configured = filtered.filter((item) => item.status === 'ready' || item.source === 'custom')
  const configuredCount = snapshot.connections.filter((item) => item.status === 'ready' || item.source === 'custom').length
  const expanded = showAvailable || configuredCount === 0 || Boolean(query.trim())
  const available = filtered.filter((item) => item.source === 'builtin' && item.status !== 'ready')

  return (
    <div className={styles.stack}>
      <section className={styles.panelCard}>
        <header className={styles.cardHeader}>
          <div>
            <h3 className={styles.sectionTitle}>提供商与模型</h3>
            <p className={styles.sectionHint}>配置连接后，再添加或发现该连接可用的生成模型。</p>
          </div>
          <div className={styles.toolbar}>
            <input
              className={`${styles.controlInput} ${styles.searchInput}`}
              type="search"
              value={query}
              aria-label="搜索提供商" placeholder="搜索提供商…"
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button size="sm" variant="primary" onClick={() => setTargetProviderId('new')}>
              添加提供商
            </Button>
          </div>
        </header>
        <div className={styles.providerList}>
          {configured.map((connection) => (
            <button
              key={connection.id}
              type="button"
              className={styles.providerRow}
              onClick={() => setTargetProviderId(connection.providerId)}
            >
              <span className={styles.providerIdentity}>
                <strong className={styles.truncate} title={connection.name}>{connection.name}</strong>
                <small className={styles.metaText}>{connection.source === 'builtin' ? '内置' : '自定义'}{connection.local ? ' · 本地' : ''}</small>
              </span>
              <span className={styles.providerMeta} title={connection.baseUrl}>
                {protocolLabel(connection.protocol)} · {connection.baseUrl}
              </span>
              <span className={styles.providerCount}>{connection.modelCount} 个模型</span>
              <span className={styles.status} data-status={connection.status}>
                {connection.status === 'ready' ? '可用' : '未配置'}
              </span>
            </button>
          ))}
          {configured.length === 0 ? <div className={styles.empty}>先选择下方提供商，或添加自定义提供商，然后配置地址和密钥。</div> : null}
        </div>
      </section>

      {available.length > 0 ? (
        <section className={styles.panelCard}>
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={expanded}
            onClick={() => setShowAvailable((value) => !value)}
          >
            <span>可添加提供商</span>
            <span>{available.length} 个 · {expanded ? '收起' : '展开'}</span>
          </button>
          {expanded ? (
            <div className={styles.availableGrid}>
              {available.map((connection) => (
                <button
                  key={connection.id}
                  type="button"
                  className={styles.availableProvider}
                  onClick={() => setTargetProviderId(connection.providerId)}
                >
                  <strong>{connection.name}</strong>
                  <span className={styles.compactMeta}>{protocolLabel(connection.protocol)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {targetProviderId ? (
        <ProviderDetailModal
          key={targetProviderId}
          providerId={targetProviderId === 'new' ? undefined : targetProviderId}
          snapshot={snapshot}
          busy={busy}
          apply={apply}
          onProviderSaved={setTargetProviderId}
          onClose={() => setTargetProviderId(null)}
        />
      ) : null}
    </div>
  )
}
