import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { AGENT_PLATFORM_SCHEMA_SQL } from '../db/schema'
import type { AgentProfile } from '@shared/aiConfigurationTypes'
import { AgentRunStore, setAgentPayloadCipherForTests } from './agentRunStore'
import { ApprovalRequiredError, ToolHost, type ToolDeclaration } from './toolHost'
import type { ResolvedRunConfiguration } from './types'

function profile(input: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'profile:test',
    name: 'Test',
    definitionId: 'test',
    routes: { primary: 'r1', verifier: 'r2', summarizer: 'r3' },
    toolPackRefs: ['pack:test'],
    capabilityGrants: ['test.read', 'test.write'],
    approvalRequiredEffects: [],
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    ...input
  }
}

function declaration(input: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return {
    name: 'test_tool',
    label: 'Test tool',
    description: 'Test tool',
    schema: { type: 'object', properties: { secret: { type: 'string' } } },
    capability: 'test.write',
    effect: 'write',
    executionMode: 'sequential',
    timeoutMs: 1_000,
    resourceKey: () => 'resource:1',
    redact: (args) => ({ ...args, secret: '[redacted]' }),
    ...input
  }
}

function resolved(profileValue: AgentProfile): ResolvedRunConfiguration {
  const prompt = 'test'
  return {
    revision: 'rev', definitionId: 'test', profile: profileValue,
    model: {
      credentialRef: 'llm-provider:test',
      model: {
        providerId: 'test', modelId: 'test', name: 'test', api: 'openai-completions',
        baseUrl: 'https://example.invalid/v1', contextWindow: 1_000, maxTokens: 100, reasoning: false
      },
      routeRevision: 'rev:r1',
      preset: { thinkingLevel: 'minimal', maxTokens: 100, timeoutMs: 1_000, cacheRetention: 'none' },
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
      compaction: profileValue.compaction,
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 }
    },
    sessionDirectory: '/tmp/test'
  }
}

function harness(profileValue = profile(), tool = declaration()) {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(AGENT_PLATFORM_SCHEMA_SQL)
  const store = new AgentRunStore(() => db)
  store.createRun({ runId: 'run', useCase: 'test', resolved: resolved(profileValue), productState: {} })
  const host = new ToolHost(store)
  host.registerToolPack({ ref: 'pack:test', tools: [tool] })
  return { db, store, host }
}

