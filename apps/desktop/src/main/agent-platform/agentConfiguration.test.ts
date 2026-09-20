import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelManagementSnapshot } from '@shared/modelManagementTypes'
import { AgentConfiguration } from './agentConfiguration'

function snapshot(): ModelManagementSnapshot {
  return {
    schemaVersion: 3,
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
          timeoutMs: 120_000
        },

        limits: { maxTurns: 0, maxContextTokens: 128_000 },
        resolution: { ready: true, modelRef: 'model:test:default' }
      },
      {
        workloadId: 'plugin-developer',
        model: { mode: 'inherit-default' },
        runtime: {
          thinkingLevel: 'high',
          maxTokens: 0,
          timeoutMs: 240_000
        },

        limits: { maxTurns: 0, maxContextTokens: 96_000 },
        resolution: { ready: true, modelRef: 'model:test:default' }
      },
      {
        workloadId: 'library-curator',
        model: { mode: 'inherit-default' },
        runtime: {
          thinkingLevel: 'medium',
          maxTokens: 0,
          timeoutMs: 120_000
        },

        limits: { maxTurns: 0, maxContextTokens: 128_000 },
        resolution: { ready: true, modelRef: 'model:test:default' }
      }
    ],
    validationErrors: []
  }
}

describe('AgentConfiguration', () => {
  it('projects code-owned tool permissions independently of model selection', () => {
    const configuration = new AgentConfiguration({ read: snapshot })
    const { revision, policy, definition } = configuration.getConfiguration(
      'plugin-developer'
    )

    assert.equal(revision, 'model-management:r1')
    assert.equal(definition.id, 'plugin-developer')
    assert.deepEqual(policy.toolPackRefs, ['toolpack:plugin-developer:v1'])
    assert.deepEqual(policy.capabilityGrants, [
      'plugin.test',
      'plugin.workspace.read',
      'plugin.write',
      'browser.read',
      'browser.interact'
    ])
    assert.deepEqual(policy.approvalRequiredEffects, ['credential-sensitive'])

  })

  it('binds metadata collection to the curator workload and explicit staging capabilities', () => {
    const configuration = new AgentConfiguration({ read: snapshot })
    const { policy, definition, workload } = configuration.getConfiguration(
      'metadata-collector'
    )

    assert.equal(definition.id, 'metadata-collector')
    assert.equal(workload.workloadId, 'library-curator')
    assert.deepEqual(policy.toolPackRefs, ['toolpack:metadata-collector:v1'])
    assert.deepEqual(policy.capabilityGrants, [
      'browser.read',
      'metadata.stage-remote-candidate'
    ])
    assert.deepEqual(policy.approvalRequiredEffects, [])
  })

  it('registers playlist import as an independent least-privilege use case', () => {
    const configuration = new AgentConfiguration({ read: snapshot })
    const { policy, definition, workload } = configuration.getConfiguration(
      'playlist-importer'
    )

    assert.equal(definition.id, 'playlist-importer')
    assert.equal(workload.workloadId, 'library-curator')
    assert.deepEqual(policy.toolPackRefs, ['toolpack:playlist-importer:v1'])
    assert.deepEqual(policy.capabilityGrants, [
      'browser.interact',
      'playlist-import.stage-page',
      'playlist-import.stage-identity'
    ])
    assert.deepEqual(policy.approvalRequiredEffects, [])
  })
})
