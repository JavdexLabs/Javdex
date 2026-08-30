import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { AGENT_PLATFORM_SCHEMA_SQL } from '../db/schema'
import { AgentRunStore, setAgentPayloadCipherForTests } from './agentRunStore'
import type { ResolvedRunConfiguration, RuntimeRecoveryFrame } from './types'

function resolved(): ResolvedRunConfiguration {
  return {
    revision: 'revision-1',
    definitionId: 'test-agent',
    profile: {
      id: 'profile:test',
      name: 'Test',
      definitionId: 'test-agent',
      routes: { primary: 'r1', verifier: 'r2', summarizer: 'r3' },
      toolPackRefs: [],
      capabilityGrants: [],
      approvalRequiredEffects: [],
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 }
    },
    model: {
      credentialRef: 'llm-provider:test',
      model: {
        providerId: 'test', modelId: 'model', name: 'Test', api: 'openai-completions',
        baseUrl: 'https://example.invalid/v1', contextWindow: 8_192, maxTokens: 1_024, reasoning: false
      },
      routeRevision: 'revision-1:r1',
      preset: { thinkingLevel: 'minimal', maxTokens: 1_024, timeoutMs: 1_000, cacheRetention: 'none' },
      cacheCompatibility: {
        supportsPromptCache: false,
        supportsLongCacheRetention: false,
        sendSessionAffinityHeaders: false,
        evidence: { source: 'manual', checkedAt: '2026-01-01T00:00:00.000Z' }
      },
      getCredentialLease: async () => { throw new Error('not used') }
    },
    verifierModel: {
      credentialRef: 'llm-provider:verifier-test',
      model: {
        providerId: 'verifier-test', modelId: 'verifier-model', name: 'Verifier', api: 'openai-completions',
        baseUrl: 'https://verifier.invalid/v1', contextWindow: 4_096, maxTokens: 512, reasoning: false
      },
      routeRevision: 'revision-1:r2',
      preset: { thinkingLevel: 'minimal', maxTokens: 512, timeoutMs: 2_000, cacheRetention: 'none' },
      cacheCompatibility: {
        supportsPromptCache: false,
        supportsLongCacheRetention: false,
        sendSessionAffinityHeaders: false,
        evidence: { source: 'manual', checkedAt: '2026-01-01T00:00:00.000Z' }
      },
      getCredentialLease: async () => { throw new Error('not used') }
    },
    cache: {
      primaryAffinityId: 'jvx_primary', verifierAffinityId: 'jvx_verifier',
      summarizerAffinityId: 'jvx_summarizer',
      retention: { primary: 'none', verifier: 'none', summarizer: 'none' }
    },
    systemPrompt: {
      text: 'test prompt',
      sha256: createHash('sha256').update('test prompt').digest('hex')
    },
    tools: [],
    settings: {
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 }
    },
    sessionDirectory: '/tmp/javdex-agent-test'
  }
}

function createStore(): { db: Database.Database; store: AgentRunStore } {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(AGENT_PLATFORM_SCHEMA_SQL)
  return { db, store: new AgentRunStore(() => db) }
}

afterEach(() => setAgentPayloadCipherForTests(null))

