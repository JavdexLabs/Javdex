import { APP_DISPLAY_NAME } from '@shared/appIdentity'
import { configuredRunTargets, normalizeTestTargets } from '@shared/pluginDevKindProfile'
import type { PluginDevAgentStartInput, PluginDevRunTarget } from '@shared/pluginDevTypes'
import { pluginResultContract } from '@shared/pluginResultContract'
import { buildPluginFieldSemanticsPrompt } from '@shared/scrapeFieldPromptDocs'
import type { ScraperPluginKind } from '@shared/scraperPluginTypes'

export const PLUGIN_DEV_INSTRUCTION_SET_VERSION = 9

export const PLUGIN_DEVELOPER_SYSTEM_PROMPT = `你是 ${APP_DISPLAY_NAME} 的插件开发 Agent，运行在当前插件专用隔离工作区。

- plugin.json 和 index.js 是插件草稿的唯一真相；.javdex/dev-notes.md 是你的外部开发记忆。只允许修改这三个文件。
- task.json、.javdex/latest-dry-run.json、docs/ 和 .agents/skills 是宿主提供的只读资源。
- 插件开发必须遵循 javdex-plugin-dev Skill；浏览器操作必须遵循 javdex-browser-operation Skill。
- 恢复或压缩上下文后，先读取 .javdex/dev-notes.md、index.js、plugin.json 和 .javdex/latest-dry-run.json，再决定下一项行动。
- Agent 不安装插件；最终生产运行验收和安装由宿主管理。`

export interface PluginDevRunInstructionSet {
  systemPrompt: string
  initialMessage: string
  workspaceResources: Record<string, string>
}

export type PluginDevContinuationInput =
  | { kind: 'resume' }
  | { kind: 'user_feedback'; text?: string }
  | { kind: 'choice_resolved'; decision: { optionId: string; label: string } }
  | {
      kind: 'browser_interaction_resolved'
      reason: 'human_verification' | 'login' | 'required_user_action'
    }

function selectedFieldMappings(kind: ScraperPluginKind): string {
  const mappings = pluginResultContract.describe(kind).keys
    .filter((item) => item.role === 'field')
  const table = [
    '| `index.js` 结果键 | `plugin.json.supportedFields` 字段 id |',
    '| --- | --- |',
    ...mappings.map((item) =>
      `| \`${item.key}\` | ${item.fieldIds.map((field) => `\`${field}\``).join(' / ')} |`
    )
  ].join('\n')
  const example = mappings.find((item) =>
    item.fieldIds.length === 1 && item.fieldIds[0] !== item.key
  )
  const fieldId = example?.fieldIds[0]
  if (!example || !fieldId) return table

  return `${table}

成对示例（左列只用于 \`index.js\`，右列只用于 \`plugin.json\`）：

\`\`\`js
result.${example.key} = value
\`\`\`

\`\`\`json
{ "supportedFields": ["${fieldId}"] }
\`\`\`

不要写成 \`result.${fieldId}\`；不要声明 \`["${example.key}"]\`。`
}

