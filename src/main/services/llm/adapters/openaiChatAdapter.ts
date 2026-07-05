import type {
  AgentLlmResponse,
  AgentToolCall,
  AgentTranscript
} from '../../pluginDevAgent/agentMessages'
import { getSystemText } from '../../pluginDevAgent/agentMessages'
import type { PluginDevToolDefinition } from '../../pluginDevAgent/toolSchemas'
import type { ResolvedLlmModelRequestConfig } from '../../llmClient'
import { llmFetch } from '../../../utils/llmFetch'

type OpenAiToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OpenAiChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAiToolCall[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

interface OpenAiChatPayload {
  choices?: Array<{
    finish_reason?: string
    message?: {
      content?: string | null
      tool_calls?: OpenAiToolCall[]
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  error?: { message?: string }
}

export function transcriptToOpenAiMessages(transcript: AgentTranscript): OpenAiChatMessage[] {
  const out: OpenAiChatMessage[] = []
  for (const turn of transcript) {
    if (turn.kind === 'system') {
      out.push({ role: 'system', content: turn.text })
    } else if (turn.kind === 'user') {
      out.push({ role: 'user', content: turn.text })
    } else if (turn.kind === 'assistant') {
      out.push({
        role: 'assistant',
        content: turn.text ?? null,
        tool_calls: turn.toolCalls?.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: call.arguments
          }
        }))
      })
    } else {
      for (const result of turn.results) {
        out.push({
          role: 'tool',
          tool_call_id: result.callId,
          content: result.content
        })
      }
    }
  }
  return out
}

function parseOpenAiToolCalls(toolCalls: OpenAiToolCall[] | undefined): AgentToolCall[] | undefined {
  if (!toolCalls?.length) return undefined
  return toolCalls.map((call) => ({
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments
  }))
}

function parseOpenAiResponse(payload: OpenAiChatPayload): AgentLlmResponse {
  const choice = payload.choices?.[0]
  const message = choice?.message
  if (!message) throw new Error('模型供应商未返回 message')

  const text = message.content ?? null
  const toolCalls = parseOpenAiToolCalls(message.tool_calls)
  if (!text?.trim() && !toolCalls?.length) {
    throw new Error('模型供应商返回空内容且无 tool_calls')
  }

  return {
    text,
    toolCalls,
    finishReason: choice?.finish_reason,
    usage:
      typeof payload.usage?.total_tokens === 'number'
        ? {
            promptTokens:
              typeof payload.usage.prompt_tokens === 'number' ? payload.usage.prompt_tokens : 0,
            completionTokens:
              typeof payload.usage.completion_tokens === 'number'
                ? payload.usage.completion_tokens
                : 0,
            totalTokens: payload.usage.total_tokens
          }
        : undefined
  }
}

export async function requestOpenAiToolChat(
  transcript: AgentTranscript,
  config: ResolvedLlmModelRequestConfig,
  tools: PluginDevToolDefinition[],
  options?: { retryOnce?: boolean }
): Promise<AgentLlmResponse> {
  if (!config.chatCompletionsUrl) {
    throw new Error('OpenAI 兼容端点未配置')
  }

  const body: Record<string, unknown> = {
    model: config.modelId,
    messages: transcriptToOpenAiMessages(transcript),
    tools,
    tool_choice: 'auto',
    stream: false,
    temperature: 0.2,
    max_tokens: 8000
  }

  const attempt = async (): Promise<AgentLlmResponse> => {
    const response = await llmFetch(config.chatCompletionsUrl!, {
      method: 'POST',
      headers: {
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
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

    return parseOpenAiResponse(payload)
  }

  try {
    return await attempt()
  } catch (err) {
    if (options?.retryOnce === false) throw err
    return attempt()
  }
}

export type SimpleChatMessage = { role: 'system' | 'user'; content: string }

export function simpleMessagesToTranscript(messages: SimpleChatMessage[]): AgentTranscript {
  return messages.map((message) =>
    message.role === 'system'
      ? { kind: 'system' as const, text: message.content }
      : { kind: 'user' as const, text: message.content }
  )
}

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
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.modelId,
      messages,
      response_format: { type: 'json_object' },
      stream: false,
      temperature: 0.2,
      max_tokens: 12000
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

export function extractSystemFromTranscript(transcript: AgentTranscript): string {
  return getSystemText(transcript)
}
