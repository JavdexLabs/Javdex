import { useState } from 'react'
import Modal from '../Modal'
import {
  LLM_PROVIDER_PROTOCOL_OPTIONS,
  getLlmProtocolLabel,
  type LlmProviderProtocol,
  type LlmProviderUserConfig,
  type LlmProviderViewModel
} from '@shared/llmProviders'
import SelectControl from '../SelectControl'
import { SettingsFormField } from './SettingsPrimitives'

export default function LlmProviderSettingsModal({
  provider,
  userConfig,
  onClose,
  onSave,
  onDelete
}: {
  provider: LlmProviderViewModel
  userConfig?: LlmProviderUserConfig
  onClose: () => void
  onSave: (input: { providerId: string; apiKey: string; baseUrl: string; protocol: LlmProviderProtocol }) => void
  onDelete?: () => void
}): JSX.Element {
  const [apiKey, setApiKey] = useState(userConfig?.apiKey ?? '')
  const [baseUrl, setBaseUrl] = useState(userConfig?.baseUrl ?? '')
  const [protocol, setProtocol] = useState<LlmProviderProtocol>(userConfig?.protocol ?? provider.protocol)

  return (
    <Modal
      title={`${provider.name} — 设置`}
      size="sm"
      className="modal--llm-provider"
      confirmText="保存"
      cancelText="取消"
      onCancel={onClose}
      onConfirm={() =>
        onSave({
          providerId: provider.id,
          apiKey,
          baseUrl,
          protocol
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
              placeholder="sk-..."
              onChange={(e) => setApiKey(e.target.value)}
            />
          </SettingsFormField>
        )}
        {onDelete && (
          <div className="llm-provider-form-danger">
            <button type="button" className="btn btn-sm btn-danger" onClick={onDelete}>
              删除自定义供应商
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
