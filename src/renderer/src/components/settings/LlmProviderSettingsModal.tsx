import { useState } from 'react'
import Modal from '../Modal'
import type { LlmProviderUserConfig, LlmProviderViewModel } from '@shared/llmProviders'
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
  onSave: (input: { providerId: string; apiKey: string; baseUrl: string }) => void
  onDelete?: () => void
}): JSX.Element {
  const [apiKey, setApiKey] = useState(userConfig?.apiKey ?? '')
  const [baseUrl, setBaseUrl] = useState(userConfig?.baseUrl ?? '')

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
          baseUrl
        })
      }
    >
      <div className="llm-provider-form">
        <div className="llm-provider-form-readonly">
          <span>协议</span>
          <strong>{provider.protocol === 'openai-chat' ? 'OpenAI 兼容' : 'Anthropic Messages'}</strong>
        </div>
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
