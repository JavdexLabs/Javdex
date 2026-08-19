import type { ModelRole } from '@shared/aiConfigurationTypes'
import { requestAnthropicJson } from '../services/llm/adapters/anthropicMessagesAdapter'
import {
  requestOpenAiJson,
  type SimpleChatMessage
} from '../services/llm/adapters/openaiChatAdapter'
import { modelControlPlane } from './modelControlPlane'
import type { ResolvedModelAccess } from './types'

function endpoint(baseUrl: string, suffix: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  if (suffix === 'messages' && !root.endsWith('/v1')) return `${root}/v1/messages`
  return `${root}/${suffix}`
}

async function toLegacyRequestConfig(access: ResolvedModelAccess, affinityId?: string) {
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
      cacheRetention: access.preset.cacheRetention
    }
  } finally {
    lease.revoke()
  }
}

/** Non-Agent model workloads only. Agent primary streaming goes directly to Pi. */
export class ModelInvocation {
  async requestJson<T>(input: {
    profileId: string
    role?: Exclude<ModelRole, 'primary'>
    messages: SimpleChatMessage[]
    affinityId?: string
  }): Promise<{ json: T; rawText: string }> {
    const access = modelControlPlane.resolveAgentModel(input.profileId, input.role ?? 'verifier')
    const config = await toLegacyRequestConfig(access, input.affinityId)
    if (config.protocol === 'anthropic-messages') {
      return requestAnthropicJson<T>(input.messages, config)
    }
    return requestOpenAiJson<T>(input.messages, config)
  }
}

export const modelInvocation = new ModelInvocation()
