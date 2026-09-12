import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { AGENT_PLATFORM_SCHEMA_SQL } from '../db/schema'
import { AgentExecution } from './agentExecution'
import type { PluginDevAgentWorkLogEntry } from '@shared/pluginDevTypes'
import { appendPluginWorkLog, readPluginWorkLog, type PersistedPluginWorkLog } from '../services/pluginDevAgent/workLogPersistence'
import { AgentRunStore, setAgentPayloadCipherForTests } from './agentRunStore'
import type {
  AgentRuntimePort,
  ResolvedRunConfiguration,
  RuntimeObserver,
  RuntimeSessionInit,
  RuntimeSessionInitWithoutResume,
  RuntimeSessionPort
} from './types'

function resolved(): ResolvedRunConfiguration {
  const prompt = 'stable prompt'
  return {
    revision: 'rev', definitionId: 'test',
    profile: {
      id: 'profile:test', name: 'Test', definitionId: 'test',
      routes: { primary: 'r1', verifier: 'r2', summarizer: 'r3' },
      toolPackRefs: [], capabilityGrants: [], approvalRequiredEffects: [],
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 }
    },
    model: {
      credentialRef: 'llm-provider:test',
      model: {
        providerId: 'test', modelId: 'test', name: 'Test', api: 'openai-completions',
        baseUrl: 'https://example.invalid/v1', contextWindow: 4_000, maxTokens: 500, reasoning: false
      },
      routeRevision: 'rev:r1',
      preset: { thinkingLevel: 'minimal', maxTokens: 500, timeoutMs: 1_000, cacheRetention: 'none' },
      cacheCompatibility: {
        supportsPromptCache: false, supportsLongCacheRetention: false,
        sendSessionAffinityHeaders: false,
        evidence: { source: 'manual', checkedAt: '2026-01-01T00:00:00.000Z' }
      },
      getCredentialLease: async () => { throw new Error('not used') }
    },
    cache: {
      primaryAffinityId: 'p', verifierAffinityId: 'v', summarizerAffinityId: 's',
      retention: { primary: 'none', verifier: 'none', summarizer: 'none' }
    },
    systemPrompt: { text: prompt, sha256: createHash('sha256').update(prompt).digest('hex') },
    tools: [],
    settings: {
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 }
    },
    sessionDirectory: '/tmp/agent-execution-test'
  }
}

function storeHarness() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(AGENT_PLATFORM_SCHEMA_SQL)
  return { db, store: new AgentRunStore(() => db) }
}

class FakeRuntime implements AgentRuntimePort {
  readonly runtimeId = 'pi' as const
  openCount = 0
  rebuildCount = 0
  disposeCount = 0
  observer?: RuntimeObserver
  failOpen: Error | null = null
  failRebuild: Error | null = null

  private session(input: RuntimeSessionInit): RuntimeSessionPort {
    const ref = {
      runtimeId: 'pi' as const,
      sessionId: 'fake-session',
      sessionFile: `${input.sessionDirectory}/fake.jsonl`,
      codecVersion: 1 as const
    }
    return {
      ref,
      dispatch: async (command) => {
        await this.observer!.commit({ type: 'agent.settled', acceptedCommandIds: [command.commandId] })
        return { accepted: true }
      },
      requestManualCompaction: async (commandId) => {
        await this.observer!.commit({ type: 'agent.settled', acceptedCommandIds: [commandId] })
        return { accepted: true }
      },
      abort: async () => undefined,
      dispose: async () => { this.disposeCount += 1 }
    }
  }

  async open(input: RuntimeSessionInit, observer: RuntimeObserver) {
    this.openCount += 1
    this.observer = observer
    if (this.failOpen) throw this.failOpen
    const session = this.session(input)
    await observer.commit({ type: 'session.saved', ref: session.ref })
    return { source: input.resume ? 'restored' as const : 'created' as const, session }
  }

  async rebuild(
    input: RuntimeSessionInitWithoutResume,
    _history: readonly import('./types').ExecutionHistoryFrame[],
    observer: RuntimeObserver
  ): Promise<RuntimeSessionPort> {
    this.rebuildCount += 1
    this.observer = observer
    if (this.failRebuild) throw this.failRebuild
    return this.session(input)
  }
}

afterEach(() => setAgentPayloadCipherForTests(null))

