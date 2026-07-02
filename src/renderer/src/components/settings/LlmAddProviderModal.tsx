import { useState } from 'react'
import Modal from '../Modal'
import {
  LLM_PROVIDER_PROTOCOL_OPTIONS,
  normalizeCustomLlmProviderId,
  type CustomLlmProviderDefinition,
  type LlmProviderProtocol
} from '@shared/llmProviders'
import { SettingsFormField } from './SettingsPrimitives'

export default function LlmAddProviderModal({
  onClose,
  onCreate
}: {
  onClose: () => void
  onCreate: (input: CustomLlmProviderDefinition) => void
}): JSX.Element {
  const [providerId, setProviderId] = useState('')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://')
  const [protocol, setProtocol] = useState<LlmProviderProtocol>('openai-chat')

  const normalizedId = normalizeCustomLlmProviderId(providerId)

  return (
    <Modal title="添加自定义提供商" size="sm" className="modal--llm-provider" confirmText="创建" cancelText="取消" onCancel={onClose} onConfirm={() =>
        onCreate({
          id: normalizedId || providerId.trim(),
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          protocol
        })
      }>
      <div className="llm-provider-form">
        <SettingsFormField
          label="提供商 ID *"
          hint="创建后不可修改；仅小写字母、数字、连字符与下划线。"
        >
          <input
            className="text-input"
            value={providerId}
            placeholder="例如 openai-compatible"
            onChange={(e) => setProviderId(e.target.value)}
          />
        </SettingsFormField>
        <SettingsFormField label="显示名称 *">
          <input
            className="text-input"
            value={name}
            placeholder="例如 My OpenAI Proxy"
            onChange={(e) => setName(e.target.value)}
          />
        </SettingsFormField>
        <SettingsFormField label="默认 Base URL">
          <input
            className="text-input"
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </SettingsFormField>
        <SettingsFormField
          label="协议 *"
          hint={protocol === 'anthropic-messages' ? 'Anthropic 协议已支持插件开发 Agent。' : undefined}
        >
          <select className="select" value={protocol} onChange={(e) => setProtocol(e.target.value as LlmProviderProtocol)}>
            {LLM_PROVIDER_PROTOCOL_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </SettingsFormField>
      </div>
    </Modal>
  )
}
