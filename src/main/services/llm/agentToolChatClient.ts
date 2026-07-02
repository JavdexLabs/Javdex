import type { AgentLlmResponse, AgentTranscript } from '../pluginDevAgent/agentMessages'
import { PLUGIN_DEV_TOOL_SCHEMAS } from '../pluginDevAgent/toolSchemas'
import { requestAnthropicToolChat } from './adapters/anthropicMessagesAdapter'
import { requestOpenAiToolChat } from './adapters/openaiChatAdapter'
import { resolveActiveLlmRequestConfig } from '../llmClient'

export async function requestAgentToolChat(
  transcript: AgentTranscript,
  options?: { retryOnce?: boolean }
): Promise<AgentLlmResponse> {
  const config = resolveActiveLlmRequestConfig()

  if (config.protocol === 'anthropic-messages') {
    return requestAnthropicToolChat(transcript, config, PLUGIN_DEV_TOOL_SCHEMAS, options)
  }

  return requestOpenAiToolChat(transcript, config, PLUGIN_DEV_TOOL_SCHEMAS, options)
}
