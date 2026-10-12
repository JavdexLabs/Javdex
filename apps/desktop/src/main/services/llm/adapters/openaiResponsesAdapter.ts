import type { ResolvedLlmModelRequestConfig } from '../../llmClient'
import type { SimpleChatMessage } from './openaiChatAdapter'
import { nativeTextToJson, requestNativePayload, type NativeTextResponse } from './nativeTextTransport'

interface ResponsesPayload {
  status?: string
  incomplete_details?: { reason?: string }
  error?: { message?: string }
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>
  usage?: {
    input_tokens?: number; output_tokens?: number; total_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
}

/** Non-Agent invocation. Pi owns Agent streaming and function-call handling. */
export async function requestResponsesText(
  messages: SimpleChatMessage[], config: ResolvedLlmModelRequestConfig, json = false
): Promise<NativeTextResponse> {
  if (!config.responsesUrl) throw new Error('OpenAI Responses 端点未配置')
  const payload = await requestNativePayload<ResponsesPayload>(config.responsesUrl, {
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    ...(config.sessionAffinityId ? { 'X-Session-Affinity': config.sessionAffinityId } : {})
  }, {
    model: config.modelId,
    input: messages,
    stream: false,
    store: false,
    max_output_tokens: config.maxTokens ?? 12000,
    ...(json ? { text: { format: { type: 'json_object' } } } : {}),
    ...(config.promptCacheKey ? { prompt_cache_key: config.promptCacheKey } : {})
  }, config)
  if (payload.status && payload.status !== 'completed') {
    throw new Error(`模型响应未完成：${payload.incomplete_details?.reason ?? payload.status}`)
  }
  const parts = payload.output?.filter(item => item.type === 'message').flatMap(item => item.content ?? []) ?? []
  if (parts.some(part => part.type === 'refusal')) throw new Error('模型拒绝了本次请求')
  const text = parts.filter(part => part.type === 'output_text').map(part => part.text ?? '').join('').trim()
  const input = payload.usage?.input_tokens ?? 0
  const output = payload.usage?.output_tokens ?? 0
  const cacheRead = payload.usage?.input_tokens_details?.cached_tokens ?? 0
  return {
    text,
    usage: payload.usage ? {
      input, uncachedInput: Math.max(0, input - cacheRead), output,
      reasoning: payload.usage.output_tokens_details?.reasoning_tokens ?? 0,
      cacheRead, cacheWrite: 0, totalTokens: payload.usage.total_tokens ?? input + output
    } : undefined
  }
}

export async function requestResponsesJson<T>(messages: SimpleChatMessage[], config: ResolvedLlmModelRequestConfig) {
  return nativeTextToJson<T>(await requestResponsesText(messages, config, true))
}
