import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { AGENT_PLATFORM_SCHEMA_SQL } from '@library/db/schema'
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
    let approvalArgs: Record<string, unknown> | undefined
    try {
      const tools = host.registerRun({
        runId: 'run', profile: approvalProfile, status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        handlers: new Map([['test_tool', async () => {
          executions += 1
          return { ok: true, content: 'installed', summary: 'installed' }
        }]]),
        onApprovalRequired: (request) => { approvalArgs = request.args }
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
      assert.deepEqual(approvalArgs, { secret: '[redacted]' })
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

  it('stores only bounded hashes for tool output and errors', async () => {
    const { db, store, host } = harness()
    try {
      const tools = host.registerRun({
        runId: 'run', profile: profile(), status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        handlers: new Map([['test_tool', async ({ args }) => {
          if (args.fail) throw new Error('secret failure payload')
          return {
            ok: true,
            content: 'secret page snapshot',
            summary: 'secret result summary',
            detail: 'secret detail',
            recovery: { secret: 'recovery payload' }
          }
        }]])
      })

      await tools[0]!.invoke({
        runId: 'run', callId: 'safe-result', args: { secret: 'value' },
        signal: new AbortController().signal, progress: () => undefined
      })
      await assert.rejects(() => tools[0]!.invoke({
        runId: 'run', callId: 'safe-error', args: { fail: true },
        signal: new AbortController().signal, progress: () => undefined
      }), /secret failure payload/)

      const rows = db.prepare(
        "SELECT call_id, result_json FROM agent_tool_ledger WHERE call_id IN ('safe-result', 'safe-error') ORDER BY call_id"
      ).all() as Array<{ call_id: string; result_json: string }>
      const stored = rows.map((row) => row.result_json).join('\n')
      assert.doesNotMatch(stored, /secret page snapshot|secret result summary|secret detail|recovery payload|secret failure payload/)
      assert.match(stored, /summaryHash/)
      assert.match(stored, /messageHash/)
    } finally { db.close() }
  })

  it('approves only the selected request when multiple approvals are pending', async () => {
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
      for (const [callId, secret] of [['pending-a', 'a'], ['pending-b', 'b']] as const) {
        await assert.rejects(() => tools[0]!.invoke({
          runId: 'run', callId, args: { secret },
          signal: new AbortController().signal, progress: () => undefined
        }), ApprovalRequiredError)
      }
      const pending = host.pendingApprovals('run')
      assert.equal(pending.length, 2)
      host.approve('run', pending[0]!.requestId)

      const approved = await tools[0]!.invoke({
        runId: 'run', callId: 'approved-a', args: { secret: 'a' },
        signal: new AbortController().signal, progress: () => undefined
      })
      assert.equal(approved.ok, true)
      await assert.rejects(() => tools[0]!.invoke({
        runId: 'run', callId: 'still-pending-b', args: { secret: 'b' },
        signal: new AbortController().signal, progress: () => undefined
      }), ApprovalRequiredError)
      assert.equal(executions, 1)
    } finally {
      setAgentPayloadCipherForTests(null)
      db.close()
    }
  })

  it('keeps only the latest pending approval for single-card product flows', async () => {
    setAgentPayloadCipherForTests({
      encrypt: (value) => Buffer.from(value, 'utf8'),
      decrypt: (value) => value.toString('utf8')
    })
    const approvalProfile = profile({ approvalRequiredEffects: ['install'] })
    const { db, store, host } = harness(approvalProfile, declaration({ effect: 'install' }))
    try {
      const tools = host.registerRun({
        runId: 'run', profile: approvalProfile, status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        singlePendingApproval: true,
        handlers: new Map([['test_tool', async () => ({ ok: true, content: 'ok', summary: 'ok' })]])
      })
      for (const [callId, secret] of [['pending-a', 'a'], ['pending-b', 'b']] as const) {
        await assert.rejects(() => tools[0]!.invoke({
          runId: 'run', callId, args: { secret },
          signal: new AbortController().signal, progress: () => undefined
        }), ApprovalRequiredError)
      }
      const pending = host.pendingApprovals('run')
      assert.equal(pending.length, 1)
      assert.equal(pending[0]?.callId, 'pending-b')
      const statuses = db.prepare(`
        SELECT status FROM agent_approvals ORDER BY created_at, request_id
      `).all() as Array<{ status: string }>
      assert.deepEqual(statuses.map((row) => row.status).sort(), ['denied', 'pending'])
    } finally {
      setAgentPayloadCipherForTests(null)
      db.close()
    }
  })

  it('revokes a persisted approval when the continuation dispatch fails', async () => {
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
      await assert.rejects(() => tools[0]!.invoke({
        runId: 'run', callId: 'approval-before-dispatch', args: { secret: 'same' },
        signal: new AbortController().signal, progress: () => undefined
      }), ApprovalRequiredError)
      const requestId = host.pendingApprovals('run')[0]!.requestId
      host.approve('run', requestId)
      assert.equal(host.revokeApproval('run', requestId), true)
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
      await assert.rejects(() => recoveredTools[0]!.invoke({
        runId: 'run', callId: 'after-failed-dispatch', args: { secret: 'same' },
        signal: new AbortController().signal, progress: () => undefined
      }), ApprovalRequiredError)
      assert.equal(executions, 0)
      assert.equal(store.listApprovedPermits('run').length, 0)
    } finally {
      setAgentPayloadCipherForTests(null)
      db.close()
    }
  })

  it('discards pending and approved permits during terminal cleanup', async () => {
    setAgentPayloadCipherForTests({
      encrypt: (value) => Buffer.from(value, 'utf8'),
      decrypt: (value) => value.toString('utf8')
    })
    const approvalProfile = profile({ approvalRequiredEffects: ['install'] })
    const { db, store, host } = harness(approvalProfile, declaration({ effect: 'install' }))
    try {
      const tools = host.registerRun({
        runId: 'run', profile: approvalProfile, status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        handlers: new Map([['test_tool', async () => ({ ok: true, content: 'ok', summary: 'ok' })]])
      })
      await assert.rejects(() => tools[0]!.invoke({
        runId: 'run', callId: 'approved-open', args: { secret: 'a' },
        signal: new AbortController().signal, progress: () => undefined
      }), ApprovalRequiredError)
      host.approve('run', host.pendingApprovals('run')[0]!.requestId)
      await assert.rejects(() => tools[0]!.invoke({
        runId: 'run', callId: 'pending-open', args: { secret: 'b' },
        signal: new AbortController().signal, progress: () => undefined
      }), ApprovalRequiredError)

      host.discardApprovals('run')
      assert.equal(host.pendingApprovals('run').length, 0)
      assert.equal(store.listApprovedPermits('run').length, 0)
      const statuses = db.prepare('SELECT DISTINCT status FROM agent_approvals').all() as Array<{ status: string }>
      assert.deepEqual(statuses.map((row) => row.status), ['denied'])
    } finally {
      setAgentPayloadCipherForTests(null)
      db.close()
    }
  })

  it('binds an approval permit to mutable domain scope as well as visible tool args', async () => {
    setAgentPayloadCipherForTests({
      encrypt: (value) => Buffer.from(value, 'utf8'),
      decrypt: (value) => value.toString('utf8')
    })
    const approvalProfile = profile({ approvalRequiredEffects: ['install'] })
    const install = declaration({ effect: 'install' })
    const { db, store, host } = harness(approvalProfile, install)
    let packageFingerprint = 'package-a'
    let executions = 0
    try {
      const tools = host.registerRun({
        runId: 'run', profile: approvalProfile, status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        approvalScope: () => ({ packageFingerprint }),
        handlers: new Map([['test_tool', async () => {
          executions += 1
          return { ok: true, content: 'installed', summary: 'installed' }
        }]])
      })
      await assert.rejects(() => tools[0]!.invoke({
        runId: 'run', callId: 'approve-package-a', args: { secret: 'same' },
        signal: new AbortController().signal, progress: () => undefined
      }), ApprovalRequiredError)
      host.approve('run', host.pendingApprovals('run')[0]!.requestId)

      packageFingerprint = 'package-b'
      await assert.rejects(() => tools[0]!.invoke({
        runId: 'run', callId: 'try-package-b', args: { secret: 'same' },
        signal: new AbortController().signal, progress: () => undefined
      }), ApprovalRequiredError)
      assert.equal(executions, 0)
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

  it('does not start an unkeyed handler when its signal is already aborted', async () => {
    const unkeyed = declaration({ resourceKey: () => undefined })
    const { db, store, host } = harness(profile(), unkeyed)
    let executions = 0
    try {
      const tools = host.registerRun({
        runId: 'run', profile: profile(), status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        handlers: new Map([['test_tool', async () => {
          executions += 1
          return { ok: true, content: 'ok', summary: 'ok' }
        }]])
      })
      const controller = new AbortController()
      controller.abort(new Error('cancel before invoke'))
      await assert.rejects(() => tools[0]!.invoke({
        runId: 'run', callId: 'unkeyed-abort', args: {}, signal: controller.signal,
        progress: () => undefined
      }), /cancel before invoke/)
      assert.equal(executions, 0)
    } finally { db.close() }
  })

  it('enforces deadlines even when a handler ignores AbortSignal', async () => {
    const readTool = declaration({ effect: 'read', capability: 'test.read', timeoutMs: 20 })
    const { db, store, host } = harness(profile(), readTool)
    try {
      const tools = host.registerRun({
        runId: 'run', profile: profile(), status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        handlers: new Map([['test_tool', async () => new Promise<never>(() => undefined)]])
      })
      const startedAt = Date.now()
      await assert.rejects(
        () => tools[0]!.invoke({
          runId: 'run', callId: 'call-timeout', args: {},
          signal: new AbortController().signal, progress: () => undefined
        }),
        /工具执行超时/
      )
      assert.ok(Date.now() - startedAt < 250)
      const row = db.prepare(
        'SELECT status FROM agent_tool_ledger WHERE call_id = ?'
      ).get('call-timeout') as { status: string }
      assert.equal(row.status, 'interrupted')
    } finally { db.close() }
  })

  it('does not let a late handler result overwrite an uncertain timeout', async () => {
    const writeTool = declaration({ timeoutMs: 20 })
    const { db, store, host } = harness(profile(), writeTool)
    let resolveHandler: ((value: { ok: boolean; content: string; summary: string }) => void) | undefined
    try {
      const tools = host.registerRun({
        runId: 'run', profile: profile(), status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        handlers: new Map([['test_tool', async () => new Promise((resolve) => {
          resolveHandler = resolve
        })]])
      })
      await assert.rejects(() => tools[0]!.invoke({
        runId: 'run', callId: 'call-late', args: {},
        signal: new AbortController().signal, progress: () => undefined
      }), /工具执行超时/)

      resolveHandler?.({ ok: true, content: 'late', summary: 'late' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      const row = db.prepare(
        'SELECT status FROM agent_tool_ledger WHERE call_id = ?'
      ).get('call-late') as { status: string }
      assert.equal(row.status, 'uncertain')
    } finally { db.close() }
  })

  it('keeps the resource locked until a timed-out non-cooperative handler really settles', async () => {
    const writeTool = declaration({ timeoutMs: 50 })
    const { db, store, host } = harness(profile(), writeTool)
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const entered: string[] = []
    let concurrent = 0
    let maximum = 0
    try {
      const tools = host.registerRun({
        runId: 'run', profile: profile(), status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        handlers: new Map([['test_tool', async ({ args }) => {
          const id = String(args.id)
          entered.push(id)
          concurrent += 1
          maximum = Math.max(maximum, concurrent)
          if (id === 'first') await firstGate
          concurrent -= 1
          return { ok: true, content: id, summary: id }
        }]])
      })
      await assert.rejects(() => tools[0]!.invoke({
        runId: 'run', callId: 'timed-out-first', args: { id: 'first' },
        signal: new AbortController().signal, progress: () => undefined
      }), /工具执行超时/)

      const second = tools[0]!.invoke({
        runId: 'run', callId: 'after-timeout', args: { id: 'second' },
        signal: new AbortController().signal, progress: () => undefined
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      assert.deepEqual(entered, ['first'])
      releaseFirst()
      assert.equal((await second).ok, true)
      assert.deepEqual(entered, ['first', 'second'])
      assert.equal(maximum, 1)
    } finally {
      releaseFirst()
      db.close()
    }
  })

  it('keeps a queued cancellation from letting a third call bypass the active resource holder', async () => {
    const { db, store, host } = harness()
    let releaseFirst!: () => void
    let firstEntered!: () => void
    const firstReady = new Promise<void>((resolve) => { firstEntered = resolve })
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const entered: string[] = []
    try {
      const tools = host.registerRun({
        runId: 'run', profile: profile(), status: () => store.getRun('run')!.status,
        operationId: () => undefined,
        handlers: new Map([['test_tool', async ({ args }) => {
          const id = String(args.id)
          entered.push(id)
          if (id === 'first') {
            firstEntered()
            await firstGate
          }
          return { ok: true, content: id, summary: id }
        }]])
      })
      const invoke = (callId: string, signal = new AbortController().signal) => tools[0]!.invoke({
        runId: 'run', callId, args: { id: callId }, signal, progress: () => undefined
      })
      const first = invoke('first')
      await firstReady
      const queuedController = new AbortController()
      const queued = invoke('queued', queuedController.signal)
      queuedController.abort(new Error('queue cancelled'))
      await assert.rejects(queued, /queue cancelled/)

      const third = invoke('third')
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      assert.deepEqual(entered, ['first'])
      releaseFirst()
      await Promise.all([first, third])
      assert.deepEqual(entered, ['first', 'third'])
    } finally {
      db.close()
    }
  })
})
