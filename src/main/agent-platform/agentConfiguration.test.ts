import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelManagementSnapshot } from '@shared/modelManagementTypes'
import { AgentConfiguration } from './agentConfiguration'

function snapshot(): ModelManagementSnapshot {
  return {
    schemaVersion: 2,
    revision: 'model-management:r1',
    updatedAt: '2026-08-22T00:00:00.000Z',
    connections: [],
    models: [],
    assignments: [
      {
        workloadId: 'app-default',
        model: { mode: 'explicit', modelRef: 'model:test:default' },
        runtime: {
          thinkingLevel: 'medium',
          maxTokens: 0,
          timeoutMs: 120_000,
          cacheRetention: 'short'
        },
        compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 },
        limits: { maxTurns: 0, maxContextTokens: 128_000 },
        resolution: { ready: true, modelRef: 'model:test:default' }
      },
      {
        workloadId: 'plugin-developer',
        model: { mode: 'inherit-default' },
        runtime: {
          thinkingLevel: 'high',
          maxTokens: 0,
          timeoutMs: 240_000,
          cacheRetention: 'short'
        },
        compaction: { enabled: true, reserveTokens: 12_000, keepRecentTokens: 18_000 },
        limits: { maxTurns: 0, maxContextTokens: 96_000 },
        resolution: { ready: true, modelRef: 'model:test:default' }
      },
      {
        workloadId: 'library-curator',
        model: { mode: 'inherit-default' },
        runtime: {
          thinkingLevel: 'medium',
          maxTokens: 0,
          timeoutMs: 120_000,
          cacheRetention: 'short'
        },
        compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
        limits: { maxTurns: 0, maxContextTokens: 128_000 },
        resolution: { ready: true, modelRef: 'model:test:default' }
      }
    ],
    validationErrors: []
  }
}

describe('AgentConfiguration', () => {
  it('projects code-owned tools and permissions while injecting workload compaction', () => {
    const configuration = new AgentConfiguration({ read: snapshot })
    const { revision, profile, definition } = configuration.getProfile(
      'profile:plugin-developer:default'
    )

    assert.equal(revision, 'model-management:r1')
    assert.equal(definition.id, 'plugin-developer')
    assert.deepEqual(profile.toolPackRefs, ['toolpack:plugin-developer:v1'])
    assert.deepEqual(profile.capabilityGrants, [
      'plugin.test',
      'plugin.workspace.read',
      'plugin.write',
      'browser.read',
      'browser.interact'
    ])
    assert.deepEqual(profile.approvalRequiredEffects, ['credential-sensitive'])
    assert.deepEqual(profile.compaction, {
      enabled: true,
      reserveTokens: 12_000,
      keepRecentTokens: 18_000
    })
    assert.equal(profile.routes.primary, 'workload:plugin-developer')
    assert.equal(profile.routes.verifier, profile.routes.primary)
    assert.equal(profile.routes.summarizer, profile.routes.primary)
  })

  it('binds metadata collection to the curator workload and explicit staging capabilities', () => {
    const configuration = new AgentConfiguration({ read: snapshot })
    const { profile, definition, workload } = configuration.getProfile(
      'profile:metadata-collector:default'
    )

    assert.equal(definition.id, 'metadata-collector')
    assert.equal(workload.workloadId, 'library-curator')
    assert.deepEqual(profile.toolPackRefs, ['toolpack:metadata-collector:v1'])
    assert.deepEqual(profile.capabilityGrants, [
      'browser.read',
      'metadata.stage-remote-candidate'
    ])
    assert.deepEqual(profile.approvalRequiredEffects, [])
  })

  it('registers playlist import as an independent least-privilege use case', () => {
    const configuration = new AgentConfiguration({ read: snapshot })
    const { profile, definition, workload } = configuration.getProfile(
      'profile:playlist-importer:default'
    )

    assert.equal(definition.id, 'playlist-importer')
    assert.equal(workload.workloadId, 'library-curator')
    assert.deepEqual(profile.toolPackRefs, ['toolpack:playlist-importer:v1'])
    assert.deepEqual(profile.capabilityGrants, [
      'browser.interact',
      'playlist-import.stage-page',
      'playlist-import.stage-identity'
    ])
    assert.deepEqual(profile.approvalRequiredEffects, [])
  })
})
