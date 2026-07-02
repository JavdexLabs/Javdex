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
import { executeTool } from '../main/services/pluginDevAgent/toolExecutor'
import type { PluginDevAgentStartInput } from '../main/services/pluginDevAgent/types'
import type { ScraperPluginKind, VideoScrapeField } from '@shared/types'
import { normalizeTestTargets, parseTestTargetList } from '@shared/pluginDevKindProfile'

const MCP_SERVER_NAME = `${APP_PACKAGE_NAME}-plugin-dev`

function readEnvSessionInput(): PluginDevAgentStartInput {
  const kind = (process.env.AV_PLUGIN_DEV_KIND === 'actress' ? 'actress' : 'video') as ScraperPluginKind
  const siteName = process.env.AV_PLUGIN_DEV_SITE_NAME?.trim() || 'mcp-plugin-dev'
  const supportedFieldsRaw = process.env.AV_PLUGIN_DEV_SUPPORTED_FIELDS?.trim()
  const supportedFields = supportedFieldsRaw
    ? supportedFieldsRaw.split(',').map((field) => field.trim()).filter(Boolean)
    : kind === 'video'
      ? (['title', 'maker', 'publisher'] as VideoScrapeField[])
      : ['mainName']

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
  const session = createSession(readEnvSessionInput())
  const sessionId = session.id

  const server = new Server(
    {
      name: MCP_SERVER_NAME,
      version: '1.0.0'
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
    const args = JSON.stringify(request.params.arguments ?? {})
    const result = await executeTool(sessionId, toolName, args, session.step + 1)
    session.step += 1

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
  console.error(`[${MCP_SERVER_NAME}] session=${sessionId} site=${session.siteName}`)
}

main().catch((err) => {
  console.error(`[${MCP_SERVER_NAME}] fatal`, err)
  process.exit(1)
})
