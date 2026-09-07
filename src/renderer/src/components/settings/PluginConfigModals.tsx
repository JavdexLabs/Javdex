import Switch from '../Switch'
import { useMemo, useRef, useState } from 'react'
import type {
  ActressScrapeField,
  ScraperPluginDescriptor,
  ScraperPluginUpdateInput,
  ScraperServiceConfigInput,
  ScraperServiceConnectionResult,
  ScraperServicePublicConfig,
  VideoScrapeField
} from '@shared/scrapeTypes'
import {
  ACTRESS_SCRAPE_FIELD_OPTIONS,
  ALL_ACTRESS_SCRAPE_FIELDS,
  ALL_VIDEO_SCRAPE_FIELDS,
  VIDEO_SCRAPE_FIELD_OPTIONS
} from '@shared/scrapeTypes'
import { isLoopbackScraperServiceUrl } from '@shared/scraperServiceTypes'
import Modal from '../Modal'
import ConfirmModal from '../ConfirmModal'
import { useSettingsFormGuard } from '../../settings/SettingsLeaveGuard'
import { SettingsNumberStepper } from './SettingsPrimitives'
import { defaultPluginDelay, pluginSourceLabel } from '../../settings/settingsDisplay'
import Button from '../Button'
import styles from './PluginConfigModals.module.css'

export type PluginKind = 'video' | 'actress'

export interface PluginEditState {
  kind: PluginKind
  plugin: ScraperPluginDescriptor
  serviceConfig?: ScraperServicePublicConfig
}

export interface CompositeEditState {
  kind: PluginKind
  plugin?: ScraperPluginDescriptor
}

function fieldLabel(kind: PluginKind, field: string): string {
  const options = kind === 'video' ? VIDEO_SCRAPE_FIELD_OPTIONS : ACTRESS_SCRAPE_FIELD_OPTIONS
  return options.find((option) => option.id === field)?.label ?? field
}

function allFieldsForKind(kind: PluginKind): Array<VideoScrapeField | ActressScrapeField> {
  return kind === 'video' ? ALL_VIDEO_SCRAPE_FIELDS : ALL_ACTRESS_SCRAPE_FIELDS
}

