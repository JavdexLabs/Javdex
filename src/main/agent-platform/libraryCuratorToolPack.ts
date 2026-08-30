import type { ToolHandler, ToolPack } from './toolHost'

export const LIBRARY_CURATOR_TOOL_PACK: ToolPack = {
  ref: 'toolpack:library-curator:v1',
  tools: [
    {
      name: 'library_get_overview',
      label: '媒体库概览',
      description: '读取媒体库影片、演员和待处理项目的汇总计数。',
      schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      capability: 'library.read',
      effect: 'read',
      executionMode: 'parallel',
      timeoutMs: 5_000,
      resourceKey: () => undefined,
      redact: (args) => args
    }
  ]
}

export function createLibraryCuratorToolHandlers(
  readOverview: () => Promise<Record<string, unknown>>
): ReadonlyMap<string, ToolHandler> {
  return new Map([
    [
      'library_get_overview',
      async () => {
        const overview = await readOverview()
        return {
          ok: true,
          content: JSON.stringify(overview, null, 2),
          summary: '已读取媒体库概览',
          recovery: overview
        }
      }
    ]
  ])
}
