import type { LlmProviderProtocol } from '@shared/llmProviders'

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
  promptCacheKey?: string
  sessionAffinityId?: string
  useAnthropicPromptCache?: boolean
  cacheRetention?: 'none' | 'short' | 'long'
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
}
