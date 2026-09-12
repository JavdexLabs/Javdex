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
        [...store.iterateRecoverableRuns('test-agent')].map((run) => run.id).sort(),
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
      const journal = db.prepare(
        "SELECT payload_json AS value FROM agent_product_journal WHERE event_type = 'runtime.message.completed'"
      ).get() as { value: string }
      assert.doesNotMatch(journal.value, /recovery|payload|"content"/)
      assert.deepEqual(JSON.parse(journal.value), {
        type: 'message.completed',
        audit: { role: 'user', textPreview: 'private', contentHash: 'audit-hash' }
      })
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

describe('Agent product journal pagination', () => {
  it('reads the last cursor through the run/seq index without parsing any payload in a 100k journal', (t) => {
    const { db, store } = createStore()
    try {
      store.createRun({ runId: 'large', useCase: 'test-agent', resolved: resolved(), productState: {} })
      store.createRun({ runId: 'other', useCase: 'test-agent', resolved: resolved(), productState: {} })
      assert.equal(store.getProductJournalCursor('large'), 0)
      assert.equal(store.getProductJournalCursor('missing'), 0)
      const insert = db.prepare(`INSERT INTO agent_product_journal
        (run_id, event_type, payload_json, created_at) VALUES (?, 'test', ?, '2026-09-10')`)
      db.transaction(() => {
        for (let index = 0; index < 100_000; index++) insert.run('large', 'invalid JSON must not be decoded for a cursor')
        insert.run('other', '{}')
      })()
      const parse = t.mock.method(JSON, 'parse', () => { throw new Error('unexpected payload parse') })
      const prepare = t.mock.method(db, 'prepare')
      assert.equal(store.getProductJournalCursor('large'), 100_000)
      assert.equal(prepare.mock.callCount(), 1)
      const sql = prepare.mock.calls[0].arguments[0]
      assert.equal(/payload_json|SELECT\s+\*/i.test(sql), false)
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('large') as Array<{ detail: string }>
      assert.ok(plan.some((row) => /COVERING INDEX idx_agent_product_journal_run_seq/.test(row.detail)))
      assert.equal(plan.some((row) => /TEMP B-TREE|SCAN agent_product_journal/.test(row.detail)), false)
      assert.equal(parse.mock.callCount(), 0)
      parse.mock.restore()
      assert.throws(() => store.readProductJournal('large', 99_999, 1), SyntaxError)
    } finally {
      t.mock.restoreAll()
      db.close()
    }
  })

  it('pages with a strict size cap and no cross-run, duplicate or skipped events despite sequence gaps', (t) => {
    const { db, store } = createStore()
    try {
      store.createRun({ runId: 'paged', useCase: 'test-agent', resolved: resolved(), productState: {} })
      store.createRun({ runId: 'other', useCase: 'test-agent', resolved: resolved(), productState: {} })
      const expected: number[] = []
      db.transaction(() => {
        for (let index = 0; index < 1001; index++) {
          expected.push(store.appendProductEvent('paged', undefined, 'test', { index }))
          store.appendProductEvent('other', undefined, 'other', { index })
        }
      })()
      const parse = t.mock.method(JSON, 'parse')
      const first = store.readProductJournal<{ index: number }>('paged')
      assert.equal(first.length, 500)
      assert.equal(parse.mock.callCount(), 500)
      const second = store.readProductJournal<{ index: number }>('paged', first.at(-1)!.seq)
      const third = store.readProductJournal<{ index: number }>('paged', second.at(-1)!.seq)
      assert.equal(second.length, 500)
      assert.equal(third.length, 1)
      const all = [...first, ...second, ...third]
      assert.deepEqual(all.map((row) => row.seq), expected)
      assert.deepEqual(all.map((row) => row.payload.index), Array.from({ length: 1001 }, (_, index) => index))
      assert.ok(all.every((row) => row.runId === 'paged'))
      assert.deepEqual(store.readProductJournal('paged', third[0].seq), [])
      assert.equal(store.readProductJournal('paged', 0, 1).length, 1)
      assert.deepEqual(store.readProductJournal('missing'), [])
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => store.readProductJournal('paged', value), /cursor/)
      }
      for (const value of [0, -1, 0.5, 501, NaN, Infinity]) {
        assert.throws(() => store.readProductJournal('paged', 0, value), /limit/)
      }
      assert.equal((db.prepare('SELECT COUNT(*) AS total FROM agent_product_journal').get() as { total: number }).total, 2002)
    } finally {
      t.mock.restoreAll()
      db.close()
    }
  })
})

