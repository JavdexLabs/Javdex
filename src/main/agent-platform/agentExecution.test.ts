import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { AGENT_PLATFORM_SCHEMA_SQL } from '../db/schema'
import { AgentExecution } from './agentExecution'
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
      dispose: async () => undefined
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
})
