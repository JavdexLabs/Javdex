import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FrozenModelAccessSnapshot } from './types'
import type { ModelWorkloadId } from '@shared/modelManagementTypes'
import type { ResolvedModelAccess } from './types'
import { ModelControlPlane, modelControlPlane, resolveEffectiveMaxTokens } from './modelControlPlane'

function frozenAccess(maxTokens: number): FrozenModelAccessSnapshot {
  return {
    credentialRef: 'llm-provider:test',
    descriptor: {
      providerId: 'test',
      modelId: 'test-model',
      name: 'Test model',
      api: 'openai-completions',
      baseUrl: 'https://example.invalid/v1',
      contextWindow: 128_000,
      maxTokens: 16_384,
      reasoning: true
    },
    routeRevision: 'test:r1',
    preset: {
      thinkingLevel: 'medium',
      maxTokens,
      timeoutMs: 120_000,
      cacheRetention: 'none'
    },
    cacheCompatibility: {
      supportsPromptCache: false,
      supportsLongCacheRetention: false,
      sendSessionAffinityHeaders: false,
      evidence: { source: 'manual', checkedAt: '2026-01-01T00:00:00.000Z' }
    }
  }
}

describe('resolveEffectiveMaxTokens', () => {
  it('uses the model maximum when the preset limit is zero', () => {
    assert.equal(resolveEffectiveMaxTokens(16_384, 0), 16_384)
  })

  it('uses the lower positive limit', () => {
    assert.equal(resolveEffectiveMaxTokens(16_384, 8_192), 8_192)
    assert.equal(resolveEffectiveMaxTokens(16_384, 32_768), 16_384)
  })

  it('rejects invalid limits instead of forwarding zero to the provider', () => {
    assert.throws(() => resolveEffectiveMaxTokens(0, 0), /模型最大输出必须是正整数/)
    assert.throws(() => resolveEffectiveMaxTokens(16_384, -1), /用途最大输出必须是非负整数/)
  })

  it('restores a zero sentinel as one frozen positive provider limit', () => {
    const restored = modelControlPlane.restoreAgentModel(frozenAccess(0))

    assert.equal(restored.model.maxTokens, 16_384)
    assert.equal(restored.preset.maxTokens, 16_384)
  })

  it('resolves live models only by workload', () => {
    const calls: ModelWorkloadId[] = []
    const expected = { model: { modelId: 'workload-model' } } as ResolvedModelAccess
    const controlPlane = new ModelControlPlane({
      resolve(workloadId) {
        calls.push(workloadId)
        return expected
      }
    })

    assert.equal(controlPlane.resolveWorkloadModel('library-curator'), expected)
    assert.equal(controlPlane.resolveWorkloadModel('plugin-developer'), expected)
    assert.deepEqual(calls, ['library-curator', 'plugin-developer'])
  })
})