describe('Agent recovery enumeration', () => {
  it('filters use case and status before parsing, lazily loads one product, and releases temporary ID pages', (t) => {
    const { db, store } = createStore()
    try {
      const insert = db.prepare(`INSERT INTO agent_runs
        (id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
        VALUES (?,?,?,'test',?,'pi',?,'now',?)`)
      db.transaction(() => {
        for (let index = 0; index < 10_000; index++) {
          insert.run(`other-${index}`, 'other', 'waiting_user', 'bad JSON', 'bad JSON', '0')
          insert.run(`closed-${index}`, 'owned', 'closed', 'bad JSON', 'bad JSON', '0')
        }
        insert.run('settled', 'owned', 'settled', 'bad JSON', 'bad JSON', '0')
        for (let index = 0; index < 260; index++) {
          insert.run(`owned-${index}`, 'owned', 'waiting_user', '{}', JSON.stringify({ index }), String(1000 - index).padStart(4, '0'))
        }
      })()
      const get = t.mock.method(store, 'getRun')
      const iter = store.iterateRecoverableRuns('owned', ['waiting_user'])
      assert.equal(get.mock.callCount(), 0)
      assert.equal(iter.next().value!.id, 'owned-259')
      assert.equal(get.mock.callCount(), 1)
      assert.equal((db.prepare("SELECT COUNT(*) AS total FROM sqlite_temp_master WHERE name LIKE 'agent_restore_%'")
        .get() as { total: number }).total, 1)
      iter.return(undefined)
      assert.equal((db.prepare("SELECT COUNT(*) AS total FROM sqlite_temp_master WHERE name LIKE 'agent_restore_%'")
        .get() as { total: number }).total, 0)
      assert.equal([...store.iterateRecoverableRuns('owned', ['waiting_user'])].length, 260)
      assert.equal(get.mock.callCount(), 261, 'only the one early result plus owned eligible records are parsed')
      assert.deepEqual([...store.iterateRecoverableRunIds('owned', ['settled'])], ['settled'], 'ID-only cleanup must not parse corrupt payloads')
      assert.deepEqual([...store.iterateRecoverableRuns('owned', [])], [])
    } finally {
      t.mock.restoreAll()
      db.close()
    }
  })

  it('keeps the original recovery order across pages while timestamps change and excludes runs created mid-iteration', () => {
    const { db, store } = createStore()
    try {
      for (let index = 0; index < 260; index++) {
        store.createRun({ runId: `run-${index}`, useCase: 'owned', resolved: resolved(), productState: {} })
        db.prepare('UPDATE agent_runs SET updated_at = ? WHERE id = ?').run(String(1000 - index).padStart(4, '0'), `run-${index}`)
      }
      const seen: string[] = []
      for (const run of store.iterateRecoverableRuns('owned')) {
        seen.push(run.id)
        store.updateProductState(run.id, 'waiting_user', { restored: true })
        if (seen.length === 1) {
          store.createRun({ runId: 'new-run', useCase: 'owned', resolved: resolved(), productState: {} })
          store.closeRun('run-0')
        }
      }
      assert.deepEqual(seen, Array.from({ length: 259 }, (_, index) => `run-${259 - index}`))
      assert.equal(new Set(seen).size, 259)
      assert.equal((db.prepare("SELECT COUNT(*) AS total FROM sqlite_temp_master WHERE name LIKE 'agent_restore_%'")
        .get() as { total: number }).total, 0)
      assert.throws(() => [...store.iterateRecoverableRuns(' ')], /must not be empty/)
    } finally { db.close() }
  })

  it('drops the temporary snapshot if an owned payload cannot be parsed', () => {
    const { db, store } = createStore()
    try {
      store.createRun({ runId: 'bad-owned', useCase: 'owned', resolved: resolved(), productState: {} })
      db.prepare("UPDATE agent_runs SET product_state_json = 'bad JSON' WHERE id = 'bad-owned'").run()
      assert.throws(() => [...store.iterateRecoverableRuns('owned')], SyntaxError)
      assert.equal((db.prepare("SELECT COUNT(*) AS total FROM sqlite_temp_master WHERE name LIKE 'agent_restore_%'")
        .get() as { total: number }).total, 0)
    } finally { db.close() }
  })
})