describe('AgentExecution', () => {
  it('runs the persistence hook before the runtime can commit its bootstrap observation', async () => {
    const { db, store } = storeHarness()
    const runtime = new FakeRuntime()
    const execution = new AgentExecution(store, async () => runtime)
    const sequence: string[] = []
    try {
      await execution.openRun({
        runId: 'run-bootstrap-order',
        useCase: 'test',
        resolved: resolved(),
        productState: {},
        afterPersist: () => { sequence.push('persisted') },
        project: (event, current) => {
          sequence.push(event.type)
          return { state: current }
        }
      })

      assert.deepEqual(sequence, ['persisted', 'session.saved'])
    } finally {
      await execution.dispose()
      db.close()
    }
  })

  it('opens one runtime session and delegates ten operations without a loop or second queue', async () => {
    const { db, store } = storeHarness()
    const runtime = new FakeRuntime()
    const execution = new AgentExecution(store, async () => runtime)
    try {
      await execution.openRun({
        runId: 'run-ten', useCase: 'test', resolved: resolved(), productState: { status: 'ready' }
      })
      const kinds = ['prompt', 'steer', 'follow-up'] as const
      for (let index = 0; index < 10; index += 1) {
        const response = await execution.dispatch({
          runId: 'run-ten',
          kind: kinds[index % kinds.length]!,
          text: `operation ${index}`,
          idempotencyKey: `operation:${index}`
        })
        assert.equal(response.accepted, true)
      }
      assert.equal(runtime.openCount, 1)
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM agent_operations WHERE status = 'settled'").get() as { count: number }).count, 10)
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM agent_product_journal WHERE event_type = 'telemetry.operation'").get() as { count: number }).count, 10)
    } finally {
      await execution.dispose()
      db.close()
    }
  })

  it('authorizes and records Pi native tools without persisting their output', async () => {
    const { db, store } = storeHarness()
    const runtime = new FakeRuntime()
    const execution = new AgentExecution(store, async () => runtime)
    const configuration = resolved()
    configuration.profile.capabilityGrants = ['plugin.workspace.read', 'plugin.write']
    configuration.resources = {
      nativeTools: ['read', 'write'],
      skillNames: []
    }
    setAgentPayloadCipherForTests({
      encrypt: (value) => Buffer.from([...value].reverse().join(''), 'utf8'),
      decrypt: (value) => [...value.toString('utf8')].reverse().join('')
    })
    try {
      await execution.openRun({
        runId: 'run-native-tools', useCase: 'test', resolved: configuration, productState: {}
      })
      await runtime.observer!.commit({
        type: 'tool.started',
        call: { callId: 'native-read', toolName: 'read', argsDigest: 'read-digest' }
      })
      const payload = JSON.stringify({ kind: 'tool-result', value: 'private file content' })
      await runtime.observer!.commit({
        type: 'tool.completed',
        result: { callId: 'native-read', toolName: 'read', ok: true, summary: 'private file content' },
        recovery: {
          codecVersion: 1,
          payload,
          contentHash: createHash('sha256').update(payload).digest('hex')
        }
      })

      const row = db.prepare(
        'SELECT effect, status, result_json FROM agent_tool_ledger WHERE call_id = ?'
      ).get('native-read') as { effect: string; status: string; result_json: string }
      assert.equal(row.effect, 'read')
      assert.equal(row.status, 'completed')
      assert.doesNotMatch(row.result_json, /private file content/)
      assert.match(row.result_json, /summaryHash/)
    } finally {
      await execution.dispose()
      db.close()
    }
  })

  it('fails closed when a Pi native tool lacks a frozen capability grant', async () => {
    const { db, store } = storeHarness()
    const runtime = new FakeRuntime()
    const execution = new AgentExecution(store, async () => runtime)
    const configuration = resolved()
    configuration.resources = { nativeTools: ['write'], skillNames: [] }
    try {
      await assert.rejects(() => execution.openRun({
        runId: 'run-native-denied', useCase: 'test', resolved: configuration, productState: {}
      }), /未授权 Pi 原生工具能力/)
      assert.equal(runtime.openCount, 0)
      assert.equal(store.getRun('run-native-denied'), null)
    } finally {
      await execution.dispose()
      db.close()
    }
  })

  it('restores a normal checkpoint without reading ExecutionHistory', async () => {
    const { db, store } = storeHarness()
    const firstRuntime = new FakeRuntime()
    const first = new AgentExecution(store, async () => firstRuntime)
    try {
      await first.openRun({ runId: 'run-restore', useCase: 'test', resolved: resolved(), productState: {} })
      await first.dispose()
      const record = store.getRun('run-restore')!
      const original = store.readExecutionHistory.bind(store)
      store.readExecutionHistory = () => { throw new Error('normal restore must not read history') }
      const restoredRuntime = new FakeRuntime()
      const restored = new AgentExecution(store, async () => restoredRuntime)
      const opened = await restored.openRun({
        useCase: 'test', resolved: resolved(), productState: {}, resume: record
      })
      assert.equal(opened.source, 'restored')
      assert.equal(restoredRuntime.openCount, 1)
      store.readExecutionHistory = original
      await restored.dispose()
    } finally {
      db.close()
    }
  })

  it('rebuilds only for typed checkpoint corruption and only once per generation', async () => {
    const { db, store } = storeHarness()
    setAgentPayloadCipherForTests({
      encrypt: (value) => Buffer.from(value, 'utf8'),
      decrypt: (value) => value.toString('utf8')
    })
    try {
      store.createRun({ runId: 'run-corrupt', useCase: 'test', resolved: resolved(), productState: {} })
      store.commitRuntimeObservation('run-corrupt', {
        type: 'session.saved',
        ref: { runtimeId: 'pi', sessionId: 'bad', sessionFile: '/tmp/bad.jsonl', codecVersion: 1 }
      })
      const payload = JSON.stringify({ kind: 'message', value: { role: 'user', content: 'hello' } })
      store.commitRuntimeObservation('run-corrupt', {
        type: 'message.completed',
        audit: { role: 'user', textPreview: 'hello', contentHash: 'audit' },
        recovery: {
          codecVersion: 1, payload,
          contentHash: createHash('sha256').update(payload).digest('hex')
        }
      })
      const runtime = new FakeRuntime()
      runtime.failOpen = new Error('checkpoint-corrupt: broken')
      runtime.failRebuild = new Error('rebuild failed')
      const first = new AgentExecution(store, async () => runtime)
      await assert.rejects(() => first.openRun({
        useCase: 'test', resolved: resolved(), productState: {}, resume: store.getRun('run-corrupt')!
      }), /rebuild failed/)
      assert.equal(runtime.rebuildCount, 1)
      const second = new AgentExecution(store, async () => runtime)
      await assert.rejects(() => second.openRun({
        useCase: 'test', resolved: resolved(), productState: {}, resume: store.getRun('run-corrupt')!
      }), /已尝试过重建/)
      assert.equal(runtime.rebuildCount, 1)
    } finally {
      db.close()
    }
  })

  it('releases runtime resources without closing the durable run', async () => {
    const { db, store } = storeHarness()
    const runtime = new FakeRuntime()
    const execution = new AgentExecution(store, async () => runtime)
    try {
      await execution.openRun({
        runId: 'run-release', useCase: 'test', resolved: resolved(), productState: {}
      })
      await execution.releaseRun('run-release')

      assert.equal(runtime.disposeCount, 1)
      assert.equal(execution.hasActiveRun('run-release'), false)
      assert.ok(store.getRun('run-release'))
      assert.notEqual(store.getRun('run-release')?.status, 'closed')
    } finally {
      await execution.dispose()
      db.close()
    }
  })

  it('closes a durable run after its runtime was already released', async () => {
    const { db, store } = storeHarness()
    const runtime = new FakeRuntime()
    const execution = new AgentExecution(store, async () => runtime)
    try {
      await execution.openRun({
        runId: 'run-clear-history', useCase: 'plugin-developer', resolved: resolved(), productState: {}
      })
      await execution.releaseRun('run-clear-history')
      assert.equal(execution.hasActiveRun('run-clear-history'), false)

      await execution.closeRun('run-clear-history')

      assert.equal(store.getRun('run-clear-history')?.status, 'closed')
      assert.equal(store.findLatestRun('plugin-developer'), null)
    } finally {
      await execution.dispose()
      db.close()
    }
  })
})

