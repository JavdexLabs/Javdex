import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { AppSettings } from '@shared/types'
import {
  buildLlmProviderViewModels,
  findLlmProviderViewModel,
  getLlmProtocolLabel,
  inferLlmModelKind,
  isReservedLlmProviderId,
  isValidCustomLlmProviderId,
  listAgentCompatibleProviders,
  listModelsForProvider,
  maskLlmApiKey,
  normalizeCustomLlmProviderId,
  type CustomLlmProviderDefinition,
  type LlmProviderProtocol,
  type LlmProviderViewModel
} from '@shared/llmProviders'
import { api } from '../../api'
import { useDismissOverlaysOnNavigate } from '../../hooks/useDismissOverlaysOnNavigate'
import SelectControl from '../SelectControl'
import { useToast } from '../Toast'
import LlmAddProviderModal from './LlmAddProviderModal'
import LlmProviderModelsModal from './LlmProviderModelsModal'
import LlmProviderSettingsModal from './LlmProviderSettingsModal'
import { SettingsCard, SettingsFormField } from './SettingsPrimitives'

function providerStatusLabel(status: LlmProviderViewModel['status']): string {
  if (status === 'ready') return '可用'
  if (status === 'unsupported') return '不可用'
  return '未配置'
}

export default function ModelSettingsPanel({
  settings,
  onSettingsChange
}: {
  settings: AppSettings
  onSettingsChange: (next: AppSettings) => void
}): JSX.Element {
  const toast = useToast()
  const location = useLocation()
  const providers = useMemo(() => buildLlmProviderViewModels(settings), [settings])
  const readyAgentProviders = useMemo(
    () => listAgentCompatibleProviders(settings).filter((provider) => provider.status === 'ready'),
    [settings]
  )

  const [providerQuery, setProviderQuery] = useState('')
  const [defaultProviderId, setDefaultProviderId] = useState(settings.defaultLlmProviderId)
  const [defaultModelId, setDefaultModelId] = useState(settings.defaultLlmModelId)
  const [defaultSaving, setDefaultSaving] = useState(false)

  const [settingsTarget, setSettingsTarget] = useState<LlmProviderViewModel | null>(null)
  const [modelsTarget, setModelsTarget] = useState<LlmProviderViewModel | null>(null)
  const [showAddProvider, setShowAddProvider] = useState(false)

  const dismissOverlays = useCallback(() => {
    setSettingsTarget(null)
    setModelsTarget(null)
    setShowAddProvider(false)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

  useEffect(() => {
    setDefaultProviderId(settings.defaultLlmProviderId)
    setDefaultModelId(settings.defaultLlmModelId)
  }, [settings.defaultLlmModelId, settings.defaultLlmProviderId])

  const defaultDirty =
    defaultProviderId !== settings.defaultLlmProviderId ||
    defaultModelId !== settings.defaultLlmModelId

  const defaultModels = useMemo(
    () => listModelsForProvider(defaultProviderId, settings.llmCustomModels),
    [defaultProviderId, settings.llmCustomModels]
  )

  const filteredProviders = useMemo(() => {
    const q = providerQuery.trim().toLowerCase()
    if (!q) return providers
    return providers.filter(
      (provider) =>
        provider.name.toLowerCase().includes(q) ||
        provider.id.toLowerCase().includes(q) ||
        provider.baseUrl.toLowerCase().includes(q)
    )
  }, [providerQuery, providers])

  const saveDefaultLlm = async (): Promise<void> => {
    if (!defaultDirty || defaultSaving) return
    const provider = findLlmProviderViewModel(settings, defaultProviderId)
    if (!provider?.agentCompatible) {
      toast.show('请选择支持 Agent 的供应商', 'error')
      return
    }
    if (provider.status === 'unconfigured') {
      const hint =
        provider.local && provider.modelCount === 0
          ? '添加至少一个模型'
          : provider.local
            ? '完成配置'
            : '配置 API Key'
      toast.show(`请先为「${provider.name}」${hint}`, 'error')
      return
    }
    setDefaultSaving(true)
    try {
      const next = await api.settings.update({
        defaultLlmProviderId: defaultProviderId,
        defaultLlmModelId: defaultModelId
      })
      onSettingsChange(next)
      toast.show('默认模型已保存', 'success')
    } catch (err) {
      toast.show(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setDefaultSaving(false)
    }
  }

  const saveProviderConfig = async (input: {
    providerId: string
    apiKey: string
    baseUrl: string
    protocol: LlmProviderProtocol
  }): Promise<void> => {
    const configs = { ...settings.llmProviderConfigs }
    const nextConfig = {
      ...(input.apiKey.trim() ? { apiKey: input.apiKey.trim() } : {}),
      ...(input.baseUrl.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
      protocol: input.protocol
    }
    if (Object.keys(nextConfig).length === 0) {
      delete configs[input.providerId]
    } else {
      configs[input.providerId] = nextConfig
    }
    const next = await api.settings.update({ llmProviderConfigs: configs })
    onSettingsChange(next)
    setSettingsTarget(null)
    toast.show('供应商设置已保存', 'success')
  }

  const deleteCustomProvider = async (providerId: string): Promise<void> => {
    const customLlmProviders = settings.customLlmProviders.filter((item) => item.id !== providerId)
    const llmProviderConfigs = { ...settings.llmProviderConfigs }
    delete llmProviderConfigs[providerId]
    const llmCustomModels = settings.llmCustomModels.filter((item) => item.providerId !== providerId)
    let defaultLlmProviderId = settings.defaultLlmProviderId
    let defaultLlmModelId = settings.defaultLlmModelId
    if (defaultLlmProviderId === providerId) {
      defaultLlmProviderId = 'deepseek'
      defaultLlmModelId = 'deepseek-v4-flash'
      setDefaultProviderId(defaultLlmProviderId)
      setDefaultModelId(defaultLlmModelId)
    }
    const next = await api.settings.update({
      customLlmProviders,
      llmProviderConfigs,
      llmCustomModels,
      defaultLlmProviderId,
      defaultLlmModelId
    })
    onSettingsChange(next)
    setSettingsTarget(null)
    toast.show('自定义供应商已删除', 'success')
  }

  const addCustomProvider = async (input: CustomLlmProviderDefinition): Promise<void> => {
    const id = normalizeCustomLlmProviderId(input.id)
    if (!isValidCustomLlmProviderId(id)) {
      toast.show('供应商 ID 格式无效', 'error')
      return
    }
    if (isReservedLlmProviderId(id) || settings.customLlmProviders.some((item) => item.id === id)) {
      toast.show('供应商 ID 已存在', 'error')
      return
    }
    const next = await api.settings.update({
      customLlmProviders: [...settings.customLlmProviders, { ...input, id }].sort((a, b) =>
        a.name.localeCompare(b.name, 'zh-CN')
      )
    })
    onSettingsChange(next)
    setShowAddProvider(false)
    toast.show('自定义供应商已创建', 'success')
  }

  const addCustomModel = async (providerId: string, modelId: string, modelName: string): Promise<void> => {
    const id = modelId.trim()
    const name = modelName.trim() || id
    if (!id) {
      toast.show('请填写模型 ID', 'error')
      return
    }
    if (inferLlmModelKind({ id, name }) !== 'chat') {
      toast.show('嵌入模型不能作为默认生成模型使用', 'error')
      return
    }
    const existing = listModelsForProvider(providerId, settings.llmCustomModels)
    if (existing.some((model) => model.id === id)) {
      toast.show('模型 ID 已存在', 'error')
      return
    }
    const next = await api.settings.update({
      llmCustomModels: [...settings.llmCustomModels, { providerId, id, name }]
    })
    onSettingsChange(next)
    toast.show('模型已添加', 'success')
  }

  const removeCustomModel = async (providerId: string, modelId: string): Promise<void> => {
    const next = await api.settings.update({
      llmCustomModels: settings.llmCustomModels.filter(
        (item) => !(item.providerId === providerId && item.id === modelId)
      )
    })
    onSettingsChange(next)
    if (settings.defaultLlmProviderId === providerId && settings.defaultLlmModelId === modelId) {
      const models = listModelsForProvider(providerId, next.llmCustomModels)
      if (models[0]) {
        const updated = await api.settings.update({ defaultLlmModelId: models[0].id })
        onSettingsChange(updated)
        setDefaultModelId(models[0].id)
      }
    }
    toast.show('自定义模型已删除', 'success')
  }

  return (
    <>
      <SettingsCard
        className="settings-card--llm-default"
        title="默认 LLM"
        hint="设置应用默认使用的模型；插件开发 Agent 会优先使用该配置。"
        actions={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!defaultDirty || defaultSaving}
            onClick={() => void saveDefaultLlm()}
          >
            {defaultSaving ? '保存中…' : defaultDirty ? '保存' : '已保存'}
          </button>
        }
      >
        <div className="llm-default-form">
          <SettingsFormField label="提供商">
            <SelectControl
              value={
                readyAgentProviders.some((provider) => provider.id === defaultProviderId)
                  ? defaultProviderId
                  : ''
              }
              disabled={readyAgentProviders.length === 0}
              onChange={(e) => {
                const providerId = e.target.value
                if (!providerId) return
                setDefaultProviderId(providerId)
                const models = listModelsForProvider(providerId, settings.llmCustomModels)
                setDefaultModelId(models[0]?.id ?? '')
              }}
            >
              {readyAgentProviders.length === 0 ? (
                <option value="">暂无可用提供商</option>
              ) : (
                readyAgentProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))
              )}
            </SelectControl>
          </SettingsFormField>
          <SettingsFormField label="模型">
            <SelectControl
              value={defaultModelId}
              onChange={(e) => setDefaultModelId(e.target.value)}
            >
              {defaultModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} ({model.id})
                </option>
              ))}
            </SelectControl>
          </SettingsFormField>
        </div>
      </SettingsCard>

      <SettingsCard
        className="settings-card--llm-providers"
        title="提供商"
        hint="内置主流模型供应商，也可添加 OpenAI 兼容或 Anthropic 协议的自定义端点。"
        actions={
          <div className="llm-provider-toolbar">
            <input
              className="text-input llm-provider-search"
              type="search"
              value={providerQuery}
              placeholder="搜索提供商…"
              onChange={(e) => setProviderQuery(e.target.value)}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowAddProvider(true)}>
              添加提供商
            </button>
          </div>
        }
      >

        <div className="llm-provider-grid">
          {filteredProviders.map((provider) => (
            <article
              key={provider.id}
              className={`llm-provider-card${
                provider.status === 'ready' ? ' llm-provider-card--ready' : ''
              }${provider.status === 'unsupported' ? ' llm-provider-card--unsupported' : ''}${
                settings.defaultLlmProviderId === provider.id ? ' llm-provider-card--default' : ''
              }`}
            >
              <header className="llm-provider-card-head">
                <div>
                  <strong>{provider.name}</strong>
                  <span className="llm-provider-card-tag">
                    {provider.source === 'builtin' ? '内置' : '自定义'}
                    {provider.local ? ' · 本地' : ''}
                    {settings.defaultLlmProviderId === provider.id ? ' · 默认' : ''}
                  </span>
                </div>
                <span className={`llm-provider-status llm-provider-status--${provider.status}`}>
                  {providerStatusLabel(provider.status)}
                </span>
              </header>
              <dl className="llm-provider-card-meta">
                <div>
                  <dt>协议</dt>
                  <dd>{getLlmProtocolLabel(provider.protocol)}</dd>
                </div>
                <div>
                  <dt>模型</dt>
                  <dd>{provider.modelCount} 个</dd>
                </div>
                <div>
                  <dt>密钥</dt>
                  <dd>{provider.local ? '无需' : maskLlmApiKey(provider.apiKey)}</dd>
                </div>
                <div>
                  <dt>Base URL</dt>
                  <dd title={provider.baseUrl}>{provider.baseUrl}</dd>
                </div>
              </dl>
              <footer className="llm-provider-card-actions">
                <button type="button" className="btn btn-sm" onClick={() => setModelsTarget(provider)}>
                  模型
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setSettingsTarget(provider)}>
                  设置
                </button>
              </footer>
            </article>
          ))}
        </div>
      </SettingsCard>

      {showAddProvider && (
        <LlmAddProviderModal onClose={() => setShowAddProvider(false)} onCreate={(input) => void addCustomProvider(input)} />
      )}

      {settingsTarget && (
        <LlmProviderSettingsModal
          provider={settingsTarget}
          userConfig={settings.llmProviderConfigs[settingsTarget.id]}
          onClose={() => setSettingsTarget(null)}
          onSave={(input) => void saveProviderConfig(input)}
          onDelete={
            settingsTarget.source === 'custom'
              ? () => void deleteCustomProvider(settingsTarget.id)
              : undefined
          }
        />
      )}

      {modelsTarget && (
        <LlmProviderModelsModal
          provider={modelsTarget}
          customModels={settings.llmCustomModels}
          onClose={() => setModelsTarget(null)}
          onAdd={(modelId, modelName) => void addCustomModel(modelsTarget.id, modelId, modelName)}
          onRemove={(modelId) => void removeCustomModel(modelsTarget.id, modelId)}
        />
      )}
    </>
  )
}
