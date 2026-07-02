import type { AgentLlmResponse, AgentToolCall, AgentTranscript } from '../../pluginDevAgent/agentMessages'
import { getSystemText } from '../../pluginDevAgent/agentMessages'
import type { PluginDevToolDefinition } from '../../pluginDevAgent/toolSchemas'
import type { ResolvedLlmRequestConfig } from '../../llmClient'
import { llmFetch } from '../../../utils/llmFetch'

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicMessagesPayload {
  content?: AnthropicContentBlock[]
  stop_reason?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
  error?: { message?: string; type?: string }
}

function parseToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function pluginToolsToAnthropic(tools: PluginDevToolDefinition[]): Array<{
  name: string
  description: string
  input_schema: Record<string, unknown>
}> {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  }))
}

export function transcriptToAnthropicMessages(transcript: AgentTranscript): AnthropicMessage[] {
  const out: AnthropicMessage[] = []

  for (const turn of transcript) {
    if (turn.kind === 'system') continue

    if (turn.kind === 'user') {
      out.push({ role: 'user', content: turn.text })
      continue
    }

    if (turn.kind === 'assistant') {
      const blocks: AnthropicContentBlock[] = []
      if (turn.text?.trim()) {
        blocks.push({ type: 'text', text: turn.text.trim() })
      }
      for (const call of turn.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: parseToolInput(call.arguments)
        })
      }
      if (blocks.length === 0) {
        blocks.push({ type: 'text', text: '' })
      }
      out.push({ role: 'assistant', content: blocks })
      continue
    }

    out.push({
      role: 'user',
      content: turn.results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.callId,
        content: result.content,
        ...(result.isError ? { is_error: true } : {})
      }))
    })
  }

  return mergeAdjacentAnthropicRoles(out)
}

function mergeAdjacentAnthropicRoles(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const message of messages) {
    const prev = out[out.length - 1]
    if (prev && prev.role === message.role) {
      const prevBlocks = Array.isArray(prev.content)
        ? prev.content
        : [{ type: 'text' as const, text: prev.content }]
      const nextBlocks = Array.isArray(message.content)
        ? message.content
        : [{ type: 'text' as const, text: message.content }]
      prev.content = [...prevBlocks, ...nextBlocks]
      continue
    }
    out.push(message)
  }
  return out
}

function parseAnthropicResponse(payload: AnthropicMessagesPayload): AgentLlmResponse {
  const blocks = payload.content ?? []
  const textParts: string[] = []
  const toolCalls: AgentToolCall[] = []

  for (const block of blocks) {
    if (block.type === 'text' && block.text.trim()) {
      textParts.push(block.text)
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {})
      })
    }
  }

  const text = textParts.length ? textParts.join('\n') : null
  if (!text?.trim() && !toolCalls.length) {
    throw new Error('模型供应商返回空内容且无 tool_use')
  }

  return {
    text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: payload.stop_reason,
    usage:
      typeof payload.usage?.input_tokens === 'number' ||
      typeof payload.usage?.output_tokens === 'number'
        ? {
            promptTokens: payload.usage?.input_tokens ?? 0,
            completionTokens: payload.usage?.output_tokens ?? 0,
            totalTokens:
              (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0)
          }
        : undefined
  }
}

export async function requestAnthropicToolChat(
  transcript: AgentTranscript,
  config: ResolvedLlmRequestConfig,
  tools: PluginDevToolDefinition[],
  options?: { retryOnce?: boolean }
): Promise<AgentLlmResponse> {
  if (!config.messagesUrl) {
    throw new Error('Anthropic Messages 端点未配置')
  }
  if (!config.apiKey.trim()) {
    throw new Error(`请先在设置 → 模型中为「${config.providerName}」填写 API Key`)
  }

  const system = getSystemText(transcript)
  const body = {
    model: config.modelId,
    max_tokens: 8000,
    temperature: 0.2,
    system: system || undefined,
    messages: transcriptToAnthropicMessages(transcript),
    tools: pluginToolsToAnthropic(tools)
  }

  const attempt = async (): Promise<AgentLlmResponse> => {
    const response = await llmFetch(config.messagesUrl!, {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
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

    return parseAnthropicResponse(payload)
  }

  try {
    return await attempt()
  } catch (err) {
    if (options?.retryOnce === false) throw err
    return attempt()
  }
}

export async function requestAnthropicJson<T>(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  config: ResolvedLlmRequestConfig
): Promise<{ json: T; rawText: string }> {
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

  const response = await llmFetch(config.messagesUrl, {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.modelId,
      max_tokens: 12000,
      temperature: 0.2,
      system: system || 'Respond with valid JSON only.',
      messages: userMessages.length
        ? userMessages
        : [{ role: 'user', content: 'Respond with valid JSON only.' }]
    })
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

  const rawText =
    payload.content
      ?.filter((block): block is Extract<AnthropicContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim() ?? ''

  if (!rawText) throw new Error('Anthropic 未返回内容')

  const jsonText = extractJsonObject(rawText)
  try {
    return { json: JSON.parse(jsonText) as T, rawText }
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