function pluginFormatDocument(kind: ScraperPluginKind): string {
  const parserName = kind === 'video' ? 'parseVideo' : 'parseActress'
  const runtimeInput = kind === 'video'
    ? '- 影片插件的运行输入只有 `ctx.code`。'
    : '- 演员插件的运行输入只有 `ctx.mainName` 和 `ctx.aliases`。'
  const kindContract = kind === 'video'
    ? `- \`code\` 是始终保留的影片身份键，不属于 \`supportedFields\`；结果必须包含与目标精确相等的 code。只有插件用精确查询实际得到多个同番号候选时才返回对象数组；普通模糊搜索列表不是多候选契约，找不到精确番号应返回 \`null\`。
- \`actresses\` 按每项显式 \`gender: "female" | "male"\` 分别投影到 \`actressesFemale\` / \`actressesMale\`。`
    : `- \`mainName\` 是运行身份键，\`sourceUrl\` 是可选调试来源；二者都不属于 \`supportedFields\`，预计不会进入 \`effectiveResult\`，不得尝试声明。
- 演员结果只声明下面列出的演员字段 id。`
  return `# Javdex 刮削插件工作区规范

本工作区由 Javdex 创建。插件产物只包含根目录的 \`plugin.json\` 和 \`index.js\`；开发过程中还可修改 \`.javdex/dev-notes.md\`。

## 文件

- \`plugin.json\`：插件元数据；\`codeFile\` 必须保持为 \`index.js\`。
- \`index.js\`：CommonJS 插件源码。
- \`task.json\`：只读任务事实。
- \`.javdex/dev-notes.md\`：Pi 可写的开发记忆，不进入插件包。
- \`.javdex/latest-dry-run.json\`：宿主只写的最新真实运行事实，不进入插件包。
- \`docs/fields-${kind}.md\`：字段语义查询表。
- \`.javdex/reports/\`：完整运行报告；不要手工修改。

## 运行时契约

- 导出 \`async function ${parserName}(ctx)\`，也兼容导出 \`parseTask\`。
- 禁止 \`import\`、\`require\`、Node API、文件系统和直接网络请求。
- 页面只能通过 \`ctx.fetchPage\`、\`ctx.fetchBuffer\` 或 \`ctx.browser\` 获取。
${runtimeInput}
- 不存在 \`ctx.url\`、\`ctx.pageUrl\`、\`ctx.taskUrl\`、\`ctx.target\` 或 \`ctx.sourceUrl\`；浏览器开发窗口的当前 URL 不会注入沙箱。
- \`ctx.fetchPage(url, options?): Promise<string>\` 直接返回 HTML 字符串，不是 \`{ html, url }\` 对象，也不包含最终 URL。
- \`ctx.cheerio\` 是模块；每个 HTML 必须先执行 \`const $ = ctx.cheerio.load(html)\`。
- 返回字段必须使用字段文档里的标准结果键。\`plugin.json.supportedFields\` 使用字段 id，不是 parse 返回键：
${selectedFieldMappings(kind)}
${kindContract}
- create 草稿初始的空 \`supportedFields\` 只表示尚未声明；根据 dry-run 的 \`manifestCoverage.undeclaredReturnedFieldIds\` 补入实际字段 id。
- \`pluginResult\` 是插件基础规范化后的输出；\`effectiveResult\` 是生产运行时投影后真正可用的输出；\`manifestCoverage\` 只使用当前 kind 的合法字段 id。
- \`unrecognizedResultKeys\` 在规范化前记录不属于上表的原始结果键，只列键名，不包含映射建议。
- 找不到精确目标时返回 \`null\`，不得返回相似目标凑数。
`
}

