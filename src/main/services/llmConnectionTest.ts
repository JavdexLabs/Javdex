import { resolveLlmRequestConfig, type ResolvedLlmRequestConfig } from './llmClient'
import { llmFetch } from '../utils/llmFetch'

const TEST_TIMEOUT_MS = 30_000
const TEST_PROMPT = 'Hi'

type OpenAiErrorPayload = {
  error?: { message?: string }
}

type AnthropicErrorPayload = {
  error?: { message?: string; type?: string }
}

export async function testLlmModelConnection(providerId: string, modelId: string): Promise<void> {
  const config = resolveLlmRequestConfig(providerId, modelId)
  if (config.protocol === 'anthropic-messages') {
    await pingAnthropic(config)
    return
  }
  await pingOpenAiCompatible(config)
}

async function pingOpenAiCompatible(config: ResolvedLlmRequestConfig): Promise<void> {
  if (!config.chatCompletionsUrl) {
    throw new Error('OpenAI 兼容端点未配置')
  }

  let response: Response
  try {
    response = await llmFetch(config.chatCompletionsUrl, {
      method: 'POST',
      headers: {
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.modelId,
        messages: [{ role: 'user', content: TEST_PROMPT }],
        max_tokens: 16,
        stream: false
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
    })
  } catch (err) {
    throw wrapNetworkError(err)
  }

  const text = await response.text()
  let payload: OpenAiErrorPayload = {}
  if (text.trim()) {
    try {
      payload = JSON.parse(text) as OpenAiErrorPayload
    } catch {
      if (!response.ok) {
        throw new Error(`连接失败：HTTP ${response.status}`)
      }
    }
  }

  if (!response.ok) {
    throw new Error(payload.error?.message || `连接失败：HTTP ${response.status}`)
  }
}

async function pingAnthropic(config: ResolvedLlmRequestConfig): Promise<void> {
  if (!config.messagesUrl) {
    throw new Error('Anthropic Messages 端点未配置')
  }
  if (!config.apiKey.trim()) {
    throw new Error(`请先在设置 → 模型中为「${config.providerName}」填写 API Key`)
  }

  let response: Response
  try {
    response = await llmFetch(config.messagesUrl, {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.modelId,
        max_tokens: 16,
        messages: [{ role: 'user', content: TEST_PROMPT }]
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS)
    })
  } catch (err) {
    throw wrapNetworkError(err)
  }

  const text = await response.text()
  let payload: AnthropicErrorPayload = {}
  if (text.trim()) {
    try {
      payload = JSON.parse(text) as AnthropicErrorPayload
    } catch {
      if (!response.ok) {
        throw new Error(`连接失败：HTTP ${response.status}`)
      }
    }
  }

  if (!response.ok) {
    throw new Error(payload.error?.message || `连接失败：HTTP ${response.status}`)
  }
}

function wrapNetworkError(err: unknown): Error {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new Error('连接超时，请检查网络或 Base URL')
  }
  if (err instanceof Error) {
    return new Error(`无法连接模型服务：${err.message}`)
  }
  return new Error('无法连接模型服务')
}
