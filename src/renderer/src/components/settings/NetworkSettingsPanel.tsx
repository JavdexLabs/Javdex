import { SettingsCard, SettingsHeaderSwitch } from './SettingsPrimitives'
import SettingsInlineUrlField from './SettingsInlineUrlField'

export default function NetworkSettingsPanel({
  scrapeProxySaved,
  scrapeProxyEnabled,
  scrapeProxyToggleBusy,
  scrapeProxySaving,
  llmProxySaved,
  llmProxyEnabled,
  llmProxyToggleBusy,
  llmProxySaving,
  onScrapeProxyDraftChange,
  onLlmProxyDraftChange,
  onScrapeProxyEnabledChange,
  onLlmProxyEnabledChange,
  onSaveScrapeProxy,
  onSaveLlmProxy
}: {
  scrapeProxySaved: string
  scrapeProxyEnabled: boolean
  scrapeProxyToggleBusy: boolean
  scrapeProxySaving: boolean
  llmProxySaved: string
  llmProxyEnabled: boolean
  llmProxyToggleBusy: boolean
  llmProxySaving: boolean
  onScrapeProxyDraftChange: (value: string) => void
  onLlmProxyDraftChange: (value: string) => void
  onScrapeProxyEnabledChange: (enabled: boolean) => void
  onLlmProxyEnabledChange: (enabled: boolean) => void
  onSaveScrapeProxy: (value: string) => Promise<boolean>
  onSaveLlmProxy: (value: string) => Promise<boolean>
}): JSX.Element {
  return (
    <>
      <SettingsCard
        title="刮削代理"
        hint="开关立即生效。点击地址栏右侧铅笔编辑，确认后保存；关闭开关时直连，地址会保留。"
        actions={
          <SettingsHeaderSwitch
            label="启用刮削代理"
            checked={scrapeProxyEnabled}
            disabled={scrapeProxyToggleBusy}
            onChange={onScrapeProxyEnabledChange}
          />
        }
      >
        <SettingsInlineUrlField
          label="代理地址"
          savedValue={scrapeProxySaved}
          placeholder="例如 http://127.0.0.1:7890"
          emptyHint="未配置代理地址 — 点击铅笔填写"
          saving={scrapeProxySaving}
          missingHint={scrapeProxyEnabled && !scrapeProxySaved.trim()}
          onDraftChange={onScrapeProxyDraftChange}
          onSave={onSaveScrapeProxy}
        />
      </SettingsCard>

      <SettingsCard
        title="模型代理"
        hint="开关立即生效。点击地址栏右侧铅笔编辑，确认后保存；关闭开关时直连，地址会保留。"
        actions={
          <SettingsHeaderSwitch
            label="启用模型代理"
            checked={llmProxyEnabled}
            disabled={llmProxyToggleBusy}
            onChange={onLlmProxyEnabledChange}
          />
        }
      >
        <SettingsInlineUrlField
          label="代理地址"
          savedValue={llmProxySaved}
          placeholder="例如 http://127.0.0.1:7890"
          emptyHint="未配置代理地址 — 点击铅笔填写"
          saving={llmProxySaving}
          missingHint={llmProxyEnabled && !llmProxySaved.trim()}
          onDraftChange={onLlmProxyDraftChange}
          onSave={onSaveLlmProxy}
        />
      </SettingsCard>
    </>
  )
}
