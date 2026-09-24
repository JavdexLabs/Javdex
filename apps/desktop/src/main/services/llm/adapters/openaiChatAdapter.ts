import type { ResolvedLlmModelRequestConfig } from '../../llmClient'
import { llmFetch } from '../../../utils/llmFetch'

interface OpenAiChatPayload {
  choices?: Array<{
    message?: { content?: string | null }
  }>
  error?: { message?: string }
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

export interface JsonModelUsage {
  input: number
  uncachedInput: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
}

export interface JsonModelResponse<T> {
  json: T
  rawText: string
  usage?: JsonModelUsage
}

export type SimpleChatMessage = { role: 'system' | 'user'; content: string }

/** JSON-only non-Agent invocation. Agent tool streaming is owned by Pi. */
export async function requestOpenAiJson<T>(
  messages: SimpleChatMessage[],
  config: ResolvedLlmModelRequestConfig
): Promise<JsonModelResponse<T>> {
  if (!config.chatCompletionsUrl) {
    throw new Error('OpenAI 兼容端点未配置')
  }

  const response = await llmFetch(config.chatCompletionsUrl, {
    method: 'POST',
    headers: {
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...(config.sessionAffinityId ? { 'X-Session-Affinity': config.sessionAffinityId } : {}),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.modelId,
      messages,
      response_format: { type: 'json_object' },
      stream: false,
      temperature: 0,
      max_tokens: config.maxTokens ?? 12000,
      ...(config.promptCacheKey ? { prompt_cache_key: config.promptCacheKey } : {})
    }),
    signal: config.signal
      ? AbortSignal.any([config.signal, AbortSignal.timeout(config.timeoutMs ?? 120_000)])
      : AbortSignal.timeout(config.timeoutMs ?? 120_000)
  })

  const text = await response.text()
  let payload: OpenAiChatPayload
  try {
    payload = JSON.parse(text) as OpenAiChatPayload
  } catch {
    throw new Error(`模型供应商返回了非 JSON 响应：${text.slice(0, 240)}`)
  }

  if (!response.ok) {
    throw new Error(payload.error?.message || `模型请求失败：HTTP ${response.status}`)
  }

  const content = payload.choices?.[0]?.message?.content
  if (!content?.trim()) throw new Error('模型供应商未返回内容')

  try {
    const cacheRead = payload.usage?.prompt_tokens_details?.cached_tokens ?? 0
    const input = payload.usage?.prompt_tokens ?? 0
    return {
      json: JSON.parse(content) as T,
      rawText: content,
      usage: payload.usage
        ? {
            input,
            uncachedInput: Math.max(0, input - cacheRead),
            output: payload.usage.completion_tokens ?? 0,
            reasoning: payload.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            cacheRead,
            cacheWrite: 0,
            totalTokens: payload.usage.total_tokens ?? input + (payload.usage.completion_tokens ?? 0)
          }
        : undefined
    }
  } catch {
    throw new Error(`模型未按 JSON 格式返回：${content.slice(0, 240)}`)
  }
}
