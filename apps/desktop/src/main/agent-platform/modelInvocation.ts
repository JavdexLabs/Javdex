import { createHash } from 'node:crypto'
import type { ModelRole } from '@shared/aiConfigurationTypes'
import { requestAnthropicJson } from '../services/llm/adapters/anthropicMessagesAdapter'
import {
  requestOpenAiJson,
  type SimpleChatMessage
} from '../services/llm/adapters/openaiChatAdapter'
import type { NormalizedModelUsage, ResolvedModelAccess } from './types'
import type { JsonModelResponse } from '../services/llm/adapters/openaiChatAdapter'
import type { ResolvedLlmModelRequestConfig } from '../services/llmClient'

function endpoint(baseUrl: string, suffix: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  if (suffix === 'messages' && !root.endsWith('/v1')) return `${root}/v1/messages`
  return `${root}/${suffix}`
}

function normalizeJsonUsage(
  response: JsonModelResponse<unknown>,
  access: ResolvedModelAccess,
  role: Exclude<ModelRole, 'primary'>,
  affinityId?: string
): NormalizedModelUsage | undefined {
  if (!response.usage) return undefined
  return {
    role,
    routeRevision: access.routeRevision,
    affinityHash: createHash('sha256').update(affinityId ?? '').digest('hex'),
    cacheRetention: access.preset.cacheRetention,
    input: response.usage.input,
    uncachedInput: response.usage.uncachedInput,
    output: response.usage.output,
    reasoning: response.usage.reasoning,
    cacheRead: response.usage.cacheRead,
    cacheWrite: response.usage.cacheWrite,
    totalInput:
      response.usage.uncachedInput + response.usage.cacheRead + response.usage.cacheWrite,
    totalTokens: response.usage.totalTokens,
    cost: 0,
    missedCost: null
  }
}

async function toLegacyRequestConfig(
  access: ResolvedModelAccess,
  affinityId?: string
): Promise<ResolvedLlmModelRequestConfig> {
  const lease = await access.getCredentialLease()
  try {
    const apiKey = lease.resolve()
    const anthropic = access.model.api === 'anthropic-messages'
    return {
      providerId: access.model.providerId,
      providerName: access.model.providerId,
      protocol: anthropic ? 'anthropic-messages' as const : 'openai-chat' as const,
      apiKey,
      baseUrl: access.model.baseUrl,
      local: access.model.providerId === 'ollama' || access.model.providerId === 'lmstudio',
      modelId: access.model.modelId,
      chatCompletionsUrl: anthropic ? undefined : endpoint(access.model.baseUrl, 'chat/completions'),
      openAiModelsUrl: anthropic ? undefined : endpoint(access.model.baseUrl, 'models'),
      messagesUrl: anthropic ? endpoint(access.model.baseUrl, 'messages') : undefined,
      anthropicModelsUrl: anthropic ? endpoint(access.model.baseUrl, 'models') : undefined,
      promptCacheKey: affinityId && access.cacheCompatibility.supportsPromptCache === true
        ? affinityId
        : undefined,
      sessionAffinityId: affinityId && access.cacheCompatibility.sendSessionAffinityHeaders
        ? affinityId
        : undefined,
      useAnthropicPromptCache: anthropic && access.cacheCompatibility.supportsPromptCache === true,
      cacheRetention: access.preset.cacheRetention,
      maxTokens: access.preset.maxTokens,
      timeoutMs: access.preset.timeoutMs
    }
  } finally {
    lease.revoke()
  }
}

/** Non-Agent model workloads only. Agent primary streaming goes directly to Pi. */
export class ModelInvocation {
  constructor(
    private readonly dependencies: {
      requestAnthropic: typeof requestAnthropicJson
      requestOpenAi: typeof requestOpenAiJson
    } = {
      requestAnthropic: requestAnthropicJson,
      requestOpenAi: requestOpenAiJson
    }
  ) {}

  async requestJson<T>(input: {
    role?: Exclude<ModelRole, 'primary'>
    messages: SimpleChatMessage[]
    affinityId?: string
    access: ResolvedModelAccess
    signal?: AbortSignal
  }): Promise<{ json: T; rawText: string; usage?: NormalizedModelUsage }> {
    const access = input.access
    const role = input.role ?? 'verifier'
    const config = await toLegacyRequestConfig(access, input.affinityId)
    config.signal = input.signal
    const response = config.protocol === 'anthropic-messages'
      ? await this.dependencies.requestAnthropic<T>(input.messages, config)
      : await this.dependencies.requestOpenAi<T>(input.messages, config)
    return {
      json: response.json,
      rawText: response.rawText,
      usage: normalizeJsonUsage(response, access, role, input.affinityId)
    }
  }
}

export const modelInvocation = new ModelInvocation()
