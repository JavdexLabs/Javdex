import { useState } from 'react'
import Modal from '../Modal'
import {
  LLM_PROVIDER_PROTOCOL_OPTIONS,
  getLlmProtocolLabel,
  type LlmProviderConfigSaveInput,
  type LlmProviderPublicConfig,
  type LlmProviderProtocol,
  type LlmProviderViewModel
} from '@shared/llmProviders'
import SelectControl from '../SelectControl'
import { SettingsFormField } from './SettingsPrimitives'
import Button from '../Button'

export default function LlmProviderSettingsModal({
  provider,
  userConfig,
  onClose,
  onSave,
  onDelete,
  busy = false
}: {
  provider: LlmProviderViewModel
  userConfig?: LlmProviderPublicConfig
  onClose: () => void
  onSave: (input: LlmProviderConfigSaveInput) => void
  onDelete?: () => void
  busy?: boolean
}): JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [clearSavedApiKey, setClearSavedApiKey] = useState(false)
  const [baseUrl, setBaseUrl] = useState(userConfig?.baseUrl ?? '')
  const [protocol, setProtocol] = useState<LlmProviderProtocol>(userConfig?.protocol ?? provider.protocol)

  return (
    <Modal
      title={`${provider.name} — 设置`}

      size="sm"
      className="modal--llm-provider"
      confirmText="保存"
      cancelText="取消"
      busy={busy}
      onCancel={onClose}
      onConfirm={() =>
        onSave({
          providerId: provider.id,
          baseUrl,
          protocol,
          apiKeyAction: clearSavedApiKey ? 'clear' : apiKey.trim() ? 'replace' : 'keep',
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
        })
      }
    >
      <div className="llm-provider-form">
        <SettingsFormField
          label="接口协议"
          hint={`当前请求格式：${getLlmProtocolLabel(protocol)}。影响模型查询、测试生成和实际调用。`}
        >
          <SelectControl
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as LlmProviderProtocol)}
          >
            {LLM_PROVIDER_PROTOCOL_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </SelectControl>
        </SettingsFormField>
        <SettingsFormField label="Base URL 覆盖" hint={`留空则使用默认地址：${provider.baseUrl}`}>
          <input
            className="text-input"
            value={baseUrl}
            placeholder={provider.baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </SettingsFormField>
        {!provider.local && (
          <SettingsFormField label="API Key">
            <input
              className="text-input"
              type="password"
              value={apiKey}
              disabled={clearSavedApiKey || busy}
              placeholder={userConfig?.hasApiKey ? '已安全保存，留空则保持不变' : 'sk-...'}
              onChange={(e) => {
                setApiKey(e.target.value)
                setClearSavedApiKey(false)
              }}
            />
            {userConfig?.hasApiKey && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setClearSavedApiKey((current) => !current)
                  setApiKey('')
                }}
              >
                {clearSavedApiKey ? '保留已保存密钥' : '移除已保存密钥'}
              </Button>
            )}
          </SettingsFormField>
        )}
        {onDelete && (
          <div className="llm-provider-form-danger">
            <Button type="button" variant="danger" size="sm" disabled={busy} onClick={onDelete}>
              删除自定义供应商
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}