describe('AgentRunStore', () => {
  it('returns every durable non-closed run so each use case can apply its recovery policy', () => {
    const { db, store } = createStore()
    try {
      for (const id of ['created', 'running', 'waiting', 'settled', 'failed', 'cancelled']) {
        store.createRun({ runId: id, useCase: 'test-agent', resolved: resolved(), productState: {} })
      }
      store.updateProductState('running', 'running', {})
      store.updateProductState('waiting', 'waiting_user', {})
      store.updateProductState('settled', 'settled', {})
      store.updateProductState('failed', 'failed', {})
      store.updateProductState('cancelled', 'cancelled', {})

      assert.deepEqual(
        store.listRecoverableRuns().map((run) => run.id).sort(),
        ['cancelled', 'created', 'failed', 'running', 'settled', 'waiting']
      )
    } finally {
      db.close()
    }
  })

  it('persists a frozen config without serializing credentials or functions', () => {
    const { db, store } = createStore()
    try {
      const run = store.createRun({
        runId: 'run-1', useCase: 'test-agent', resolved: resolved(), productState: { status: 'ready' }
      })
      assert.equal(run.configSnapshot.model.credentialRef, 'llm-provider:test')
      assert.equal(run.configSnapshot.verifierModel?.credentialRef, 'llm-provider:verifier-test')
      assert.equal(run.configSnapshot.verifierModel?.descriptor.modelId, 'verifier-model')
      const raw = (db.prepare('SELECT config_snapshot_json AS value FROM agent_runs').get() as { value: string }).value
      assert.doesNotMatch(raw, /getCredentialLease|api[-_ ]?key|secret/i)
    } finally {
      db.close()
    }
  })

  it('encrypts recovery payloads and fails closed on integrity damage', () => {
    const { db, store } = createStore()
    setAgentPayloadCipherForTests({
      encrypt: (value) => Buffer.from(value.split('').reverse().join(''), 'utf8'),
      decrypt: (value) => value.toString('utf8').split('').reverse().join('')
    })
    try {
      store.createRun({ runId: 'run-2', useCase: 'test-agent', resolved: resolved(), productState: {} })
      const payload = JSON.stringify({ kind: 'message', value: { role: 'user', content: 'private' } })
      const recovery: RuntimeRecoveryFrame = {
        codecVersion: 1,
        payload,
        contentHash: createHash('sha256').update(payload).digest('hex')
      }
      store.commitRuntimeObservation('run-2', {
        type: 'message.completed',
        audit: { role: 'user', textPreview: 'private', contentHash: 'audit-hash' },
        recovery
      })
      const ciphertext = (db.prepare('SELECT recovery_ciphertext AS value FROM agent_execution_history').get() as { value: Buffer }).value
      assert.doesNotMatch(ciphertext.toString('utf8'), /private/)
      assert.equal(store.readExecutionHistory('run-2')[0]?.recovery.payload, payload)
      db.prepare("UPDATE agent_execution_history SET content_hash = 'damaged'").run()
      assert.throws(() => store.readExecutionHistory('run-2'), /完整性校验失败/)
    } finally {
      db.close()
    }
  })

  it('accepts an idempotent operation once and settles only named command ids', () => {
    const { db, store } = createStore()
    try {
      store.createRun({ runId: 'run-3', useCase: 'test-agent', resolved: resolved(), productState: {} })
      const first = store.acceptOperation({
        runId: 'run-3', commandKind: 'prompt', idempotencyKey: 'same', content: 'hello'
      })
      const duplicate = store.acceptOperation({
        runId: 'run-3', commandKind: 'prompt', idempotencyKey: 'same', content: 'hello'
      })
      assert.equal(first.created, true)
      assert.equal(duplicate.created, false)
      assert.equal(duplicate.operation.id, first.operation.id)
      assert.throws(() => store.acceptOperation({
        runId: 'run-3', commandKind: 'prompt', idempotencyKey: 'same', content: 'different'
      }), /不同命令/)
      store.commitRuntimeObservation('run-3', {
        type: 'agent.settled', acceptedCommandIds: [first.operation.id]
      })
      const operation = db.prepare('SELECT status FROM agent_operations WHERE id = ?').get(first.operation.id) as { status: string }
      assert.equal(operation.status, 'settled')
      assert.equal(store.getRun('run-3')?.status, 'settled')
    } finally {
      db.close()
    }
  })

  it('keeps repeated product events from the same operation in append order', () => {
    const { db, store } = createStore()
    try {
      store.createRun({
        runId: 'run-repeated-events',
        useCase: 'test-agent',
        resolved: resolved(),
        productState: {}
      })
      const operation = store.acceptOperation({
        runId: 'run-repeated-events',
        commandKind: 'prompt',
        idempotencyKey: 'read-workspace',
        content: 'read the required files'
      }).operation

      store.appendProductEvent(
        'run-repeated-events',
        operation.id,
        'plugin.tool_start',
        { callId: 'read-skill' }
      )
      store.appendProductEvent(
        'run-repeated-events',
        operation.id,
        'plugin.tool_start',
        { callId: 'read-task' }
      )

      assert.deepEqual(
        store.readProductJournal<{ callId: string }>('run-repeated-events').map((event) => ({
          eventType: event.eventType,
          operationId: event.operationId,
          callId: event.payload.callId
        })),
        [
          {
            eventType: 'plugin.tool_start',
            operationId: operation.id,
            callId: 'read-skill'
          },
          {
            eventType: 'plugin.tool_start',
            operationId: operation.id,
            callId: 'read-task'
          }
        ]
      )
    } finally {
      db.close()
    }
  })

  it('does not overwrite a terminal runtime fault when the runtime subsequently settles', () => {
    const { db, store } = createStore()
    try {
      store.createRun({ runId: 'run-fault', useCase: 'test-agent', resolved: resolved(), productState: {} })
      const operation = store.acceptOperation({
        runId: 'run-fault', commandKind: 'prompt', idempotencyKey: 'fault', content: 'fail'
      }).operation
      store.commitRuntimeObservation('run-fault', {
        type: 'runtime.fault', category: 'provider-failed', message: 'Connection error.'
      })
      store.commitRuntimeObservation('run-fault', {
        type: 'agent.settled', acceptedCommandIds: [operation.id]
      })

      assert.equal(store.getRun('run-fault')?.status, 'failed')
      assert.equal(
        (db.prepare('SELECT status FROM agent_operations WHERE id = ?').get(operation.id) as { status: string }).status,
        'failed'
      )
    } finally {
      db.close()
    }
  })

  it('allows one rebuild attempt per recovery generation', () => {
    const { db, store } = createStore()
    try {
      store.createRun({ runId: 'run-4', useCase: 'test-agent', resolved: resolved(), productState: {} })
      assert.equal(store.beginRecoveryAttempt('run-4', 0), true)
      assert.equal(store.beginRecoveryAttempt('run-4', 0), false)
      store.commitRebuild('run-4', {
        runtimeId: 'pi', sessionId: 'session', sessionFile: '/tmp/session.jsonl', codecVersion: 1
      })
      assert.equal(store.getRun('run-4')?.recoveryGeneration, 1)
      assert.equal(store.beginRecoveryAttempt('run-4', 1), true)
    } finally {
      db.close()
    }
  })

  it('records artifact refs in the product journal and fails closed on damaged refs', () => {
    const { db, store } = createStore()
    try {
      store.createRun({ runId: 'run-5', useCase: 'test-agent', resolved: resolved(), productState: {} })
      const artifact = store.recordArtifact({
        artifactId: 'artifact-1',
        runId: 'run-5',
        kind: 'plugin-package',
        label: 'Test package',
        ref: { productStatePath: 'package', codeHash: 'abc123' }
      })
      assert.equal(artifact.id, 'artifact-1')
      assert.deepEqual(store.listArtifacts('run-5')[0]?.ref, {
        productStatePath: 'package', codeHash: 'abc123'
      })
      assert.equal(store.readProductJournal('run-5').at(-1)?.eventType, 'artifact.recorded')
      db.prepare("UPDATE agent_artifacts SET ref_json = '{\"damaged\":true}' WHERE id = 'artifact-1'").run()
      assert.throws(() => store.listArtifacts('run-5'), /完整性校验失败/)
    } finally {
      db.close()
    }
  })
})
