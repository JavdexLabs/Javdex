import {
  resolveLlmProviderRequestConfig,
  resolveLlmRequestConfig,
  type ResolvedLlmModelRequestConfig,
  type ResolvedLlmRequestConfig
} from './llmClient'
import { llmFetch } from '../utils/llmFetch'
import { inferLlmModelKind, type LlmModelDefinition } from '@shared/llmProviders'

const TEST_TIMEOUT_MS = 30_000
const TEST_MAX_ATTEMPTS = 4
const TEST_MAX_TOKENS = 128
const TEST_RETRY_BASE_MS = 350
const TEST_EXPECTED_TEXT = 'JAVDEX_OK'
const TEST_PROMPT = `Reply with exactly this text and nothing else: ${TEST_EXPECTED_TEXT}`
const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

type OpenAiErrorPayload = {
  error?: { message?: string }
  data?: Array<{ id?: string; name?: string; owned_by?: string }>
  choices?: Array<{
    finish_reason?: string
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null
      reasoning_content?: string | null
    }
    text?: string | null
  }>
}

type AnthropicErrorPayload = {
  error?: { message?: string; type?: string }
  data?: Array<{ id?: string; display_name?: string; created_at?: string }>
  content?: Array<{ type?: string; text?: string }>
}

class RetryableProbeError extends Error {
  retryAfterMs?: number

  constructor(message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'RetryableProbeError'
    this.retryAfterMs = retryAfterMs
  }
}

export async function testLlmModelConnection(providerId: string, modelId: string): Promise<string> {
  if (inferLlmModelKind({ id: modelId, name: modelId }) !== 'chat') {
    throw new Error('这是嵌入模型，不支持测试生成；请选择聊天/生成模型')
  }
  const config = resolveLlmRequestConfig(providerId, modelId)
  if (config.protocol === 'anthropic-messages') {
    return pingAnthropic(config)
  }
  return pingOpenAiCompatible(config)
}

export async function listLlmProviderModels(providerId: string): Promise<LlmModelDefinition[]> {
  const config = resolveLlmProviderRequestConfig(providerId)
  if (config.protocol === 'anthropic-messages') return listAnthropicModels(config)
  return listOpenAiCompatibleModels(config)
}

async function pingOpenAiCompatible(config: ResolvedLlmModelRequestConfig): Promise<string> {
  if (!config.chatCompletionsUrl) {
    throw new Error('OpenAI 兼容端点未配置')
  }

  return runProbeWithRetries(() => requestOpenAiProbe(config))
}

async function requestOpenAiProbe(config: ResolvedLlmModelRequestConfig): Promise<string> {
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
        messages: [
          { role: 'system', content: `You are a connection probe. Output only ${TEST_EXPECTED_TEXT}.` },
          { role: 'user', content: TEST_PROMPT }
        ],
        temperature: 0,
        max_tokens: TEST_MAX_TOKENS,
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
    const message = payload.error?.message || `连接失败：HTTP ${response.status}`
    if (RETRYABLE_HTTP_STATUS.has(response.status)) {
      throw new RetryableProbeError(message, parseRetryAfterMs(response.headers))
    }
    throw new Error(message)
  }

  return extractOpenAiText(payload)
}

async function pingAnthropic(config: ResolvedLlmModelRequestConfig): Promise<string> {
  if (!config.messagesUrl) {
    throw new Error('Anthropic Messages 端点未配置')
  }
  if (!config.apiKey.trim()) {
    throw new Error(`请先在设置 → 模型中为「${config.providerName}」填写 API Key`)
  }

  return runProbeWithRetries(() => requestAnthropicProbe(config))
}

