import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ModelInvocation } from './modelInvocation'
import type { ResolvedModelAccess } from './types'
import type { ResolvedLlmModelRequestConfig } from '../services/llmClient'
import type { SimpleChatMessage } from '../services/llm/adapters/openaiChatAdapter'

function access(modelId: string): ResolvedModelAccess {
  return {
    credentialRef: 'llm-provider:frozen',
    model: {
      providerId: 'frozen',
      modelId,
      name: 'Frozen verifier',
      api: 'openai-completions',
      baseUrl: 'https://frozen.invalid/v1',
      contextWindow: 8_192,
      maxTokens: 900,
      reasoning: false
    },
    routeRevision: 'frozen:r2',
    preset: {
      thinkingLevel: 'minimal',
      maxTokens: 777,
      timeoutMs: 4_321,
      cacheRetention: 'none'
    },
    cacheCompatibility: {
      supportsPromptCache: false,
      supportsLongCacheRetention: false,
      sendSessionAffinityHeaders: false,
      evidence: { source: 'manual', checkedAt: '2026-01-01T00:00:00.000Z' }
    },
    getCredentialLease: async () => ({
      leaseId: 'lease',
      credentialRef: 'llm-provider:frozen',
      expiresAt: Date.now() + 1_000,
      resolve: () => 'test-key',
      revoke: () => undefined
    })
  }
}

describe('ModelInvocation', () => {
  it('uses injected frozen verifier access and forwards preset limits and cancellation', async () => {
    let captured: ResolvedLlmModelRequestConfig | undefined
    const invocation = new ModelInvocation({
      requestAnthropic: async () => { throw new Error('unexpected anthropic request') },
      requestOpenAi: async <T>(
        _messages: SimpleChatMessage[],
        config: ResolvedLlmModelRequestConfig
      ) => {
        captured = config
        return { json: { ok: true } as T, rawText: '{"ok":true}' }
      }
    })
    const controller = new AbortController()

    const result = await invocation.requestJson<{ ok: boolean }>({
      messages: [{ role: 'user', content: 'verify' }],
      access: access('frozen-model'),
      signal: controller.signal
    })

    assert.deepEqual(result.json, { ok: true })
    assert.equal(captured?.modelId, 'frozen-model')
    assert.equal(captured?.maxTokens, 777)
    assert.equal(captured?.timeoutMs, 4_321)
    assert.equal(captured?.signal, controller.signal)
  })
})
