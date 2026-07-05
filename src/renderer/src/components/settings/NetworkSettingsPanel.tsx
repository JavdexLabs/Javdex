import { SettingsCard, SettingsHeaderSwitch, SettingsStatusPill } from './SettingsPrimitives'
import SettingsInlineUrlField from './SettingsInlineUrlField'

type ProxyConfigRowProps = {
  title: string
  description: string
  savedValue: string
  enabled: boolean
  toggleBusy: boolean
  saving: boolean
  testing: boolean
  switchLabel: string
  onDraftChange: (value: string) => void
  onEnabledChange: (enabled: boolean) => void
  onSave: (value: string) => Promise<boolean>
  onTest: (value: string) => Promise<void>
}

function ProxyConfigRow({
  title,
  description,
  savedValue,
  enabled,
  toggleBusy,
  saving,
  testing,
  switchLabel,
  onDraftChange,
  onEnabledChange,
  onSave,
  onTest
}: ProxyConfigRowProps): JSX.Element {
  const configured = Boolean(savedValue.trim())
  const missing = enabled && !configured

  return (
    <section
      className={`network-proxy-row${enabled ? ' network-proxy-row--enabled' : ''}${
        missing ? ' network-proxy-row--missing' : ''
      }`}
    >
      <div className="network-proxy-row-head">
        <div className="network-proxy-row-copy">
          <div className="network-proxy-title-line">
            <h4>{title}</h4>
            <SettingsStatusPill status={enabled ? (missing ? 'warning' : 'success') : 'muted'}>
              {enabled ? (missing ? '待配置' : '已启用') : '停用'}
            </SettingsStatusPill>
            <SettingsStatusPill status={configured ? 'info' : 'muted'}>
              {configured ? '已配置地址' : '未配置地址'}
            </SettingsStatusPill>
          </div>
          <p>{description}</p>
        </div>
        <SettingsHeaderSwitch
          label={switchLabel}
          checked={enabled}
          disabled={toggleBusy}
          onChange={onEnabledChange}
        />
      </div>

      <SettingsInlineUrlField
        label="地址"
        savedValue={savedValue}
        placeholder="例如 http://127.0.0.1:7890"
        emptyHint="未配置代理地址 — 点击铅笔填写"
        saving={saving}
        testing={testing}
        missingHint={missing}
        onDraftChange={onDraftChange}
        onSave={onSave}
        onTest={onTest}
      />
    </section>
  )
}

export default function NetworkSettingsPanel({
  scrapeProxySaved,
  scrapeProxyEnabled,
  scrapeProxyToggleBusy,
  scrapeProxySaving,
  scrapeProxyTesting,
  llmProxySaved,
  llmProxyEnabled,
  llmProxyToggleBusy,
  llmProxySaving,
  llmProxyTesting,
  onScrapeProxyDraftChange,
  onLlmProxyDraftChange,
  onScrapeProxyEnabledChange,
  onLlmProxyEnabledChange,
  onSaveScrapeProxy,
  onSaveLlmProxy,
  onTestScrapeProxy,
  onTestLlmProxy
}: {
  scrapeProxySaved: string
  scrapeProxyEnabled: boolean
  scrapeProxyToggleBusy: boolean
  scrapeProxySaving: boolean
  scrapeProxyTesting: boolean
  llmProxySaved: string
  llmProxyEnabled: boolean
  llmProxyToggleBusy: boolean
  llmProxySaving: boolean
  llmProxyTesting: boolean
  onScrapeProxyDraftChange: (value: string) => void
  onLlmProxyDraftChange: (value: string) => void
  onScrapeProxyEnabledChange: (enabled: boolean) => void
  onLlmProxyEnabledChange: (enabled: boolean) => void
  onSaveScrapeProxy: (value: string) => Promise<boolean>
  onSaveLlmProxy: (value: string) => Promise<boolean>
  onTestScrapeProxy: (value: string) => Promise<void>
  onTestLlmProxy: (value: string) => Promise<void>
}): JSX.Element {
  return (
    <SettingsCard
      title="代理设置"
      hint="按用途分别配置代理。开关立即生效；地址需要保存后生效，测试连接会使用对应请求链路。"
      className="network-settings-card"
    >
      <div className="network-proxy-list">
        <ProxyConfigRow
          title="刮削代理"
          description="用于影片、演员刮削插件和浏览器验证窗口。"
          savedValue={scrapeProxySaved}
          enabled={scrapeProxyEnabled}
          toggleBusy={scrapeProxyToggleBusy}
          saving={scrapeProxySaving}
          testing={scrapeProxyTesting}
          switchLabel="启用刮削代理"
          onDraftChange={onScrapeProxyDraftChange}
          onEnabledChange={onScrapeProxyEnabledChange}
          onSave={onSaveScrapeProxy}
          onTest={onTestScrapeProxy}
        />

        <ProxyConfigRow
          title="模型代理"
          description="用于模型列表查询、测试生成和插件开发 Agent 的模型请求。"
          savedValue={llmProxySaved}
          enabled={llmProxyEnabled}
          toggleBusy={llmProxyToggleBusy}
          saving={llmProxySaving}
          testing={llmProxyTesting}
          switchLabel="启用模型代理"
          onDraftChange={onLlmProxyDraftChange}
          onEnabledChange={onLlmProxyEnabledChange}
          onSave={onSaveLlmProxy}
          onTest={onTestLlmProxy}
        />
      </div>
    </SettingsCard>
  )
}