function pluginDevelopmentSkill(kind: ScraperPluginKind): string {
  const targetDiscovery = kind === 'video'
    ? '影片详情页并提取真正番号'
    : '演员资料页并提取主名和页面明确给出的别名'
  const runtimeWorkflow = kind === 'video'
    ? `插件必须从 \`ctx.code\` 开始搜索并打开详情页。从精确详情页发现番号后，用该番号调用 dry-run；例如发现 YST-222 时传 \`{"videoCodes":["YST-222"]}\`。YST-222 只是参数格式示例，不是固定测试目标。返回的 \`actresses\` 每项要显式给出 \`gender\`。`
    : `插件必须从 \`ctx.mainName\` / \`ctx.aliases\` 开始搜索并打开资料页。从精确资料页发现主名后，用该主名和页面明确别名调用 dry-run；例如可传 \`{"actresses":[{"mainName":"三上悠亜","aliases":["Yua Mikami"]}]}\`。三上悠亜只是参数格式示例，不是固定测试目标。\`mainName\` / \`sourceUrl\` 只是运行与调试信息，不要加入 \`supportedFields\`。`
  return `---
name: javdex-plugin-dev
description: Create or debug the Javdex scraper plugin in the current isolated workspace.
---

# Javdex Plugin Development

本 Skill 是插件开发工作流的唯一来源。

1. 每次启动、继续或压缩恢复时，先读取 \`.javdex/dev-notes.md\`、\`index.js\`、\`plugin.json\` 和存在时的 \`.javdex/latest-dry-run.json\`。只在首次开发且 notes 尚无页面事实时读取一次 \`task.json\`、\`docs/plugin-format.md\` 和必要的字段语义；字段文档是按实际标签查询的参考表，不是实现清单。
2. 若 \`task.json.runTargets\` 为空，使用浏览器找到一个代表性的精确${targetDiscovery}。页面 URL 只用于理解网站和编写搜索逻辑，永远不是 dry-run 目标。
3. ${runtimeWorkflow} 禁止假设存在任何 URL 型 ctx 输入。
4. 首次出现精确目标详情页 observation 时，无论来自 open、click、fill、press 或 snapshot，只要已经能确定搜索入口、详情选择器和当前可见字段，探索即告完成。把全部已观察且映射明确的字段与已确认页面结构写入 \`.javdex/dev-notes.md\`，然后立即开始编码，不再继续浏览。只有能明确指出“缺少哪个事实会阻止写出可运行插件”时，才允许追加一次最直接的 browser 操作；不能按字段逐项证明。只有真实字段歧义才调用 \`ask_user\`。
5. 目标是用最少的有效行动完成插件，而不是制造固定轮数。reasoning 只用一至三句话说明下一项工具行动；不要在 reasoning 中预先编写插件、重复字段表、复述页面、重新论证已确认事实，或预演 dry-run 能验证的问题。证据足以修改时立即 write/edit。
6. 根据当前证据自适应选择实现范围：简单网站可以在一个连贯修改中实现全部已观察且映射明确的字段；不得为了形成多轮流程而故意延后字段。只有代码确实复杂、部分实现仍需真实运行结果验证，或存在尚未解决的具体不确定性时，才先实现一个可运行批次，并在 dev-notes 中写明具体未完成项。实现范围不使用任何预设字段组合。
7. create 模式在调用 dry-run 前保证 \`index.js\`、\`plugin.json\` 和 dev-notes 的当前状态相互一致；debug 模式只修改真正需要变化的文件。只有页面事实、字段覆盖、未完成事项或下一步发生变化时才更新 dev-notes，不为满足流程仪式重写文件。完成相关写入后，下一项行动优先调用 \`plugin_dry_run\`。
8. 不主动测试理论镜像域名、模糊搜索、无结果页或多结果页。只有精确查询当前实际返回列表，或 dry-run 已证明列表路径是首版运行所必需时，才实现列表回退；普通模糊搜索列表不是“多候选结果”契约的触发条件，找不到精确番号仍返回 \`null\`。
9. 更新 \`plugin.json.supportedFields\` 时只使用当前 kind 的字段 id，而不是结果键。
10. 每次 dry-run 后读取真实 \`pluginResult\`、\`effectiveResult\`、\`manifestCoverage\`、\`unrecognizedResultKeys\` 和 \`.javdex/latest-dry-run.json\`，然后只作一个决定：结果正确且没有明确未完成项时停止；有明确错误或剩余字段时做一次针对性修改后再运行；没有新证据或没有必要修改时停止，不重复相同运行。不要用 reasoning 代替实际 write/edit 或 dry-run。多轮开发是解决真实缺口的能力，不是必须经历的阶段。
11. 对照首次浏览器 observation 自行判断内容是否正确。\`unrecognizedResultKeys\` 非空时按结果契约修正代码键；只把 \`manifestCoverage.undeclaredReturnedFieldIds\` 加入 \`supportedFields\`；\`runtimeOnlyKeys\` 只是中性运行信息，不得由此修改 manifest。宿主不替你作网页语义判断。
12. 最终回应前只检查一次 dev-notes 和最新完整 dry-run。仍有明确未完成字段时不得声称插件完整完成；没有明确未完成项、最后一次完整 dry-run 的 \`mechanicalAcceptance.installReady=true\` 且结果没有明显错误时，简短说明当前版本可供用户安装。一次实现并一次 dry-run 即可满足这些条件，不要求额外开发轮次；该标记只代表机械可安装，不证明字段语义完整。
13. 显式目标只用于局部诊断。首次无目标会话的合法显式目标会成为完整目标集合；之后要验证全部目标时省略参数调用 \`plugin_dry_run\`。
14. debug 模式先读取当前代码、manifest、dev-notes 与宿主提供的初始 dry-run，增量修改；代码变化前不要重复运行，也不要重新探索整个站点。需要产品决定时才使用 \`ask_user\`；Agent 不安装插件。
`
}

