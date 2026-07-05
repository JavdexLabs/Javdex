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
  protocol: LlmProviderProtocol
  apiKey: string
  baseUrl: string
  local: boolean
  chatCompletionsUrl?: string
  openAiModelsUrl?: string
  messagesUrl?: string
  anthropicModelsUrl?: string
}

export interface ResolvedLlmModelRequestConfig extends ResolvedLlmRequestConfig {
  modelId: string
}

function findCustomProvider(id: string): CustomLlmProviderDefinition | undefined {
  return getSettings().customLlmProviders.find((item) => item.id === id)
}

function buildOpenAiChatCompletionsUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  return `${root}/chat/completions`
}

function buildOpenAiModelsUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  return `${root}/models`
}

function buildAnthropicMessagesUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  if (root.endsWith('/v1')) return `${root}/messages`
  return `${root}/v1/messages`
}

function buildAnthropicModelsUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  if (root.endsWith('/v1')) return `${root}/models`
  return `${root}/v1/models`
}

export function resolveLlmProviderRequestConfig(providerId: string): ResolvedLlmRequestConfig {
  const settings = getSettings()
  const trimmedProviderId = providerId.trim()
  if (!trimmedProviderId) throw new Error('未指定模型供应商')

  const builtIn = BUILT_IN_LLM_PROVIDER_BY_ID.get(trimmedProviderId)
  const custom = findCustomProvider(trimmedProviderId)
  if (!builtIn && !custom) {
    throw new Error(`未知的模型供应商：${trimmedProviderId}`)
  }

  const userConfig = settings.llmProviderConfigs[trimmedProviderId]
  const protocol = userConfig?.protocol ?? custom?.protocol ?? builtIn?.protocol ?? 'openai-chat'
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
    protocol,
    apiKey,
    baseUrl,
    local,
    chatCompletionsUrl:
      protocol === 'openai-chat' ? buildOpenAiChatCompletionsUrl(baseUrl) : undefined,
    openAiModelsUrl: protocol === 'openai-chat' ? buildOpenAiModelsUrl(baseUrl) : undefined,
    messagesUrl:
      protocol === 'anthropic-messages' ? buildAnthropicMessagesUrl(baseUrl) : undefined,
    anthropicModelsUrl:
      protocol === 'anthropic-messages' ? buildAnthropicModelsUrl(baseUrl) : undefined
  }
}

export function resolveLlmRequestConfig(
  providerId: string,
  modelId: string
): ResolvedLlmModelRequestConfig {
  const trimmedModelId = modelId.trim()
  if (!trimmedModelId) throw new Error('未指定模型 ID')
  return {
    ...resolveLlmProviderRequestConfig(providerId),
    modelId: trimmedModelId
  }
}

export function resolveActiveLlmRequestConfig(): ResolvedLlmModelRequestConfig {
  const settings = getSettings()
  const { providerId, modelId } = normalizeDefaultLlmSelection(settings)
  return resolveLlmRequestConfig(providerId, modelId)
}