async function requestAnthropicProbe(config: ResolvedLlmModelRequestConfig): Promise<string> {
  let response: Response
  try {
    response = await llmFetch(config.messagesUrl!, {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.modelId,
        system: `You are a connection probe. Output only ${TEST_EXPECTED_TEXT}.`,
        max_tokens: TEST_MAX_TOKENS,
        temperature: 0,
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
    const message = payload.error?.message || `连接失败：HTTP ${response.status}`
    if (RETRYABLE_HTTP_STATUS.has(response.status)) {
      throw new RetryableProbeError(message, parseRetryAfterMs(response.headers))
    }
    throw new Error(message)
  }

  return extractAnthropicText(payload)
}

async function runProbeWithRetries(requestProbe: () => Promise<string>): Promise<string> {
  let lastRetryableError: Error | undefined
  for (let attempt = 0; attempt < TEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      const content = await requestProbe()
      if (content.trim()) return content.trim().slice(0, 160)
      throw new RetryableProbeError('模型服务已响应，但没有返回可用文本内容')
    } catch (err) {
      if (!(err instanceof RetryableProbeError)) throw err
      lastRetryableError = err
      if (attempt >= TEST_MAX_ATTEMPTS - 1) break
      await wait(getRetryDelayMs(attempt, err.retryAfterMs))
    }
  }
  throw new Error(
    lastRetryableError?.message
      ? `${lastRetryableError.message}；已重试 ${TEST_MAX_ATTEMPTS} 次`
      : '模型服务已响应，但没有返回可用文本内容'
  )
}

async function listOpenAiCompatibleModels(config: ResolvedLlmRequestConfig): Promise<LlmModelDefinition[]> {
  if (!config.openAiModelsUrl) throw new Error('OpenAI 模型列表端点未配置')

  let response: Response
  try {
    response = await llmFetch(config.openAiModelsUrl, {
      method: 'GET',
      headers: {
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        'Content-Type': 'application/json'
      },
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
      throw new Error(`模型列表返回了非 JSON 响应：${text.slice(0, 160)}`)
    }
  }
  if (!response.ok) {
    throw new Error(payload.error?.message || `查询模型失败：HTTP ${response.status}`)
  }
  return normalizeModelList(payload.data)
}

async function listAnthropicModels(config: ResolvedLlmRequestConfig): Promise<LlmModelDefinition[]> {
  if (!config.anthropicModelsUrl) throw new Error('Anthropic 模型列表端点未配置')
  if (!config.apiKey.trim()) {
    throw new Error(`请先在设置 → 模型中为「${config.providerName}」填写 API Key`)
  }

  let response: Response
  try {
    response = await llmFetch(config.anthropicModelsUrl, {
      method: 'GET',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
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
      throw new Error(`模型列表返回了非 JSON 响应：${text.slice(0, 160)}`)
    }
  }
  if (!response.ok) {
    throw new Error(payload.error?.message || `查询模型失败：HTTP ${response.status}`)
  }
  return normalizeModelList(payload.data?.map((model) => ({ id: model.id, name: model.display_name })))
}

function normalizeModelList(input: Array<{ id?: string; name?: string } | undefined> | undefined): LlmModelDefinition[] {
  const seen = new Set<string>()
  const models: LlmModelDefinition[] = []
  for (const item of input ?? []) {
    const id = item?.id?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const model = { id, name: item?.name?.trim() || id }
    models.push({ ...model, kind: inferLlmModelKind(model) })
  }
  return models.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

function extractOpenAiText(payload: OpenAiErrorPayload): string {
  for (const choice of payload.choices ?? []) {
    const content = choice.message?.content
    if (typeof content === 'string' && content.trim()) return content
    if (Array.isArray(content)) {
      const text = content
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('\n')
        .trim()
      if (text) return text
    }
    if (typeof choice.text === 'string' && choice.text.trim()) return choice.text
  }
  return ''
}

function extractAnthropicText(payload: AnthropicErrorPayload): string {
  return (
    payload.content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim() ?? ''
  )
}

function wrapNetworkError(err: unknown): Error {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new RetryableProbeError('连接超时，请检查网络或 Base URL')
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new RetryableProbeError('连接被中断，请稍后重试')
  }
  if (err instanceof Error) {
    return new RetryableProbeError(`无法连接模型服务：${err.message}`)
  }
  return new RetryableProbeError('无法连接模型服务')
}

function getRetryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs
  const exponential = TEST_RETRY_BASE_MS * 2 ** attempt
  const jitter = Math.floor(Math.random() * TEST_RETRY_BASE_MS)
  return Math.min(exponential + jitter, 3_000)
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after')?.trim()
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const timestamp = Date.parse(value)
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now())
  return undefined
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
