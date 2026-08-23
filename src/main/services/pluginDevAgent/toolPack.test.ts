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

describe('PluginDeveloper ToolPack v1', () => {
  it('matches the compact Pi-native schema in stable order', () => {
    const expected = PLUGIN_DEV_TOOL_SCHEMAS.map((item) => item.function.name)
    const actual = PLUGIN_DEVELOPER_TOOL_PACK.tools.map((tool) => tool.name)
    assert.equal(PLUGIN_DEVELOPER_TOOL_PACK.ref, 'toolpack:plugin-developer:v1')
    assert.deepEqual(actual, expected)
    assert.equal(new Set(actual).size, actual.length)
    assert.deepEqual(actual, ['plugin_dry_run', 'browser', 'ask_user'])
    assert.equal(actual.length, 3)
    for (const removed of [
      'plugin_check', 'plugin_get_state', 'plugin_update_code', 'plugin_update_package', 'plugin_test',
      'plugin_finish', 'plugin_install', 'session_note', 'session_request_user'
    ]) {
      assert.equal(actual.includes(removed), false)
    }
    for (const tool of PLUGIN_DEVELOPER_TOOL_PACK.tools) {
      assert.equal(tool.executionMode, 'sequential')
      assert.equal(typeof tool.schema.type, 'string')
      assert.ok(tool.capability.length > 0)
      assert.ok(tool.timeoutMs > 0)
    }
  })

  it('classifies dry-run, browser reads/interactions and secret typing explicitly', () => {
    const byName = new Map(PLUGIN_DEVELOPER_TOOL_PACK.tools.map((tool) => [tool.name, tool]))
    assert.equal(byName.get('plugin_dry_run')?.capability, 'plugin.test')
    assert.equal(byName.get('plugin_dry_run')?.effect, 'network')
    assert.equal(byName.get('ask_user')?.effect, 'write')
    assert.equal(byName.get('browser')?.capability, 'browser.interact')
    assert.equal(byName.get('browser')?.effect, 'network')
    assert.deepEqual(
      byName.get('browser')?.redact({ action: 'fill', text: 'password' }),
      { action: 'fill', text: '[redacted 8 chars]' }
    )
  })

  it('governs every remaining host capability through permission, abort and ledger', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(AGENT_PLATFORM_SCHEMA_SQL)
    const store = new AgentRunStore(() => db)
    const host = new ToolHost(store)
    host.registerToolPack(PLUGIN_DEVELOPER_TOOL_PACK)
    const count = PLUGIN_DEVELOPER_TOOL_PACK.tools.length
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
          runId: 'all-tools', callId: `allowed-${index}`, args: {},
          signal: new AbortController().signal, progress: () => undefined
        })
        assert.equal(result.ok, true)
      }
      assert.equal((db.prepare(`
        SELECT COUNT(*) AS count FROM agent_tool_ledger
        WHERE run_id = 'all-tools' AND status = 'completed'
      `).get() as { count: number }).count, count)

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
      `).get() as { count: number }).count, count)
    } finally {
      db.close()
    }
  })
})
