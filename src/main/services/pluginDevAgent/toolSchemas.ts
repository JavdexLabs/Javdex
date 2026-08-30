import {
  createAgentBrowserSchema,
  strictObjectSchema,
  type AgentToolInputSchema
} from '../../agent-platform/agentBrowserSchema'

export interface PluginDevToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: PluginDevToolInputSchema
  }
}

export type PluginDevToolInputSchema = AgentToolInputSchema

const objectSchema = strictObjectSchema

/**
 * The complete custom surface for PluginDeveloper v1. Source editing uses Pi native workspace
 * tools; Javdex owns production dry-run facts, targeted browser artifact reads, the browser
 * Adapter and typed ask.
 */
export const PLUGIN_DEV_TOOL_SCHEMAS: PluginDevToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'plugin_dry_run',
      description:
        '按生产运行时执行当前工作区插件，返回 pluginResult、effectiveResult、manifestCoverage、规范化前的 unrecognizedResultKeys（仅键名，无建议）和日志。影片使用 videoCodes，演员使用 actresses；省略时运行 task.json 的全部 runTargets。',
      parameters: objectSchema({
        videoCodes: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', maxLength: 160 },
          description: '影片运行目标，只能填写番号，不能填写 URL。仅 video 会话可用。'
        },
        actresses: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              mainName: { type: 'string', maxLength: 160 },
              aliases: {
                type: 'array',
                maxItems: 16,
                items: { type: 'string', maxLength: 160 }
              }
            },
            required: ['mainName'],
            additionalProperties: false
          },
          description: '演员运行目标，mainName/aliases 是名称而不是页面 URL。仅 actress 会话可用。'
        }
      })
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser',
      description:
        '受控浏览器操作与 browser artifact 分区读取接口。每个 action 只接受自己的参数组合；导航动作返回 ARIA、pageFacts 和 artifactRef。',
      parameters: createAgentBrowserSchema({ allowInputActions: true })
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        '创建绑定 requestId 的 choice 或 freeform 用户请求，并结束当前模型轮次。',
      parameters: objectSchema(
        {
          question: { type: 'string', description: '简短、具体的问题。' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                description: { type: 'string' }
              },
              required: ['id', 'label'],
              additionalProperties: false
            },
            description: '可选的结构化选项。'
          },
          evidenceRefs: {
            type: 'array',
            items: { type: 'string' },
            description: '支持该问题的浏览器 artifact 引用。'
          }
        },
        ['question']
      )
    }
  }
]

export const PLUGIN_DEV_TOOL_NAMES = new Set(
  PLUGIN_DEV_TOOL_SCHEMAS.map((tool) => tool.function.name)
)
