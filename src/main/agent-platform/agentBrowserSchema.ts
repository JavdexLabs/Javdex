export interface AgentToolInputSchema extends Record<string, unknown> {
  type: 'object'
  properties?: Record<string, object>
  required?: string[]
  additionalProperties?: false
  oneOf?: AgentToolInputSchema[]
}

export function strictObjectSchema(
  properties: Record<string, object>,
  required: string[] = [],
  constraints: Record<string, unknown> = {}
): AgentToolInputSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
    ...constraints
  }
}

function browserActionSchema(
  action: string,
  properties: Record<string, object> = {},
  required: string[] = [],
  constraints: Record<string, unknown> = {}
): AgentToolInputSchema {
  return strictObjectSchema(
    {
      action: { type: 'string', enum: [action] },
      ...properties
    },
    ['action', ...required],
    constraints
  )
}

export type AgentBrowserToolAction =
  | 'open'
  | 'snapshot'
  | 'find'
  | 'html'
  | 'evaluate'
  | 'click'
  | 'fill'
  | 'press'
  | 'wait'
  | 'status'
  | 'read-section'
  | 'handoff'

export function createAgentBrowserSchema(options: {
  allowInputActions?: boolean
} = {}): AgentToolInputSchema {
  const actions: AgentToolInputSchema[] = [
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
  if (options.allowInputActions) {
    actions.splice(
      6,
      0,
      browserActionSchema('fill', {
        target: { type: 'string', description: '当前 ARIA ref 或唯一 Playwright selector。' },
        text: { type: 'string', description: '要填入的文本；空字符串会清空控件。' },
        submit: { type: 'boolean', description: '填入后是否提交。' }
      }, ['target', 'text']),
      browserActionSchema('press', {
        key: { type: 'string', description: '要按下的键；省略时为 Enter。' },
        target: { type: 'string', description: '可选；先聚焦该 ARIA ref 或唯一 Playwright selector。' }
      })
    )
  }
  return { type: 'object', oneOf: actions }
}
