import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronUp, Circle, Plug, Plus, Search } from 'lucide-react'
import type { ModelManagementSnapshot } from '@shared/modelManagementTypes'
import lmstudio from '../../assets/providers/lmstudio.png'
import deepseek from '../../assets/providers/deepseek.png'
import minimax from '../../assets/providers/minimax.svg'
import ollama from '../../assets/providers/ollama.png'
import openai from '../../assets/providers/openai.svg'
import openrouter from '../../assets/providers/openrouter.png'
import moonshot from '../../assets/providers/moonshot.svg'
import zhipu from '../../assets/providers/zhipu.png'
import siliconflow from '../../assets/providers/siliconflow.png'
import anthropic from '../../assets/providers/anthropic.png'
import bailian from '../../assets/providers/bailian.png'
import gemini from '../../assets/providers/gemini.png'
import Button from '../Button'
import type { ApplyModelManagementCommand } from './ModelSettingsPanel'
import ProviderDetailModal from './ProviderDetailModal'
import styles from './ModelProvidersPanel.module.css'

const providerLogos: Record<string, string> = {
  lmstudio, deepseek, minimax, ollama, openai, openrouter, moonshot, zhipu, siliconflow, anthropic,
  bailian, gemini
}

type Connection = ModelManagementSnapshot['connections'][number]

function ProviderLogo({ connection, compact = false }: { connection: Connection; compact?: boolean }): JSX.Element {
  const logo = connection.source === 'builtin' ? providerLogos[connection.providerId] : undefined
  return (
    <span className={`${styles.logo}${compact ? ` ${styles.compactLogo}` : ''}`} aria-hidden="true">
      {logo ? (
        ['anthropic', 'openrouter', 'moonshot', 'openai'].includes(connection.providerId)
          ? <span className={styles.monochromeLogo} style={{ maskImage: `url("${logo}")` }} />
          : <img src={logo} alt="" draggable={false} />
      ) : <Plug size={24} />}
    </span>
  )
}

function providerDescription(connection: Connection): string {
  if (connection.local) return '本地模型服务'
  if (connection.providerId === 'openrouter' || connection.providerId === 'siliconflow') return '多模型聚合服务'
  return '云端模型服务'
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
            <p className={styles.sectionHint}>配置连接，管理可用模型。</p>
          </div>
          <div className={styles.toolbar}>
            <label className={styles.searchField}>
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                value={query}
                aria-label="搜索提供商" placeholder="搜索提供商…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <Button size="sm" variant="primary" onClick={() => setTargetProviderId('new')}>
              <Plus size={14} aria-hidden="true" /> 添加提供商
            </Button>
          </div>
        </header>
        <div className={styles.providerList}>
          {configured.map((connection) => (
            <button
              key={connection.id}
              type="button"
              className={styles.providerRow}
              aria-label={`${connection.name}，${connection.modelCount} 个模型，${connection.status === 'ready' ? '已配置' : '未配置'}，查看配置`}
              onClick={() => setTargetProviderId(connection.providerId)}
            >
              <ProviderLogo connection={connection} />
              <span className={styles.providerIdentity}>
                <span className={styles.nameLine}>
                  <strong className={`${styles.providerName} ${styles.truncate}`} title={connection.name}>{connection.name}</strong>
                  {connection.source === 'custom' ? <small className={styles.badge}>自定义</small> : null}
                  {connection.local ? <small className={styles.badge}>本地</small> : null}
                </span>
                <span className={styles.providerAddress} title={connection.baseUrl}>{connection.baseUrl || '尚未设置服务地址'}</span>
              </span>
              <span className={styles.rowSummary}>
                <span className={styles.providerCount}>{connection.modelCount} 个模型</span>
                <span className={styles.status} data-status={connection.status}>
                  <Circle size={6} fill="currentColor" aria-hidden="true" />
                  {connection.status === 'ready' ? '已配置' : '未配置'}
                </span>
              </span>
              <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
            </button>
          ))}
          {configured.length === 0 ? <div className={styles.empty}>{query.trim() ? '未找到匹配的已配置提供商。' : '先选择下方提供商，或添加自定义提供商，然后配置地址和密钥。'}</div> : null}
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
            <span className={styles.disclosureTitle}>可添加提供商</span>
            <span className={styles.disclosureMeta}>{available.length} 个 {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}</span>
          </button>
          {expanded ? (
            <div className={styles.availableGrid}>
              {available.map((connection) => (
                <button
                  key={connection.id}
                  type="button"
                  className={styles.availableProvider}
                  aria-label={`添加 ${connection.name}`}
                  onClick={() => setTargetProviderId(connection.providerId)}
                >
                  <ProviderLogo connection={connection} compact />
                  <span className={styles.availableIdentity}>
                    <strong className={`${styles.providerName} ${styles.truncate}`} title={connection.name}>{connection.name}</strong>
                    <span className={styles.compactMeta}>{providerDescription(connection)}</span>
                  </span>
                  <span className={styles.addIcon}><Plus size={16} aria-hidden="true" /></span>
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
