export interface PluginDevToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: PluginDevToolInputSchema
  }
}

export interface PluginDevToolInputSchema extends Record<string, unknown> {
  type: 'object'
  properties?: Record<string, object>
  required?: string[]
  additionalProperties?: false
  oneOf?: PluginDevToolInputSchema[]
}

const objectSchema = (
  properties: Record<string, object>,
  required: string[] = [],
  constraints: Record<string, unknown> = {}
): PluginDevToolInputSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...constraints
})

const browserActionSchema = (
  action: string,
  properties: Record<string, object> = {},
  required: string[] = [],
  constraints: Record<string, unknown> = {}
): PluginDevToolInputSchema => objectSchema(
  {
    action: { type: 'string', enum: [action] },
    ...properties
  },
  ['action', ...required],
  constraints
)

const browserSchema = (): PluginDevToolInputSchema => ({
  type: 'object',
  oneOf: [
    browserActionSchema('open', {
      url: { type: 'string', maxLength: 4_096, description: '要打开的绝对 http(s) URL。' },
      readySelector: { type: 'string', description: '可选；等待该 CSS selector 出现。' },
      timeoutMs: { type: 'number', description: '可选导航超时。' }
    }, ['url']),
    browserActionSchema('snapshot', {
      target: { type: 'string', description: '可选；当前 ARIA ref 或唯一 Playwright selector。' },
      depth: { type: 'number' },
      boxes: { type: 'boolean' }
    }),
    browserActionSchema('find', {
      text: { type: 'string', description: '要查找的字面文本；与 regex 至少提供一个。' },
      regex: { type: 'string', maxLength: 256, description: '要查找的正则；与 text 至少提供一个。' }
    }, [], {
      anyOf: [{ required: ['text'] }, { required: ['regex'] }]
    }),
    browserActionSchema('html', {
      target: { type: 'string', description: '可选；当前 ARIA ref 或唯一 Playwright selector，省略时读取当前文档。' },
      maxLength: { type: 'number', description: '可选返回字符上限。' }
    }),
    browserActionSchema('evaluate', {
      expression: { type: 'string', description: '在净化只读文档上执行的 JavaScript 表达式。' },
      timeoutMs: { type: 'number' }
    }, ['expression']),
    browserActionSchema('click', {
      target: { type: 'string', description: '当前 ARIA ref 或唯一 Playwright selector。' }
    }, ['target']),
    browserActionSchema('fill', {
      target: { type: 'string', description: '当前 ARIA ref 或唯一 Playwright selector。' },
      text: { type: 'string', description: '要填入的文本；空字符串会清空控件。' },
      submit: { type: 'boolean', description: '填入后是否提交。' }
    }, ['target', 'text']),
    browserActionSchema('press', {
      key: { type: 'string', description: '要按下的键；省略时为 Enter。' },
      target: { type: 'string', description: '可选；先聚焦该 ARIA ref 或唯一 Playwright selector。' }
    }),
    browserActionSchema('wait', {
      target: { type: 'string', description: '可选；等待该 ARIA ref 或唯一 Playwright selector。' },
      timeoutMs: { type: 'number', description: '可选等待时长。' }
    }),
    browserActionSchema('status'),
    browserActionSchema('read-section', {
      artifactRef: { type: 'string', maxLength: 512, description: 'browser observation 返回的 artifactRef。' },
      section: { type: 'string', maxLength: 160, description: 'omittedInlineSections 中的 section；整份省略时用 observation。' },
      cursor: { type: 'string', maxLength: 1_024, description: '可选；原样传回上一次结果的 nextCursor。' }
    }, ['artifactRef', 'section']),
    browserActionSchema('handoff', {
      reason: {
        type: 'string',
        enum: ['human_verification', 'login', 'required_user_action'],
        description: '必须由用户亲自完成的浏览器操作类型。'
      }
    }, ['reason'])
  ]
})

/**
 * The complete custom surface for PluginDeveloper v13. Source editing uses Pi native workspace
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
      parameters: browserSchema()
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
