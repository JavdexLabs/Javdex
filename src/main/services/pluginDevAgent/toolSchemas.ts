export interface PluginDevToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

const obj = (properties: Record<string, unknown>, required?: string[]) => ({
  type: 'object',
  properties,
  required: required ?? [],
  additionalProperties: false
})

export const PLUGIN_DEV_TOOL_SCHEMAS: PluginDevToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'plugin_get_state',
      description:
        '获取当前插件包、顶层函数列表（topLevelFunctions 含行号）、测试目标、最近 dry-run 与验证结果摘要。默认省略完整 code，需要时传 includeCode=true。',
      parameters: obj({
        includeCode: {
          type: 'boolean',
          description: '是否返回当前 code。默认 false；需要读取源码或准备 replace_snippet 时传 true。'
        },
        codeStartLine: {
          type: 'number',
          description: 'includeCode=true 时可选：从第几行开始返回，默认 1。'
        },
        codeLineCount: {
          type: 'number',
          description: 'includeCode=true 时可选：最多返回多少行，默认返回可放入上下文的截断版本。'
        }
      })
    }
  },
  {
    type: 'function',
    function: {
      name: 'plugin_update_code',
      description:
        '更新插件源码。已有实质 code 时优先 replace_snippet（几行局部修改）→ replace_function（整函数）；replace_all 是兜底，需用户明确要求或传 forceWholeRewrite + forceReason。须遵守 cheerio 规则：每个 HTML 先 ctx.cheerio.load(html)，禁止裸用 $()。',
      parameters: obj(
        {
          mode: {
            type: 'string',
            enum: ['replace_snippet', 'replace_function', 'replace_all'],
            description:
              'replace_snippet（最优先）：精确替换 oldText→newText，oldText 须在 code 中唯一；replace_function：替换单个顶层函数（functionName 取自 topLevelFunctions）；replace_all：整包替换，仅首次编写空 stub、用户明确要求重写或结构重组时使用'
          },
          oldText: {
            type: 'string',
            description: 'replace_snippet 必填：要被替换的原文（建议含 2～3 行上下文，确保唯一匹配）'
          },
          newText: {
            type: 'string',
            description: 'replace_snippet 必填：替换后的新文本'
          },
          nearLine: {
            type: 'number',
            description: 'replace_snippet 可选：oldText 多处匹配时，选最接近该行号的匹配'
          },
          code: {
            type: 'string',
            description: 'replace_function / replace_all 必填：新的 JavaScript 源码'
          },
          functionName: {
            type: 'string',
            description:
              'replace_function 时必填：顶层函数名（plugin_get_state 的 topLevelFunctions，如 parseVideo、parseActress、parseTask 或 helper 名）'
          },
          forceWholeRewrite: {
            type: 'boolean',
            description:
              'replace_all 且已有实质 code 时的显式确认。仅在用户明确要求重写、或 snippet/function 无法安全完成结构重组时使用。'
          },
          forceReason: {
            type: 'string',
            description:
              'forceWholeRewrite=true 时必填：说明为什么不能用 replace_snippet / replace_function 完成。'
          }
        },
        ['mode']
      )
    }
  },
  {
    type: 'function',
    function: {
      name: 'plugin_update_package',
      description:
        '更新插件包元数据（不改 code）。create 模式可调整 supportedFields；debug 模式仅允许新增，删除须用户明确要求并传 confirmUserRemoval: true。',
      parameters: obj({
        name: { type: 'string' },
        version: { type: 'string' },
        description: { type: 'string' },
        author: { type: 'string' },
        homepage: { type: 'string' },
        supportedFields: {
          type: 'array',
          items: { type: 'string' },
          description:
            '支持字段 id 列表。create 模式可增删；debug 模式仅可新增，删除须用户明确要求且 confirmUserRemoval: true。'
        },
        confirmUserRemoval: {
          type: 'boolean',
          description: 'debug 模式下删除 supportedFields 时必填，且须用户已明确要求删除'
        }
      })
    }
  },
  {
    type: 'function',
    function: {
      name: 'plugin_dry_run',
      description:
        '在沙箱中运行当前插件并返回调试结果。可传 testTarget（单个）或 testTargets（多个）覆盖本次测试目标。',
      parameters: obj({
        testTarget: { type: 'string', description: '可选：本次 dry-run 使用的单个测试目标' },
        testTargets: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：多个测试目标（番号或演员名），按顺序运行并汇总'
        }
      })
    }
  },
  {
    type: 'function',
    function: {
      name: 'plugin_verify',
      description: '语义验证最近 dry-run 结果是否正确',
      parameters: obj({
        userFeedback: { type: 'string', description: '用户反馈，可选' }
      })
    }
  },
  {
    type: 'function',
    function: {
      name: 'plugin_install',
      description: '将当前插件安装到 userData',
      parameters: obj({
        overwriteUser: { type: 'boolean', description: '是否覆盖同名用户插件' }
      })
    }
  },
  {
    type: 'function',
    function: {
      name: 'plugin_finish',
      description: '声明任务完成；success=true 时要求 dry-run 与验证已通过',
      parameters: obj(
        {
          summary: { type: 'string' },
          success: { type: 'boolean' }
        },
        ['summary', 'success']
      )
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_fetch_page',
      description: '打开 URL 并等待页面就绪，返回是否遇到 Cloudflare 挑战',
      parameters: obj(
        {
          url: { type: 'string' },
          readySelector: { type: 'string' },
          timeoutMs: { type: 'number' }
        },
        ['url']
      )
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_html',
      description: '获取当前页面指定 selector 的 outerHTML',
      parameters: obj({
        selector: { type: 'string', description: '默认 body' },
        maxLength: { type: 'number', description: '默认 8000' }
      })
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_inspect',
      description:
        '获取页面结构化摘要（forms、无表单 interactive 输入、links、dl、DOM 区域）；AJAX 搜索后即使 URL 不变也应重新 inspect',
      parameters: obj({
        maxTextLength: { type: 'number' },
        maxLinks: { type: 'number' }
      })
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: '在页面执行只读 DOM 探测表达式（IIFE），返回 JSON',
      parameters: obj({ expression: { type: 'string' } }, ['expression'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: '点击页面元素；若触发 AJAX/展开搜索框，随后应 wait 并 inspect/html 查看 DOM 变化',
      parameters: obj({ selector: { type: 'string' } }, ['selector'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description:
        '向输入框输入文本；动态搜索可能只更新结果容器且 URL 不变，输入后应 wait 并 inspect/html',
      parameters: obj(
        {
          selector: { type: 'string' },
          text: { type: 'string' },
          clear: { type: 'boolean' }
        },
        ['selector', 'text']
      )
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_press',
      description: '按键，例如 Enter',
      parameters: obj({ key: { type: 'string' } }, ['key'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: '等待毫秒',
      parameters: obj({ timeoutMs: { type: 'number' } }, ['timeoutMs'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_status',
      description: '获取当前浏览器页面 URL、标题、是否 Cloudflare 挑战；URL 不变不能证明 AJAX 搜索失败',
      parameters: obj({})
    }
  },
  {
    type: 'function',
    function: {
      name: 'session_note',
      description: '记录一条会话笔记供后续步骤参考',
      parameters: obj({ text: { type: 'string' } }, ['text'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'session_request_user',
      description: '暂停并请求用户操作（如完成 Cloudflare 验证）',
      parameters: obj({ reason: { type: 'string' } }, ['reason'])
    }
  }
]

export const PLUGIN_DEV_TOOL_NAMES = new Set(
  PLUGIN_DEV_TOOL_SCHEMAS.map((tool) => tool.function.name)
)
