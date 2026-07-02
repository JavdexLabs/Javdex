import { resolveActiveLlmRequestConfig } from './llmClient'
import { requestAnthropicJson } from './llm/adapters/anthropicMessagesAdapter'
import { requestOpenAiJson, type SimpleChatMessage } from './llm/adapters/openaiChatAdapter'

export type { SimpleChatMessage as AgentJsonChatMessage }

export async function requestAgentJson<T>(messages: SimpleChatMessage[]): Promise<T> {
  return (await requestAgentJsonWithRaw<T>(messages)).json
}

export async function requestAgentJsonWithRaw<T>(
  messages: SimpleChatMessage[]
): Promise<{ json: T; rawText: string }> {
  const config = resolveActiveLlmRequestConfig()

  if (config.protocol === 'anthropic-messages') {
    return requestAnthropicJson<T>(messages, config)
  }

  return requestOpenAiJson<T>(messages, config)
}