function browserOperationSkill(): string {
  return `---
name: javdex-browser-operation
description: Inspect and interact with the Javdex controlled browser while developing scraper plugins.
---

# Browser Operation

- 使用单一 \`browser\` 工具，action 为 \`open|snapshot|find|html|evaluate|click|fill|press|wait|status|handoff\`。
- \`open\` 和导航动作优先原样返回 Playwright ARIA snapshot 与完整 \`pageFacts\`，宿主不会按字段或关键词猜测哪些页面内容重要。
- 浏览器 observation 有五种模式：\`full\` 表示新文档证据已完整内联；\`artifact\` 表示硬上限内无法完整内联，必须检查 \`inlineComplete=false\`、\`omittedInlineSections\` 和 \`pageFactsSummary\`，当前缺失事实确有必要时再用 \`find\`、局部 \`snapshot/html\` 或针对性读取 \`artifactRef\`；\`delta\` 只包含同一文档的完整变化；\`unchanged\` 表示没有新事实，必须停止相同探索；\`pending\` 表示动作已成功但页面暂时无法观察，只调用一次 \`snapshot\`，绝不能重复 click/fill/press。
- \`artifactComplete\` 只说明 artifact 是否保留了完整采集结果；它不代表 Agent 当前看到的内联内容完整。不得把 \`inlineComplete=false\` 当作页面没有相关字段。
- 首次打开站点后，如果当前页面不是中文，并且 observation 明确显示语言选择入口，先使用现有 ref 切换一次中文：优先简体中文，其次繁体中文。当前已是中文、入口不明确或切换失败时直接继续当前页面；不要猜测 locale URL、反复查找语言入口或来回切换。
- 页面存在阻挡内容的弹窗、对话框或横幅时，先阅读可见控件。成人确认、进入网站、关闭广告、跳过介绍、仅使用必要 Cookie 等不要求账号、秘密信息、购买或外部副作用的页面内确认，按页面规则点击明确控件关闭；每个遮挡层最多安全尝试一次，动作后 observation 未变化时不得重复点击。
- 登录弹窗若有明确的关闭、跳过或访客继续入口，按普通可关闭弹窗处理。只有页面明确要求登录且没有可跳过入口时，调用 \`browser(action="handoff", reason="login")\`；验证码或其他人机验证使用 \`reason="human_verification"\`；其他必须由用户亲自在浏览器完成的动作使用 \`reason="required_user_action"\`。
- 不得代替用户登录、注册、购买、订阅、授权账号，也不得在 \`fill\` 中填写账号、密码、验证码或二次验证信息。handoff 后立即结束当前轮次；用户完成后只调用一次 \`status\` 或 \`snapshot\` 从原位置继续，不重新探索。
- \`snapshot\` 产生可复用的 ARIA ref；主框架导航、页面替换或 helper 重启后旧 ref 失效，应重新 snapshot。
- 只有一个明确缺失事实时才追加最直接的操作：内容仍加载用 \`wait\`，已有控件用 \`click\`，找具体文本用 \`find\`，需要局部结构时用 \`html\` 或 \`evaluate\`。得到答案后立即返回编码；没有新增事实就停止浏览。
- \`find\` 返回至多 20 个上下文块；\`html\` 只读取目标局部；\`evaluate\` 直接返回 JSON 兼容值，不要调用 \`JSON.stringify\`。
- \`evaluate\` 仅用于公开页面结构，不得读取 cookie、storage、凭据、密码、验证码或表单控件值；遇到登录、人机验证或其他账户操作必须使用 \`handoff\` 交给用户。
- 完整 observation artifact 保存在 \`.javdex/browser/\`，只供 Pi 针对性阅读和日志导出；超长字符串会在索引中显示为 \`$artifactTextRef\`，对应 part 文件可继续用 read 的 offset/limit 分段读取。宿主验收不消费它。
`
}

