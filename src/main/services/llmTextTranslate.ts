import { resolveActiveLlmRequestConfig, type ResolvedLlmRequestConfig } from './llmClient'
import { llmFetch } from '../utils/llmFetch'

const TRANSLATE_TIMEOUT_MS = 60_000

const SYSTEM_PROMPT = `你是专业翻译。将用户提供的文本翻译成简体中文。
只输出译文，不要引号、标题或解释。
若原文已是中文，原样返回。
保留番号、作品代号等不宜翻译的标识时可保留原文。`

type OpenAiChatPayload = {
  choices?: Array<{ message?: { content?: string | null } }>
  error?: { message?: string }
}

type AnthropicMessagesPayload = {
  content?: Array<{ type: string; text?: string }>
  error?: { message?: string }
}

export function normalizeTranslationOutput(text: string): string {
  let out = text.trim()
  if (out.startsWith('```')) {
    out = out.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()
  }
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith('「') && out.endsWith('」')) ||
    (out.startsWith('『') && out.endsWith('』'))
  ) {
    out = out.slice(1, -1).trim()
  }
  return out
}

export async function translateTextToChinese(text: string): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('没有可翻译的内容')

  const config = resolveActiveLlmRequestConfig()
  const raw =
    config.protocol === 'anthropic-messages'
      ? await requestAnthropicTranslate(trimmed, config)
      : await requestOpenAiTranslate(trimmed, config)

  const normalized = normalizeTranslationOutput(raw)
  if (!normalized) throw new Error('模型未返回有效译文')
  return normalized
}

async function requestOpenAiTranslate(
  text: string,
  config: ResolvedLlmRequestConfig
): Promise<string> {
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
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text }
        ],
        stream: false,
        temperature: 0.2,
        max_tokens: estimateMaxTokens(text)
      }),
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS)
    })
  } catch (err) {
    throw wrapNetworkError(err)
  }

  const bodyText = await response.text()
  let payload: OpenAiChatPayload = {}
  if (bodyText.trim()) {
    try {
      payload = JSON.parse(bodyText) as OpenAiChatPayload
    } catch {
      if (!response.ok) {
        throw new Error(`翻译失败：HTTP ${response.status}`)
      }
    }
  }

  if (!response.ok) {
    throw new Error(payload.error?.message || `翻译失败：HTTP ${response.status}`)
  }

  const content = payload.choices?.[0]?.message?.content
  if (!content?.trim()) throw new Error('模型未返回译文')
  return content
}

async function requestAnthropicTranslate(
  text: string,
  config: ResolvedLlmRequestConfig
): Promise<string> {
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
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
        max_tokens: estimateMaxTokens(text),
        temperature: 0.2
      }),
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS)
    })
  } catch (err) {
    throw wrapNetworkError(err)
  }

  const bodyText = await response.text()
  let payload: AnthropicMessagesPayload = {}
  if (bodyText.trim()) {
    try {
      payload = JSON.parse(bodyText) as AnthropicMessagesPayload
    } catch {
      if (!response.ok) {
        throw new Error(`翻译失败：HTTP ${response.status}`)
      }
    }
  }

  if (!response.ok) {
    throw new Error(payload.error?.message || `翻译失败：HTTP ${response.status}`)
  }

  const content = payload.content
    ?.filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim()

  if (!content) throw new Error('模型未返回译文')
  return content
}

function estimateMaxTokens(text: string): number {
  return Math.min(8192, Math.max(256, Math.ceil(text.length * 1.5) + 128))
}

function wrapNetworkError(err: unknown): Error {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new Error('翻译超时，请检查网络或模型设置')
  }
  if (err instanceof Error) {
    return new Error(`无法连接模型服务：${err.message}`)
  }
  return new Error('无法连接模型服务')
}
