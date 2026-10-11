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
  responsesUrl?: string
  googleModelsUrl?: string
}

/** Protocol-specific endpoints, shared by probes, translation and JSON workloads. */
export function llmRequestEndpoints(protocol: LlmProviderProtocol, baseUrl: string): Pick<
  ResolvedLlmRequestConfig,
  'chatCompletionsUrl' | 'openAiModelsUrl' | 'messagesUrl' | 'anthropicModelsUrl' | 'responsesUrl' | 'googleModelsUrl'
> {
  const root = baseUrl.replace(/\/+$/, '')
  switch (protocol) {
    case 'anthropic-messages': {
      const versioned = root.endsWith('/v1') ? root : `${root}/v1`
      return { messagesUrl: `${versioned}/messages`, anthropicModelsUrl: `${versioned}/models` }
    }
    case 'google-generative-ai':
      return { googleModelsUrl: `${root}/models` }
    case 'openai-responses':
      return { responsesUrl: `${root}/responses`, openAiModelsUrl: `${root}/models` }
    case 'openai-chat':
      return { chatCompletionsUrl: `${root}/chat/completions`, openAiModelsUrl: `${root}/models` }
  }
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
