import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { SettingsSnapshot } from '@shared/settingsTypes'
import {
  buildLlmProviderViewModels,
  findLlmProviderViewModel,
  getLlmProtocolLabel,
  inferLlmModelKind,
  isReservedLlmProviderId,
  isValidCustomLlmProviderId,
  listAgentCompatibleProviders,
  listModelsForProvider,
  normalizeCustomLlmProviderId,
  normalizeDefaultLlmSelection,
  type CustomLlmProviderDefinition,
  type LlmProviderConfigSaveInput,
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
import Button from '../Button'
import useAsyncMutation from '../../hooks/useAsyncMutation'

function providerStatusLabel(status: LlmProviderViewModel['status']): string {
  if (status === 'ready') return '可用'
  if (status === 'unsupported') return '不可用'
  return '未配置'
}

export default function ModelSettingsPanel({
  settings,
  onSettingsChange
}: {
  settings: SettingsSnapshot
  onSettingsChange: (next: SettingsSnapshot) => void
}): JSX.Element {
  const toast = useToast()
  const location = useLocation()
  const providers = useMemo(() => buildLlmProviderViewModels(settings), [settings])
  const readyAgentProviders = useMemo(
    () => listAgentCompatibleProviders(settings).filter((provider) => provider.status === 'ready'),
    [settings]
  )

  const savedDefault = useMemo(() => normalizeDefaultLlmSelection(settings), [settings])

  const [providerQuery, setProviderQuery] = useState('')
  const [defaultProviderId, setDefaultProviderId] = useState(savedDefault.providerId)
  const [defaultModelId, setDefaultModelId] = useState(savedDefault.modelId)
  const { isBusy, run: runMutation } = useAsyncMutation((message) =>
    toast.show(message, 'error')
  )
  const settingsMutationBusy = isBusy('llm-settings')

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
    setDefaultProviderId(savedDefault.providerId)
    setDefaultModelId(savedDefault.modelId)
  }, [savedDefault.modelId, savedDefault.providerId])

  const defaultDirty =
    defaultProviderId !== savedDefault.providerId || defaultModelId !== savedDefault.modelId

  const defaultModels = useMemo(() => {
    if (!defaultProviderId) return []
    const provider = findLlmProviderViewModel(settings, defaultProviderId)
    if (!provider || provider.status !== 'ready') return []
    return listModelsForProvider(defaultProviderId, settings.llmCustomModels)
  }, [defaultProviderId, settings])

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
    if (!defaultDirty || settingsMutationBusy) return
    if (!defaultProviderId.trim() || !defaultModelId.trim()) {
      toast.show('请先配置并选择可用的提供商与模型', 'error')
      return
    }
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
    const result = await runMutation(
      'llm-settings',
      () => api.settings.update({
        defaultLlmProviderId: defaultProviderId,
        defaultLlmModelId: defaultModelId
      }),
      '保存默认模型失败'
    )
    if (!result.ok) return
    onSettingsChange(result.value)
    toast.show('默认模型已保存', 'success')
  }

  const saveProviderConfig = async (input: LlmProviderConfigSaveInput): Promise<void> => {
    const result = await runMutation(
      'llm-settings',
      () => api.settings.saveLlmProviderConfig(input),
      '保存供应商设置失败'
    )
    if (!result.ok) return
    onSettingsChange(result.value)
    setSettingsTarget(null)
    toast.show('供应商设置已保存', 'success')
  }

  const deleteCustomProvider = async (providerId: string): Promise<void> => {
    const result = await runMutation(
      'llm-settings',
      () => api.settings.deleteLlmProvider(providerId),
      '删除供应商失败'
    )
    if (!result.ok) return
    const selection = normalizeDefaultLlmSelection(result.value)
    setDefaultProviderId(selection.providerId)
    setDefaultModelId(selection.modelId)
    onSettingsChange(result.value)
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
    const result = await runMutation(
      'llm-settings',
      () => api.settings.update({
        customLlmProviders: [...settings.customLlmProviders, { ...input, id }].sort((a, b) =>
          a.name.localeCompare(b.name, 'zh-CN')
        )
      }),
      '创建自定义供应商失败'
    )
    if (!result.ok) return
    onSettingsChange(result.value)
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
    const result = await runMutation(
      'llm-settings',
      () => api.settings.update({
        llmCustomModels: [...settings.llmCustomModels, { providerId, id, name }]
      }),
      '添加模型失败'
    )
    if (!result.ok) return
    onSettingsChange(result.value)
    toast.show('模型已添加', 'success')
  }

  const removeCustomModel = async (providerId: string, modelId: string): Promise<void> => {
    const llmCustomModels = settings.llmCustomModels.filter(
      (item) => !(item.providerId === providerId && item.id === modelId)
    )
    const removesDefault =
      settings.defaultLlmProviderId === providerId && settings.defaultLlmModelId === modelId
    const nextDefaultModelId = removesDefault
      ? listModelsForProvider(providerId, llmCustomModels)[0]?.id ?? ''
      : settings.defaultLlmModelId
    const result = await runMutation(
      'llm-settings',
      () => api.settings.update({
        llmCustomModels,
        ...(removesDefault ? { defaultLlmModelId: nextDefaultModelId } : {})
      }),
      '删除自定义模型失败'
    )
    if (!result.ok) return
    onSettingsChange(result.value)
    if (removesDefault) setDefaultModelId(result.value.defaultLlmModelId)
    toast.show('自定义模型已删除', 'success')
  }

  return (
    <>
      {settings.llmSecretStorage.protection !== 'secure' && (
        <div
          className="settings-notice settings-notice--warning"
          role="status"
        >
          <div className="settings-notice-copy">
            <strong>
              {settings.llmSecretStorage.protection === 'degraded'
                ? '系统凭证保护较弱'
                : '系统凭证存储不可用'}
            </strong>
            <span>
              {settings.llmSecretStorage.protection === 'degraded'
                ? `当前使用 ${settings.llmSecretStorage.backend}，API Key 会与普通设置分离保存，但保护强度低于系统密钥环。`
                : '当前设备无法持久化新的 API Key，请先启用系统密钥环。'}
            </span>
          </div>
        </div>
      )}
      {settings.llmSecretStorage.migrationError && (
        <div className="settings-notice settings-notice--warning" role="alert">
          <div className="settings-notice-copy">
            <strong>旧版密钥尚未迁移</strong>
            <span>{settings.llmSecretStorage.migrationError}</span>
          </div>
        </div>
      )}
      <SettingsCard
        className="settings-card--llm-default"
        title="默认 LLM"
        hint="设置应用默认使用的模型；插件开发 Agent 会优先使用该配置。"
        actions={
          <Button
            type="button"
            variant="primary"

            size="sm"
            disabled={!defaultDirty || settingsMutationBusy}
            onClick={() => void saveDefaultLlm()}
          >
            {settingsMutationBusy ? '保存中…' : defaultDirty ? '保存' : '已保存'}
          </Button>
        }
      >
        <div className="llm-default-form">
          <SettingsFormField label="提供商">
            <SelectControl
              value={defaultProviderId}
              disabled={readyAgentProviders.length === 0}
              onChange={(e) => {
                const providerId = e.target.value
                if (!providerId) {
                  setDefaultProviderId('')
                  setDefaultModelId('')
                  return
                }
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
              value={defaultModels.some((model) => model.id === defaultModelId) ? defaultModelId : ''}
              disabled={defaultModels.length === 0}
              onChange={(e) => setDefaultModelId(e.target.value)}
            >
              {defaultModels.length === 0 ? (
                <option value="">请先配置并选择提供商</option>
              ) : (
                defaultModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} ({model.id})
                  </option>
                ))
              )}
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
            <Button type="button" variant="primary" size="sm" onClick={() => setShowAddProvider(true)}>
              添加提供商
            </Button>
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
                savedDefault.providerId === provider.id ? ' llm-provider-card--default' : ''
              }`}
            >
              <header className="llm-provider-card-head">
                <div>
                  <strong>{provider.name}</strong>
                  <span className="llm-provider-card-tag">
                    {provider.source === 'builtin' ? '内置' : '自定义'}
                    {provider.local ? ' · 本地' : ''}
                    {savedDefault.providerId === provider.id ? ' · 默认' : ''}
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
                  <dd>{provider.local ? '无需' : provider.hasApiKey ? '已安全保存' : '未设置'}</dd>
                </div>
                <div>
                  <dt>Base URL</dt>
                  <dd title={provider.baseUrl}>{provider.baseUrl}</dd>
                </div>
              </dl>
              <footer className="llm-provider-card-actions">
                <Button type="button" size="sm" onClick={() => setModelsTarget(provider)}>
                  模型
                </Button>
                <Button type="button" size="sm" onClick={() => setSettingsTarget(provider)}>
                  设置
                </Button>
              </footer>
            </article>
          ))}
        </div>
      </SettingsCard>

      {showAddProvider && (
        <LlmAddProviderModal
          busy={settingsMutationBusy}
          onClose={() => setShowAddProvider(false)}
          onCreate={(input) => void addCustomProvider(input)}
        />
      )}

      {settingsTarget && (
        <LlmProviderSettingsModal
          provider={settingsTarget}
          userConfig={settings.llmProviderConfigs[settingsTarget.id]}
          onClose={() => setSettingsTarget(null)}
          onSave={(input) => void saveProviderConfig(input)}
          busy={settingsMutationBusy}
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
          mutationBusy={settingsMutationBusy}
        />
      )}
    </>
  )
}
