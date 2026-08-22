import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import { APP_PACKAGE_NAME } from '@shared/appIdentity'
import { PLUGIN_DEV_TOOL_SCHEMAS } from '../main/services/pluginDevAgent/toolSchemas'
import { createSession } from '../main/services/pluginDevAgent/sessionStore'
import type { PluginDevAgentStartInput } from '../main/services/pluginDevAgent/types'
import type { ScraperPluginKind } from '@shared/scrapeTypes'
import { normalizeTestTargets, parseTestTargetList } from '@shared/pluginDevKindProfile'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { AGENT_PLATFORM_SCHEMA_SQL } from '../main/db/schema'
import { AgentRunStore } from '../main/agent-platform/agentRunStore'
import { ToolHost } from '../main/agent-platform/toolHost'
import type { ResolvedRunConfiguration } from '../main/agent-platform/types'
import { PLUGIN_DEVELOPER_TOOL_PACK, createPluginDeveloperToolHandlers } from '../main/services/pluginDevAgent/toolPack'
import { pluginWorkspace } from '../main/services/pluginDevAgent/pluginWorkspace'

const MCP_SERVER_NAME = `${APP_PACKAGE_NAME}-plugin-dev`

function readEnvSessionInput(): PluginDevAgentStartInput {
  const kind = (process.env.AV_PLUGIN_DEV_KIND === 'actress' ? 'actress' : 'video') as ScraperPluginKind
  const siteName = process.env.AV_PLUGIN_DEV_SITE_NAME?.trim() || 'mcp-plugin-dev'
  const supportedFieldsRaw = process.env.AV_PLUGIN_DEV_SUPPORTED_FIELDS?.trim()
  const supportedFields: PluginDevAgentStartInput['supportedFields'] = supportedFieldsRaw
    ? (supportedFieldsRaw
        .split(',')
        .map((field) => field.trim())
        .filter(Boolean) as PluginDevAgentStartInput['supportedFields'])
    : []

  const testTargets = normalizeTestTargets({
    testTargets: process.env.AV_PLUGIN_DEV_TEST_TARGETS?.trim()
      ? parseTestTargetList(process.env.AV_PLUGIN_DEV_TEST_TARGETS)
      : undefined,
    testTarget:
      (kind === 'video'
        ? process.env.AV_PLUGIN_DEV_TEST_CODE
        : process.env.AV_PLUGIN_DEV_TEST_ACTRESS)?.trim() || undefined
  })

  return {
    mode: 'create',
    kind,
    siteName,
    siteUrl: process.env.AV_PLUGIN_DEV_SITE_URL?.trim() || undefined,
    description: process.env.AV_PLUGIN_DEV_DESCRIPTION?.trim() || undefined,
    supportedFields,
    testTargets: testTargets.length > 0 ? testTargets : undefined
  }
}

function toMcpTools(): Tool[] {
  return PLUGIN_DEV_TOOL_SCHEMAS.map((schema) => ({
    name: schema.function.name,
    description: schema.function.description,
    inputSchema: schema.function.parameters
  }))
}

async function main(): Promise<void> {
  const task = readEnvSessionInput()
  const session = createSession(task)
  const sessionId = session.id
  const workspaceDirectory = path.resolve(
    process.env.AV_PLUGIN_DEV_WORKSPACE?.trim() ||
      path.join(os.tmpdir(), 'javdex-plugin-dev-mcp', sessionId)
  )
  session.workspaceDirectory = workspaceDirectory
  pluginWorkspace.open({ directory: workspaceDirectory, task, package: session.package })
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  database.exec(AGENT_PLATFORM_SCHEMA_SQL)
  const runStore = new AgentRunStore(() => database)
  const host = new ToolHost(runStore)
  host.registerToolPack(PLUGIN_DEVELOPER_TOOL_PACK)
  const profile = {
    id: 'profile:mcp-plugin-developer',
    name: 'MCP Plugin Developer',
    definitionId: 'plugin-developer',
    routes: { primary: 'mcp:primary', verifier: 'mcp:verifier', summarizer: 'mcp:summarizer' },
    toolPackRefs: [PLUGIN_DEVELOPER_TOOL_PACK.ref],
    capabilityGrants: ['plugin.write', 'plugin.test', 'browser.interact'],
    approvalRequiredEffects: [],
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 }
  }
  const prompt = 'MCP PluginDeveloper ToolHost session'
  const resolved: ResolvedRunConfiguration = {
    revision: 'mcp-v7',
    definitionId: 'plugin-developer',
    profile,
    model: {
      credentialRef: 'llm-provider:mcp-unused',
      model: {
        providerId: 'mcp-unused', modelId: 'mcp-unused', name: 'MCP unused', api: 'openai-completions',
        baseUrl: 'http://127.0.0.1', contextWindow: 1, maxTokens: 1, reasoning: false
      },
      routeRevision: 'mcp-v7',
      preset: { thinkingLevel: 'minimal', maxTokens: 1, timeoutMs: 1, cacheRetention: 'none' },
      cacheCompatibility: {
        supportsPromptCache: false, supportsLongCacheRetention: false,
        sendSessionAffinityHeaders: false,
        evidence: { source: 'manual', checkedAt: new Date(0).toISOString(), note: 'MCP ToolHost does not invoke a model' }
      },
      getCredentialLease: async () => { throw new Error('MCP ToolHost does not invoke a model') }
    },
    cache: {
      primaryAffinityId: 'mcp-primary', verifierAffinityId: 'mcp-verifier',
      summarizerAffinityId: 'mcp-summarizer',
      retention: { primary: 'none', verifier: 'none', summarizer: 'none' }
    },
    systemPrompt: { text: prompt, sha256: createHash('sha256').update(prompt).digest('hex') },
    tools: [],
    settings: {
      compaction: profile.compaction,
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }
    },
    sessionDirectory: workspaceDirectory
  }
  runStore.createRun({ runId: sessionId, useCase: 'mcp-plugin-developer', resolved, productState: {} })
  const bindings = host.registerRun({
    runId: sessionId,
    profile,
    status: () => runStore.getRun(sessionId)?.status ?? 'closed',
    operationId: () => undefined,
    handlers: createPluginDeveloperToolHandlers({
      domainSessionId: sessionId,
      step: () => session.step,
      // MCP clients own their conversational pause/resume. Typed requests are returned in the
      // tool result, while this capability host stays executable for the client's next turn.
      emit: () => undefined
    })
  })
  const bindingByName = new Map(bindings.map((binding) => [binding.name, binding]))

  const server = new Server(
    {
      name: MCP_SERVER_NAME,
      version: '7.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toMcpTools()
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name
    const binding = bindingByName.get(toolName)
    if (!binding) throw new Error(`ToolHost 未暴露工具：${toolName}`)
    session.step += 1
    const result = await binding.invoke({
      runId: sessionId,
      callId: `mcp:${randomUUID()}`,
      args: request.params.arguments ?? {},
      signal: new AbortController().signal,
      progress: () => undefined
    })

    return {
      content: [
        {
          type: 'text',
          text: result.content
        }
      ],
      isError: !result.ok
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(
    `[${MCP_SERVER_NAME}] session=${sessionId} site=${session.siteName} workspace=${workspaceDirectory}`
  )
}

main().catch((err) => {
  console.error(`[${MCP_SERVER_NAME}] fatal`, err)
  process.exit(1)
})