it('preserves newer product log references when aborting after a domain-only state update', async () => {
  const { db, store } = storeHarness()
  const runtime = new FakeRuntime()
  const execution = new AgentExecution(store, async () => runtime)
  try {
    await execution.openRun({ runId: 'abort-newer-state', useCase: 'test', resolved: resolved(),
      productState: { summary: 'old', workLog: { count: 1, throughSeq: 1 } } })
    const latest = { summary: 'new domain event', workLog: { count: 2, throughSeq: 7 } }
    store.updateProductState('abort-newer-state', 'waiting_user', latest)
    await execution.abort('abort-newer-state', 'stop')
    assert.equal(store.getRun('abort-newer-state')?.status, 'cancelled')
    assert.deepEqual(store.getRun('abort-newer-state')?.productState, latest)
  } finally {
    await execution.dispose()
    db.close()
  }
})


for (const scenario of ['success', 'hash-failure', 'rebuild-failure', 'unreconciled-tool'] as const) {
  it(`preserves append-only plugin history during checkpoint recovery: ${scenario}`, async (t) => {
    const { db, store } = storeHarness()
    const runtime = new FakeRuntime()
    runtime.failOpen = new Error('checkpoint-corrupt: test checkpoint')
    if (scenario === 'rebuild-failure') runtime.failRebuild = new Error('rebuild failed')
    const execution = new AgentExecution(store, async () => runtime)
    setAgentPayloadCipherForTests({
      encrypt: (value) => Buffer.from(`test-cipher:${value}`),
      decrypt: (value) => {
        assert.ok(value.toString().startsWith('test-cipher:'))
        return value.toString().slice('test-cipher:'.length)
      }
    })
    type State = { schemaVersion: number; workLog: PersistedPluginWorkLog }
    const entries: PluginDevAgentWorkLogEntry[] = Array.from({ length: 1001 }, (_, index) => ({
      at: '2026-09-10T00:00:00Z', kind: 'user_message', sessionId: 'recovery-log', source: 'continue', text: `message-${index}`
    }))
    try {
      store.createRun({ runId: 'recovery-log', useCase: 'plugin-developer', resolved: resolved(),
        productState: { schemaVersion: 1, workLog: entries } })
      const committed = store.updateProductStateFrom<State>('recovery-log', 'waiting_user', (current) => ({
        schemaVersion: 2, workLog: appendPluginWorkLog('recovery-log', current.productState.workLog, entries, store)
      }))
      const payload = JSON.stringify({ kind: 'message', value: { role: 'user', content: 'restore me' } })
      store.commitRuntimeObservation('recovery-log', {
        type: 'message.completed', audit: { role: 'user', textPreview: 'restore me', contentHash: 'audit' },
        recovery: { codecVersion: 1, payload, contentHash: createHash('sha256').update(payload).digest('hex') }
      })
      if (scenario === 'hash-failure') db.prepare("UPDATE agent_execution_history SET content_hash = 'wrong'").run()
      if (scenario === 'unreconciled-tool') store.beginToolCall({
        runId: 'recovery-log', callId: 'pending-write', toolName: 'write', argsDigest: 'args', effect: 'write'
      })
      const historyBefore = db.prepare('SELECT * FROM agent_execution_history').all()
      const ledgerBefore = db.prepare('SELECT * FROM agent_tool_ledger').all()
      const rebuild = t.mock.method(runtime, 'rebuild')
      const open = () => execution.openRun({ useCase: 'plugin-developer', resolved: resolved(),
        productState: committed, resume: store.getRun('recovery-log')! })
      if (scenario === 'success') {
        assert.equal((await open()).source, 'rebuilt')
        assert.equal(store.getRun('recovery-log')?.recoveryGeneration, 1)
        assert.equal(rebuild.mock.callCount(), 1)
        const frames = rebuild.mock.calls[0].arguments[1]
        assert.equal(frames.length, 1)
        assert.equal(frames[0].recovery.payload, payload)
        assert.equal(frames[0].codecVersion, 1)
      } else {
        const reason = scenario === 'hash-failure' ? /完整性校验失败/ : scenario === 'rebuild-failure' ? /rebuild failed/ : /未对账/
        await assert.rejects(open, reason)
        assert.equal(store.getRun('recovery-log')?.recoveryGeneration, 0)
        const attempts = rebuild.mock.callCount()
        assert.equal(attempts, scenario === 'rebuild-failure' ? 1 : 0)
        await assert.rejects(open, /已尝试过重建/)
        assert.equal(rebuild.mock.callCount(), attempts)
      }
      assert.deepEqual(store.getRun<State>('recovery-log')!.productState, committed)
      assert.deepEqual(readPluginWorkLog('recovery-log', committed.workLog, store), entries)
      assert.deepEqual(db.prepare('SELECT * FROM agent_execution_history').all(), historyBefore)
      assert.deepEqual(db.prepare('SELECT * FROM agent_tool_ledger').all(), ledgerBefore)
      if (scenario === 'success') {
        entries.push({ at: '2026-09-10T00:00:01Z', kind: 'user_message', sessionId: 'recovery-log', source: 'continue', text: 'after rebuild' })
        const next = store.updateProductStateFrom<State>('recovery-log', 'waiting_user', (current) => ({
          schemaVersion: 2, workLog: appendPluginWorkLog('recovery-log', current.productState.workLog, entries, store)
        }))
        assert.deepEqual(readPluginWorkLog('recovery-log', next.workLog, store), entries)
      }
    } finally {
      t.mock.restoreAll()
      await execution.dispose()
      db.close()
    }
  })
}