describe('ToolHost', () => {
  it('records capability denials before failing closed', async () => {
    const deniedProfile = profile({ capabilityGrants: [] })
    const { db, store, host } = harness(deniedProfile)
    try {
      const tools = host.registerRun({
        runId: 'run', profile: deniedProfile, status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        handlers: new Map([['test_tool', async () => ({ ok: true, content: 'ok', summary: 'ok' })]])
      })
      await assert.rejects(() => tools[0]!.invoke({
        runId: 'run', callId: 'call-denied', args: {}, signal: new AbortController().signal, progress: () => undefined
      }), /未授权/)
      const row = db.prepare('SELECT status, result_json FROM agent_tool_ledger WHERE call_id = ?').get('call-denied') as { status: string; result_json: string }
      assert.equal(row.status, 'denied')
      assert.match(row.result_json, /capability-denied/)
    } finally { db.close() }
  })

  it('requires a one-use approval permit for install effects', async () => {
    setAgentPayloadCipherForTests({
      encrypt: (value) => Buffer.from(value, 'utf8'),
      decrypt: (value) => value.toString('utf8')
    })
    const approvalProfile = profile({ approvalRequiredEffects: ['install'] })
    const install = declaration({ effect: 'install' })
    const { db, store, host } = harness(approvalProfile, install)
    let executions = 0
    try {
      const tools = host.registerRun({
        runId: 'run', profile: approvalProfile, status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        handlers: new Map([['test_tool', async () => {
          executions += 1
          return { ok: true, content: 'installed', summary: 'installed' }
        }]])
      })
      let requestId = ''
      await assert.rejects(
        () => tools[0]!.invoke({
          runId: 'run', callId: 'call-approval-1', args: { secret: 'value' },
          signal: new AbortController().signal, progress: () => undefined
        }),
        (error: unknown) => {
          assert.ok(error instanceof ApprovalRequiredError)
          requestId = error.requestId
          return true
        }
      )
      assert.equal(executions, 0)
      host.approve('run', requestId)
      host.disposeRun('run')
      const recoveredHost = new ToolHost(store)
      recoveredHost.registerToolPack({ ref: 'pack:test', tools: [install] })
      const recoveredTools = recoveredHost.registerRun({
        runId: 'run', profile: approvalProfile, status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        handlers: new Map([['test_tool', async () => {
          executions += 1
          return { ok: true, content: 'installed', summary: 'installed' }
        }]])
      })
      const result = await recoveredTools[0]!.invoke({
        runId: 'run', callId: 'call-approval-2', args: { secret: 'value' },
        signal: new AbortController().signal, progress: () => undefined
      })
      assert.equal(result.ok, true)
      assert.equal(executions, 1)
      const stored = db.prepare('SELECT result_json FROM agent_tool_ledger WHERE call_id = ?').get('call-approval-2') as { result_json: string }
      assert.doesNotMatch(stored.result_json, /"secret":"value"/)
      assert.match(stored.result_json, /redacted/)
      await assert.rejects(() => recoveredTools[0]!.invoke({
        runId: 'run', callId: 'call-approval-3', args: { secret: 'value' },
        signal: new AbortController().signal, progress: () => undefined
      }), ApprovalRequiredError)
    } finally {
      setAgentPayloadCipherForTests(null)
      db.close()
    }
  })

  it('serializes calls sharing a resource without scheduling batches', async () => {
    const { db, store, host } = harness()
    let concurrent = 0
    let maximum = 0
    try {
      const tools = host.registerRun({
        runId: 'run', profile: profile(), status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        handlers: new Map([['test_tool', async () => {
          concurrent += 1
          maximum = Math.max(maximum, concurrent)
          await new Promise((resolve) => setTimeout(resolve, 10))
          concurrent -= 1
          return { ok: true, content: 'ok', summary: 'ok' }
        }]])
      })
      await Promise.all(['a', 'b', 'c'].map((callId) => tools[0]!.invoke({
        runId: 'run', callId, args: {}, signal: new AbortController().signal, progress: () => undefined
      })))
      assert.equal(maximum, 1)
    } finally { db.close() }
  })

  it('marks interrupted writes uncertain and blocks callbacks after waiting or terminal state', async () => {
    const { db, store, host } = harness()
    try {
      const tools = host.registerRun({
        runId: 'run', profile: profile(), status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        handlers: new Map([['test_tool', async ({ signal }) => {
          if (signal.aborted) throw new Error('aborted')
          return { ok: true, content: 'ok', summary: 'ok' }
        }]])
      })
      const controller = new AbortController()
      controller.abort(new Error('cancel'))
      await assert.rejects(() => tools[0]!.invoke({
        runId: 'run', callId: 'call-abort', args: {}, signal: controller.signal, progress: () => undefined
      }), /cancel/)
      const interrupted = db.prepare('SELECT status FROM agent_tool_ledger WHERE call_id = ?').get('call-abort') as { status: string }
      assert.equal(interrupted.status, 'uncertain')
      assert.equal(store.hasUnreconciledSideEffects('run'), true)
      store.updateProductState('run', 'waiting_user', {})
      await assert.rejects(() => tools[0]!.invoke({
        runId: 'run', callId: 'sibling', args: {}, signal: new AbortController().signal, progress: () => undefined
      }), /不允许执行工具/)
      assert.equal(db.prepare('SELECT 1 FROM agent_tool_ledger WHERE call_id = ?').get('sibling'), undefined)
    } finally { db.close() }
  })
})