export function PluginConfigModal({
  state,
  saving = false,
  onSave,
  onTestService,
  onClearService,
  onCancel
}: {
  state: PluginEditState
  saving?: boolean
  onSave: (
    kind: PluginKind,
    name: string,
    input: ScraperPluginUpdateInput,
    serviceInput?: ScraperServiceConfigInput
  ) => void
  onTestService?: (input: ScraperServiceConfigInput) => Promise<ScraperServiceConnectionResult>
  onClearService?: () => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const { kind, plugin } = state
  const serviceConfig = state.serviceConfig
  const editableMeta = plugin.source === 'user'
  const delay = defaultPluginDelay(plugin.delay)
  const initialRef = useRef({
    description: plugin.description,
    minSeconds: Math.round(delay.minMs / 1000),
    maxSeconds: Math.round(delay.maxMs / 1000),
    serverUrl: serviceConfig?.serverUrl ?? '',
    useScrapeProxy: serviceConfig?.useScrapeProxy ?? false
  })
  const [description, setDescription] = useState(initialRef.current.description)
  const [minSeconds, setMinSeconds] = useState(initialRef.current.minSeconds)
  const [maxSeconds, setMaxSeconds] = useState(initialRef.current.maxSeconds)
  const [serverUrl, setServerUrl] = useState(initialRef.current.serverUrl)
  const [token, setToken] = useState('')
  const [clearToken, setClearToken] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [useScrapeProxy, setUseScrapeProxy] = useState(initialRef.current.useScrapeProxy)
  const [testingService, setTestingService] = useState(false)
  const [testResult, setTestResult] = useState<ScraperServiceConnectionResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<'http' | 'clear' | null>(null)
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
    const serviceDirty =
      Boolean(serviceConfig) &&
      (serverUrl !== initial.serverUrl ||
        useScrapeProxy !== initial.useScrapeProxy ||
        Boolean(token.trim()) ||
        clearToken)
    return metaDirty || delayDirty || serviceDirty
  }, [
    clearToken,
    description,
    editableMeta,
    maxSeconds,
    minSeconds,
    serverUrl,
    serviceConfig,
    token,
    useScrapeProxy
  ])

  const serviceInput = (acknowledgeInsecureHttp = false): ScraperServiceConfigInput => ({
    serverUrl,
    useScrapeProxy,
    tokenUpdate: clearToken
      ? { mode: 'clear' }
      : token.trim()
        ? { mode: 'set', value: token.trim() }
        : { mode: 'keep' },
    acknowledgeInsecureHttp
  })

  const isNonLoopbackHttp = useMemo(() => {
    try {
      return (
        new URL(serverUrl.trim()).protocol === 'http:' && !isLoopbackScraperServiceUrl(serverUrl)
      )
    } catch {
      return false
    }
  }, [serverUrl])
  const willHaveToken = !clearToken && (Boolean(token.trim()) || Boolean(serviceConfig?.hasToken))

  const testService = async (): Promise<void> => {
    if (!onTestService || testingService) return
    setTestingService(true)
    setTestError(null)
    setTestResult(null)
    try {
      setTestResult(await onTestService(serviceInput()))
    } catch (error) {
      setTestError(String((error as Error).message ?? error))
    } finally {
      setTestingService(false)
    }
  }

  const requestLeave = useSettingsFormGuard({
    label: '插件配置',
    dirty: isDirty,
    busy: saving,
    discard: () => {}
  })
  const handleCancel = (): void => requestLeave(onCancel)

  const commitSave = (acknowledgeInsecureHttp = false): void => {
    onSave(
      kind,
      plugin.name,
      {
        description: editableMeta ? description : undefined,
        delay: {
          minMs: Math.max(0, minSeconds) * 1000,
          maxMs: Math.max(minSeconds, maxSeconds) * 1000
        }
      },
      serviceConfig ? serviceInput(acknowledgeInsecureHttp) : undefined
    )
  }
  return (
    <>
      <Modal
        title={`编辑插件：${plugin.name}`}
        confirmText={saving ? '保存中…' : '保存'}
        confirmDisabled={saving}
        size="lg"
        className="modal-plugin-editor"
        busy={saving}
        onCancel={handleCancel}
        onConfirm={() => {
          if (serviceConfig && isNonLoopbackHttp && willHaveToken) setConfirmation('http')
          else commitSave()
        }}
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
                {plugin.overridesBuiltIn && (
                  <span className="plugin-config-note">覆盖内置同名插件</span>
                )}
              </div>
              {!editableMeta && (
                <p className="plugin-config-hint">
                  {plugin.requiresConfiguration
                    ? '此内置插件连接你指定的服务端；服务凭证仅由主进程安全保存。'
                    : '内置插件仅可调整访问间隔；查看或调试代码请使用卡片菜单「AI 调试」。'}
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

          {serviceConfig && (
            <section className={`plugin-config-panel ${styles.servicePanel}`}>
              <div className="plugin-config-panel-head">
                <h4 className="plugin-config-panel-title">MetaTube Server</h4>
                <span
                  className={styles.serviceStatus}
                  data-configured={Boolean(serviceConfig.serverUrl)}
                >
                  {serviceConfig.serverUrl ? '已配置' : '待配置'}
                </span>
              </div>
              <div className={styles.serviceGrid}>
                <label className={styles.fullField}>
                  <span>服务端地址</span>
                  <input
                    className="text-input"
                    value={serverUrl}
                    placeholder="http://127.0.0.1:8080"
                    disabled={saving}
                    aria-describedby="metatube-server-hint"
                    onChange={(event) => {
                      setServerUrl(event.target.value)
                      setTestResult(null)
                      setTestError(null)
                    }}
                  />
                </label>
                <p id="metatube-server-hint" className={styles.fieldHint}>
                  支持反向代理路径前缀；不提供默认公共服务。
                </p>

                <label className={styles.fullField}>
                  <span>访问令牌（可选）</span>
                  <div className={styles.tokenRow}>
                    <input
                      className="text-input"
                      type={showToken ? 'text' : 'password'}
                      value={token}
                      placeholder={
                        serviceConfig.hasToken ? '留空保留已保存令牌' : '服务端未启用 Token 时留空'
                      }
                      disabled={saving || clearToken}
                      autoComplete="new-password"
                      onChange={(event) => {
                        setToken(event.target.value)
                        setClearToken(false)
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={saving}
                      aria-pressed={showToken}
                      onClick={() => setShowToken((value) => !value)}
                    >
                      {showToken ? '隐藏' : '显示'}
                    </Button>
                  </div>
                </label>
                <div className={styles.tokenMeta}>
                  <span>
                    {clearToken
                      ? '保存后清除令牌'
                      : serviceConfig.hasToken
                        ? '已安全保存令牌'
                        : '未保存令牌'}
                  </span>
                  {serviceConfig.hasToken && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={saving}
                      onClick={() => {
                        setToken('')
                        setClearToken((value) => !value)
                      }}
                    >
                      {clearToken ? '撤销清除' : '清除令牌'}
                    </Button>
                  )}
                </div>

                <label className={styles.checkboxField}>
                  <Switch
                    checked={useScrapeProxy}
                    disabled={saving}
                    onChange={(event) => setUseScrapeProxy(event.target.checked)}
                  />
                  <span>使用 Javdex 刮削代理连接此服务</span>
                </label>
              </div>

              {serviceConfig.secretProtection !== 'secure' && (
                <p className={styles.warning} role="status">
                  {serviceConfig.secretProtection === 'degraded'
                    ? '当前凭证存储后端的保护强度较低。'
                    : '当前系统没有可用的凭证存储；不能保存新令牌。'}
                </p>
              )}
              {isNonLoopbackHttp && (
                <p className={styles.warning} role="status">
                  HTTP 可能暴露查询番号{willHaveToken ? '和访问令牌' : ''}；远程服务建议使用 HTTPS。
                </p>
              )}
              {testError && (
                <p className={styles.error} role="alert">
                  {testError}
                </p>
              )}
              {testResult && (
                <p className={styles.success} role="status">
                  连接成功 · {testResult.version} · DB {testResult.dbVersion} ·{' '}
                  {testResult.movieProviderCount} 个影片源
                </p>
              )}
              <div className={styles.serviceActions}>
                {serviceConfig.serverUrl && onClearService && (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={saving || testingService}
                    onClick={() => {
                      setConfirmation('clear')
                    }}
                  >
                    清除配置
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  disabled={saving || testingService || !serverUrl.trim()}
                  onClick={() => void testService()}
                >
                  {testingService ? '测试中…' : '测试连接'}
                </Button>
              </div>
            </section>
          )}

          <section className="plugin-config-panel plugin-config-panel--accent">
            <div className="plugin-config-panel-head">
              <h4 className="plugin-config-panel-title">访问间隔</h4>
              <span className="plugin-config-panel-caption">批量刮削时按站点独立计算</span>
            </div>
            <div className="plugin-config-delay">
              <label className="plugin-config-delay-field">
                <span>最小</span>
                <SettingsNumberStepper
                  aria-label="最小访问间隔（秒）"
                  value={minSeconds}
                  min={0}
                  max={600}
                  step={1}
                  unit="秒"
                  disabled={saving}
                  onChange={(next) => {
                    setMinSeconds(next)
                    if (next > maxSeconds) setMaxSeconds(next)
                  }}
                />
              </label>
              <span className="plugin-config-delay-sep" aria-hidden>
                —
              </span>
              <label className="plugin-config-delay-field">
                <span>最大</span>
                <SettingsNumberStepper
                  aria-label="最大访问间隔（秒）"
                  value={maxSeconds}
                  min={0}
                  max={600}
                  step={1}
                  unit="秒"
                  disabled={saving}
                  onChange={(next) => setMaxSeconds(Math.max(next, minSeconds))}
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
      {confirmation ? (
        <ConfirmModal
          title={confirmation === 'http' ? '通过 HTTP 保存服务连接' : '清除服务配置'}
          confirmText={confirmation === 'http' ? '仍要保存' : '清除配置'}
          danger
          busy={saving}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            if (confirmation === 'http') commitSave(true)
            else void onClearService?.()
            setConfirmation(null)
          }}
        >
          <p>
            {confirmation === 'http'
              ? '当前服务使用非本机 HTTP，访问令牌和查询番号会以明文传输。是否继续？'
              : '将清除 MetaTube 服务端地址和已保存令牌，之后需要重新配置才能使用。'}
          </p>
        </ConfirmModal>
      ) : null}
    </>
  )
}

export { default as CompositeConfigModal } from './CompositeConfigModal'
