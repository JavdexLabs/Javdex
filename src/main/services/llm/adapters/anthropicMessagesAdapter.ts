import type { ResolvedLlmModelRequestConfig } from '../../llmClient'
import { llmFetch } from '../../../utils/llmFetch'
import type { JsonModelResponse } from './openaiChatAdapter'

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: string; [key: string]: unknown }

interface AnthropicMessagesPayload {
  content?: AnthropicContentBlock[]
  error?: { message?: string; type?: string }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

/** JSON-only non-Agent invocation. Agent tool streaming is owned by Pi. */
export async function requestAnthropicJson<T>(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  config: ResolvedLlmModelRequestConfig
): Promise<JsonModelResponse<T>> {
  if (!config.messagesUrl) {
    throw new Error('Anthropic Messages 端点未配置')
  }
  if (!config.apiKey.trim()) {
    throw new Error(`请先在设置 → 模型中为「${config.providerName}」填写 API Key`)
  }

  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const userMessages = messages
    .filter((message) => message.role === 'user')
    .map((message) => ({ role: 'user' as const, content: message.content }))

  const systemContent = system || 'Respond with valid JSON only.'
  const response = await llmFetch(config.messagesUrl, {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      ...(config.sessionAffinityId ? { 'X-Session-Affinity': config.sessionAffinityId } : {}),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.modelId,
      max_tokens: config.maxTokens ?? 12000,
      temperature: 0,
      system: config.useAnthropicPromptCache
        ? [{
            type: 'text',
            text: systemContent,
            cache_control: {
              type: 'ephemeral',
              ...(config.cacheRetention === 'long' ? { ttl: '1h' } : {})
            }
          }]
        : systemContent,
      messages: userMessages.length
        ? userMessages
        : [{ role: 'user', content: 'Respond with valid JSON only.' }]
    }),
    signal: config.signal
      ? AbortSignal.any([config.signal, AbortSignal.timeout(config.timeoutMs ?? 120_000)])
      : AbortSignal.timeout(config.timeoutMs ?? 120_000)
  })

  const text = await response.text()
  let payload: AnthropicMessagesPayload
  try {
    payload = JSON.parse(text) as AnthropicMessagesPayload
  } catch {
    throw new Error(`Anthropic 返回了非 JSON 响应：${text.slice(0, 240)}`)
  }

  if (!response.ok) {
    throw new Error(payload.error?.message || `Anthropic 请求失败：HTTP ${response.status}`)
  }

  const rawText = payload.content
    ?.filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim() ?? ''

  if (!rawText) throw new Error('Anthropic 未返回内容')

  const jsonText = extractJsonObject(rawText)
  try {
    const input = payload.usage?.input_tokens ?? 0
    const cacheRead = payload.usage?.cache_read_input_tokens ?? 0
    const cacheWrite = payload.usage?.cache_creation_input_tokens ?? 0
    const output = payload.usage?.output_tokens ?? 0
    return {
      json: JSON.parse(jsonText) as T,
      rawText,
      usage: payload.usage
        ? {
            input,
            uncachedInput: input,
            output,
            reasoning: 0,
            cacheRead,
            cacheWrite,
            totalTokens: input + cacheRead + cacheWrite + output
          }
        : undefined
    }
  } catch {
    throw new Error(`Anthropic 未按 JSON 格式返回：${rawText.slice(0, 240)}`)
  }
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1)
  return trimmed
}
