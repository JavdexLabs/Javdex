import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import type { AgentProfile } from '@shared/aiConfigurationTypes'
import { AGENT_PLATFORM_SCHEMA_SQL } from '../../db/schema'
import { AgentRunStore } from '../../agent-platform/agentRunStore'
import { ToolHost } from '../../agent-platform/toolHost'
import type { ResolvedRunConfiguration } from '../../agent-platform/types'
import { PLUGIN_DEV_TOOL_SCHEMAS } from './toolSchemas'
import { PLUGIN_DEVELOPER_TOOL_PACK } from './toolPack'

function profile(capabilityGrants: string[]): AgentProfile {
  return {
    id: 'profile:toolpack-fixture',
    name: 'ToolPack fixture',
    definitionId: 'plugin-developer',
    routes: { primary: 'primary', verifier: 'verifier', summarizer: 'summarizer' },
    toolPackRefs: [PLUGIN_DEVELOPER_TOOL_PACK.ref],
    capabilityGrants,
    approvalRequiredEffects: [],
    compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 }
  }
}

function resolved(profileValue: AgentProfile): ResolvedRunConfiguration {
  const systemText = 'toolpack fixture'
  return {
    revision: 'fixture',
    definitionId: 'plugin-developer',
    profile: profileValue,
    model: {
      credentialRef: 'llm-provider:fixture',
      model: {
        providerId: 'fixture', modelId: 'fixture', name: 'Fixture', api: 'openai-completions',
        baseUrl: 'https://example.invalid/v1', contextWindow: 4_000, maxTokens: 500, reasoning: false
      },
      routeRevision: 'fixture:primary',
      preset: { thinkingLevel: 'minimal', maxTokens: 500, timeoutMs: 1_000, cacheRetention: 'none' },
      cacheCompatibility: {
        supportsPromptCache: false, supportsLongCacheRetention: false,
        sendSessionAffinityHeaders: false,
        evidence: { source: 'manual', checkedAt: '2026-01-01T00:00:00.000Z' }
      },
      getCredentialLease: async () => { throw new Error('not used') }
    },
    cache: {
      primaryAffinityId: 'primary', verifierAffinityId: 'verifier', summarizerAffinityId: 'summarizer',
      retention: { primary: 'none', verifier: 'none', summarizer: 'none' }
    },
    systemPrompt: {
      text: systemText,
      sha256: createHash('sha256').update(systemText).digest('hex')
    },
    tools: [],
    settings: {
      compaction: profileValue.compaction,
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 }
    },
    sessionDirectory: '/tmp/javdex-toolpack-fixture'
  }
}

describe('PluginDeveloper ToolPack declaration', () => {
  it('migrates all 18 domain tools with stable schema order and sequential execution', () => {
    const expected = PLUGIN_DEV_TOOL_SCHEMAS.map((item) => item.function.name)
    const actual = PLUGIN_DEVELOPER_TOOL_PACK.tools.map((tool) => tool.name)
    assert.equal(actual.length, 18)
    assert.deepEqual(actual, expected)
    assert.equal(new Set(actual).size, actual.length)
    for (const tool of PLUGIN_DEVELOPER_TOOL_PACK.tools) {
      assert.equal(tool.executionMode, 'sequential')
      assert.equal(typeof tool.schema.type, 'string')
      assert.ok(tool.capability.length > 0)
      assert.ok(tool.timeoutMs > 0)
    }
  })

  it('classifies install, browser mutation, reads and source redaction explicitly', () => {
    const byName = new Map(PLUGIN_DEVELOPER_TOOL_PACK.tools.map((tool) => [tool.name, tool]))
    assert.equal(byName.get('plugin_install')?.effect, 'install')
    assert.equal(byName.get('browser_click')?.capability, 'browser.interact')
    assert.equal(byName.get('browser_html')?.effect, 'read')
    assert.deepEqual(
      byName.get('plugin_update_code')?.redact({ code: 'sensitive source' }),
      { code: '[source 16 chars]' }
    )
    assert.deepEqual(
      byName.get('browser_type')?.redact({ text: 'password' }),
      { text: '[redacted 8 chars]' }
    )
  })

  it('governs all 18 tools through permission, abort, redaction and ledger fixtures', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(AGENT_PLATFORM_SCHEMA_SQL)
    const store = new AgentRunStore(() => db)
    const host = new ToolHost(store)
    host.registerToolPack(PLUGIN_DEVELOPER_TOOL_PACK)
    const capabilities = [...new Set(PLUGIN_DEVELOPER_TOOL_PACK.tools.map((tool) => tool.capability))]
    const handlers = new Map(PLUGIN_DEVELOPER_TOOL_PACK.tools.map((tool) => [
      tool.name,
      async () => ({ ok: true, content: 'ok', summary: 'ok' })
    ]))
    try {
      const allowedProfile = profile(capabilities)
      store.createRun({ runId: 'all-tools', useCase: 'plugin-developer', resolved: resolved(allowedProfile), productState: {} })
      const allowed = host.registerRun({
        runId: 'all-tools', profile: allowedProfile,
        status: () => store.getRun('all-tools')!.status,
        operationId: () => undefined,
        handlers
      })
      for (const [index, tool] of allowed.entries()) {
        const result = await tool.invoke({
          runId: 'all-tools', callId: `allowed-${index}`, args: { code: 'source', text: 'secret' },
          signal: new AbortController().signal, progress: () => undefined
        })
        assert.equal(result.ok, true)
      }
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS count FROM agent_tool_ledger
        WHERE run_id = 'all-tools' AND status = 'completed'
      `).get() as { count: number }).count, 18)

      const abortedProfile = profile(capabilities)
      store.createRun({ runId: 'aborted-tools', useCase: 'plugin-developer', resolved: resolved(abortedProfile), productState: {} })
      const aborted = host.registerRun({
        runId: 'aborted-tools', profile: abortedProfile,
        status: () => store.getRun('aborted-tools')!.status,
        operationId: () => undefined,
        handlers
      })
      for (const [index, tool] of aborted.entries()) {
        const controller = new AbortController()
        controller.abort(new Error('fixture abort'))
        await assert.rejects(() => tool.invoke({
          runId: 'aborted-tools', callId: `aborted-${index}`, args: {},
          signal: controller.signal, progress: () => undefined
        }), /fixture abort/)
      }
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS count FROM agent_tool_ledger
        WHERE run_id = 'aborted-tools' AND status IN ('interrupted', 'uncertain')
      `).get() as { count: number }).count, 18)

      const deniedProfile = profile([])
      store.createRun({ runId: 'denied-tools', useCase: 'plugin-developer', resolved: resolved(deniedProfile), productState: {} })
      const denied = host.registerRun({
        runId: 'denied-tools', profile: deniedProfile,
        status: () => store.getRun('denied-tools')!.status,
        operationId: () => undefined,
        handlers
      })
      for (const [index, tool] of denied.entries()) {
        await assert.rejects(() => tool.invoke({
          runId: 'denied-tools', callId: `denied-${index}`, args: {},
          signal: new AbortController().signal, progress: () => undefined
        }), /未授权/)
      }
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS count FROM agent_tool_ledger
        WHERE run_id = 'denied-tools' AND status = 'denied'
      `).get() as { count: number }).count, 18)
      for (const declaration of PLUGIN_DEVELOPER_TOOL_PACK.tools) {
        assert.doesNotThrow(() => declaration.redact({ code: 'source', text: 'secret' }))
      }
    } finally {
      db.close()
    }
  })
})