function taskDocument(
  input: PluginDevAgentStartInput,
  runTargets?: readonly PluginDevRunTarget[]
): Record<string, unknown> {
  return {
    schemaVersion: 3,
    instructionSetVersion: PLUGIN_DEV_INSTRUCTION_SET_VERSION,
    mode: input.mode,
    kind: input.kind,
    siteName: input.siteName,
    siteUrl: input.siteUrl,
    description: input.description,
    runTargets: runTargets ?? configuredRunTargets(input.kind, normalizeTestTargets(input)),
    userRequest: input.userMessage?.trim() || undefined
  }
}

function initialMessage(input: PluginDevAgentStartInput, debugResult?: string): string {
  if (input.mode === 'create') {
    return '读取 task.json、.javdex/dev-notes.md、index.js、plugin.json 和 .javdex/latest-dry-run.json（若存在），并按 javdex-plugin-dev Skill 以最少的有效行动完成当前 create 任务。task.json 包含本轮全部动态任务事实和用户要求。'
  }
  const result = debugResult?.trim() || '宿主未返回可用的初始生产运行摘要。'
  return `先读取 .javdex/dev-notes.md、index.js、plugin.json 和 .javdex/latest-dry-run.json，再按 javdex-plugin-dev Skill 调试当前工作区草稿。

宿主已经对当前草稿执行了初始 plugin_dry_run。先检查 pluginResult、effectiveResult、unrecognizedResultKeys、manifestCoverage 和日志；代码发生变化前不要重复运行 plugin_dry_run。若当前结果已经满足任务且没有明确未完成项，直接简短回应，不要为了形成多轮流程而修改代码。

${result}`
}

export function buildRunInstructionSet(input: {
  task: PluginDevAgentStartInput
  debugResult?: string
  runTargets?: readonly PluginDevRunTarget[]
}): PluginDevRunInstructionSet {
  return {
    systemPrompt: PLUGIN_DEVELOPER_SYSTEM_PROMPT,
    initialMessage: initialMessage(input.task, input.debugResult),
    workspaceResources: {
      'task.json': `${JSON.stringify(taskDocument(input.task, input.runTargets), null, 2)}\n`,
      'docs/plugin-format.md': pluginFormatDocument(input.task.kind),
      [`docs/fields-${input.task.kind}.md`]: `${buildPluginFieldSemanticsPrompt(input.task.kind)}\n`,
      '.agents/skills/javdex-plugin-dev/SKILL.md': pluginDevelopmentSkill(input.task.kind),
      '.agents/skills/javdex-browser-operation/SKILL.md': browserOperationSkill()
    }
  }
}

export function buildContinuation(input: PluginDevContinuationInput): string {
  if (input.kind === 'resume') {
    return `继续当前插件任务，不把本次继续操作视为新的缺陷或需求。
先读取 .javdex/dev-notes.md、index.js、plugin.json 和 .javdex/latest-dry-run.json，并保留已有页面事实和已确认决定，不重新开始探索或通读大型文档。
先判断当前草稿是否还有明确未完成项或真实运行错误：没有时直接简短回应；有时选择最小的有效修改，相关文件一致后调用 plugin_dry_run。不要假设继续操作必须产生新的修改或开发轮次。`
  }
  if (input.kind === 'choice_resolved') {
    return `用户决定已记录：${input.decision.label}（optionId=${input.decision.optionId}）。当前歧义已经解决，探索阶段结束。
直接更新受该决定影响的 dev-notes 和所需的 index.js/plugin.json；相关文件一致后调用 plugin_dry_run，不要求为该决定拆出额外开发批次。
除非 dry-run 的真实运行结果暴露明确错误，不要重新读取文档或重新浏览。`
  }
  if (input.kind === 'browser_interaction_resolved') {
    return `用户已确认浏览器中的必要操作处理完成（reason=${input.reason}）。下一步只检查 browser(action="status") 或在确有必要时调用一次 snapshot，然后从中断位置继续；不要重新开始探索，也不要重复触发原操作。`
  }
  const text = input.text?.trim() || '继续当前插件任务。'
  return `用户的新指示：
${text}

先读取 .javdex/dev-notes.md、index.js、plugin.json 和 .javdex/latest-dry-run.json，并保留已有页面事实和已确认决定，不重新开始探索或通读大型文档。只处理这次指示带来的明确差异；需要修改时完成一个连贯改动后调用 plugin_dry_run，不需要修改时直接回应。不要为了维持多轮流程制造额外改动。`
}
