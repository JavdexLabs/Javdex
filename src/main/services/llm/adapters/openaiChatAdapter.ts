import type { ResolvedLlmModelRequestConfig } from '../../llmClient'
import { llmFetch } from '../../../utils/llmFetch'

interface OpenAiChatPayload {
  choices?: Array<{
    message?: { content?: string | null }
  }>
  error?: { message?: string }
}

export type SimpleChatMessage = { role: 'system' | 'user'; content: string }

/** JSON-only non-Agent invocation. Agent tool streaming is owned by Pi. */
export async function requestOpenAiJson<T>(
  messages: SimpleChatMessage[],
  config: ResolvedLlmModelRequestConfig
): Promise<{ json: T; rawText: string }> {
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
      temperature: 0.2,
      max_tokens: 12000,
      ...(config.promptCacheKey ? { prompt_cache_key: config.promptCacheKey } : {})
    })
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
    return { json: JSON.parse(content) as T, rawText: content }
  } catch {
    throw new Error(`模型未按 JSON 格式返回：${content.slice(0, 240)}`)
  }
}
