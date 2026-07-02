import { getSettings } from '../settings/settingsStore'
import {
  BUILT_IN_LLM_PROVIDER_BY_ID,
  normalizeDefaultLlmSelection,
  resolveProviderBaseUrl,
  type CustomLlmProviderDefinition,
  type LlmProviderProtocol
} from '@shared/llmProviders'

export interface ResolvedLlmRequestConfig {
  providerId: string
  providerName: string
  modelId: string
  protocol: LlmProviderProtocol
  apiKey: string
  baseUrl: string
  local: boolean
  chatCompletionsUrl?: string
  messagesUrl?: string
}

function findCustomProvider(id: string): CustomLlmProviderDefinition | undefined {
  return getSettings().customLlmProviders.find((item) => item.id === id)
}

function buildOpenAiChatCompletionsUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  return `${root}/chat/completions`
}

function buildAnthropicMessagesUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  if (root.endsWith('/v1')) return `${root}/messages`
  return `${root}/v1/messages`
}

export function resolveLlmRequestConfig(providerId: string, modelId: string): ResolvedLlmRequestConfig {
  const settings = getSettings()
  const trimmedProviderId = providerId.trim()
  const trimmedModelId = modelId.trim()
  if (!trimmedProviderId) throw new Error('未指定模型供应商')
  if (!trimmedModelId) throw new Error('未指定模型 ID')

  const builtIn = BUILT_IN_LLM_PROVIDER_BY_ID.get(trimmedProviderId)
  const custom = findCustomProvider(trimmedProviderId)
  if (!builtIn && !custom) {
    throw new Error(`未知的模型供应商：${trimmedProviderId}`)
  }

  const userConfig = settings.llmProviderConfigs[trimmedProviderId]
  const protocol = custom?.protocol ?? builtIn?.protocol ?? 'openai-chat'
  const providerName = custom?.name ?? builtIn?.name ?? trimmedProviderId
  const apiKey = userConfig?.apiKey?.trim() ?? ''
  const baseUrl = resolveProviderBaseUrl(trimmedProviderId, userConfig, custom)
  const local = builtIn?.local === true

  if (!local && !apiKey) {
    throw new Error(`请先在设置 → 模型中为「${providerName}」填写 API Key`)
  }

  return {
    providerId: trimmedProviderId,
    providerName,
    modelId: trimmedModelId,
    protocol,
    apiKey,
    baseUrl,
    local,
    chatCompletionsUrl:
      protocol === 'openai-chat' ? buildOpenAiChatCompletionsUrl(baseUrl) : undefined,
    messagesUrl:
      protocol === 'anthropic-messages' ? buildAnthropicMessagesUrl(baseUrl) : undefined
  }
}

export function resolveActiveLlmRequestConfig(): ResolvedLlmRequestConfig {
  const settings = getSettings()
  const { providerId, modelId } = normalizeDefaultLlmSelection(settings)
  return resolveLlmRequestConfig(providerId, modelId)
}
