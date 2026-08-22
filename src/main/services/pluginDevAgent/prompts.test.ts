import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  buildContinuation,
  buildRunInstructionSet,
  PLUGIN_DEVELOPER_SYSTEM_PROMPT
} from './pluginDevInstructions'
import { PLUGIN_DEV_TOOL_SCHEMAS } from './toolSchemas'
import { agentConfiguration } from '../../agent-platform/agentConfiguration'

const createTask = {
  mode: 'create' as const,
  kind: 'video' as const,
  siteName: 'MissAV',
  siteUrl: 'https://missav.test',
  description: 'fixture',
  supportedFields: [],
  testTargets: ['YST-222'],
  userMessage: '抓取详情页全部明确字段'
}

describe('PluginDevInstructionModule', () => {
  it('keeps the system prompt limited to identity, workspace and host boundaries', () => {
    const prompt = PLUGIN_DEVELOPER_SYSTEM_PROMPT

    assert.match(prompt, /plugin\.json 和 index\.js 是插件草稿的唯一真相/)
    assert.match(prompt, /\.javdex\/dev-notes\.md 是你的外部开发记忆/)
    assert.match(prompt, /latest-dry-run\.json.*宿主提供的只读资源/)
    assert.match(prompt, /恢复或压缩上下文后.*dev-notes\.md.*index\.js.*plugin\.json.*latest-dry-run\.json/)
    assert.match(prompt, /javdex-plugin-dev Skill/)
    assert.match(prompt, /javdex-browser-operation Skill/)
    assert.match(prompt, /最终生产运行验收和安装由宿主管理/)
    assert.doesNotMatch(prompt, /首次 open|wait|click|find|字段范围|unobserved/)
    assert.doesNotMatch(prompt, /plugin_dry_run|ask_user|三次|blocking issue|修改并重跑|reasoning/)
    assert.equal(
      agentConfiguration.getDefinition('plugin-developer').systemPrompt,
      PLUGIN_DEVELOPER_SYSTEM_PROMPT
    )
  })

  it('makes javdex-plugin-dev the only owner of the development workflow', () => {
    const resources = buildRunInstructionSet({ task: createTask }).workspaceResources
    const pluginSkill = resources['.agents/skills/javdex-plugin-dev/SKILL.md']
    const browserSkill = resources['.agents/skills/javdex-browser-operation/SKILL.md']
    const pluginFormat = resources['docs/plugin-format.md']
    const task = JSON.parse(resources['task.json']) as Record<string, unknown>

    assert.match(pluginSkill, /工作流的唯一来源/)
    assert.match(pluginSkill, /探索即告完成[\s\S]*dev-notes\.md[\s\S]*立即开始编码/)
    assert.match(pluginSkill, /目标是用最少的有效行动完成插件，而不是制造固定轮数/)
    assert.match(pluginSkill, /reasoning 只用一至三句话说明下一项工具行动/)
    assert.match(pluginSkill, /简单网站可以在一个连贯修改中实现全部已观察且映射明确的字段/)
    assert.match(pluginSkill, /多轮开发是解决真实缺口的能力，不是必须经历的阶段/)
    assert.doesNotMatch(pluginSkill, /完整可运行的纵向切片/)
    assert.doesNotMatch(pluginSkill, /必须一次实现|一次性生成全部代码/)
    assert.doesNotMatch(pluginSkill, /标题.*封面.*来源链接/)
    assert.match(pluginSkill, /task\.json\.runTargets.*为空/)
    assert.match(pluginSkill, /ctx\.code/)
    assert.doesNotMatch(pluginSkill, /ctx\.mainName|actresses.*mainName/)
    assert.match(pluginSkill, /pluginResult[\s\S]*manifestCoverage\.undeclaredReturnedFieldIds/)
    assert.match(pluginSkill, /runtimeOnlyKeys.*不得由此修改 manifest/)
    assert.doesNotMatch(pluginSkill, /最多三次|三次 dry-run|DRY_RUN_LIMIT_REACHED/)
    assert.match(pluginSkill, /仍有明确未完成字段时不得声称插件完整完成/)
    assert.match(pluginSkill, /一次实现并一次 dry-run 即可满足这些条件，不要求额外开发轮次/)
    assert.match(pluginSkill, /mechanicalAcceptance\.installReady=true.*只代表机械可安装/)
    assert.match(pluginSkill, /无论来自 open、click、fill、press 或 snapshot/)
    assert.match(pluginSkill, /证据足以修改时立即 write\/edit/)
    assert.match(pluginSkill, /不得为了形成多轮流程而故意延后字段/)
    assert.match(pluginSkill, /完成相关写入后，下一项行动优先调用 `plugin_dry_run`/)
    assert.match(pluginSkill, /结果正确且没有明确未完成项时停止/)
    assert.match(pluginSkill, /有明确错误或剩余字段时做一次针对性修改后再运行/)
    assert.match(pluginSkill, /没有新证据或没有必要修改时停止/)
    assert.doesNotMatch(pluginSkill, /下一模型轮次|其余已观察字段保留在 dev-notes 待办中/)
    assert.match(pluginSkill, /不主动测试理论镜像域名、模糊搜索、无结果页或多结果页/)
    assert.match(pluginSkill, /普通模糊搜索列表不是.*多候选结果.*契约/)
    assert.match(pluginSkill, /YST-222 只是参数格式示例，不是固定测试目标/)

    assert.match(browserSkill, /action 为 `open\|snapshot\|find\|html\|evaluate\|click\|fill\|press\|wait\|status\|handoff`/)
    assert.match(browserSkill, /Playwright ARIA snapshot 与完整 `pageFacts`/)
    assert.match(browserSkill, /当前页面不是中文.*明确显示语言选择入口/)
    assert.match(browserSkill, /优先简体中文，其次繁体中文/)
    assert.match(browserSkill, /不要猜测 locale URL、反复查找语言入口或来回切换/)
    assert.match(browserSkill, /成人确认.*每个遮挡层最多安全尝试一次/)
    assert.match(browserSkill, /明确要求登录且没有可跳过入口.*reason="login"/)
    assert.match(browserSkill, /不得代替用户登录、注册、购买、订阅、授权账号/)
    assert.match(browserSkill, /handoff 后立即结束当前轮次/)
    assert.match(browserSkill, /只有一个明确缺失事实时才追加最直接的操作/)
    assert.match(browserSkill, /得到答案后立即返回编码/)
    assert.match(browserSkill, /`full`.*`artifact`.*`delta`.*`unchanged`.*`pending`/)
    assert.match(browserSkill, /宿主不会按字段或关键词猜测哪些页面内容重要/)
    assert.match(browserSkill, /`inlineComplete=false`.*`omittedInlineSections`.*`pageFactsSummary`/)
    assert.match(browserSkill, /不得把 `inlineComplete=false` 当作页面没有相关字段/)
    assert.match(browserSkill, /`unchanged`.*必须停止相同探索/)
    assert.match(browserSkill, /`pending`.*只调用一次 `snapshot`.*绝不能重复 click\/fill\/press/)
    assert.doesNotMatch(browserSkill, /plugin_dry_run|supportedFields|blocking issue|三次/)

    assert.doesNotMatch(pluginFormat, /## 工作流|plugin_dry_run|ask_user|reasoning/)
    assert.match(pluginFormat, /ctx\.fetchPage\(url, options\?\): Promise<string>/)
    assert.equal(task.schemaVersion, 3)
    assert.equal(task.instructionSetVersion, 9)
    assert.deepEqual(task.runTargets, [{ kind: 'video', code: 'YST-222' }])
    assert.equal(Object.hasOwn(task, 'instructions'), false)
    assert.equal(Object.hasOwn(task, 'fieldScope'), false)
    assert.equal(Object.hasOwn(task, 'supportedFields'), false)
  })

  it('generates isolated result contracts and workflow examples for each plugin kind', () => {
    const video = buildRunInstructionSet({ task: createTask }).workspaceResources
    const actress = buildRunInstructionSet({
      task: { ...createTask, kind: 'actress', testTargets: ['三上悠亜'] }
    }).workspaceResources
    const actressFormat = actress['docs/plugin-format.md']
    const actressSkill = actress['.agents/skills/javdex-plugin-dev/SKILL.md']

    assert.match(video['docs/plugin-format.md'], /\| `index\.js` 结果键 \| `plugin\.json\.supportedFields` 字段 id \|/)
    assert.match(video['docs/plugin-format.md'], /result\.coverUrl = value/)
    assert.match(video['docs/plugin-format.md'], /"supportedFields": \["cover"\]/)
    assert.match(video['docs/plugin-format.md'], /不要写成 `result\.cover`/)
    assert.match(video['docs/plugin-format.md'], /不要声明 `\["coverUrl"\]`/)
    assert.match(video['docs/plugin-format.md'], /coverUrl.*cover/)
    assert.match(video['docs/plugin-format.md'], /durationSeconds.*duration/)
    assert.match(video['docs/plugin-format.md'], /sourceUrl.*source/)
    assert.match(video['docs/plugin-format.md'], /actressesFemale.*actressesMale/)
    assert.doesNotMatch(actressFormat, /coverUrl|durationSeconds|actressesFemale|actressesMale/)
    assert.doesNotMatch(actressFormat, /sourceUrl.*→.*source/)
    assert.match(actressFormat, /mainName.*运行身份键/)
    assert.match(actressFormat, /sourceUrl.*可选调试来源/)
    assert.match(actressFormat, /二者都不属于 `supportedFields`/)
    assert.match(actressFormat, /result\.avatarUrl = value/)
    assert.match(actressFormat, /"supportedFields": \["avatar"\]/)
    assert.match(actressSkill, /ctx\.mainName.*ctx\.aliases/)
    assert.match(actressSkill, /"actresses"/)
    assert.match(actressSkill, /三上悠亜只是参数格式示例，不是固定测试目标/)
    assert.doesNotMatch(actressSkill, /ctx\.code|videoCodes|actressesFemale|actressesMale|gender/)
  })

  it('marks field documentation as a query table rather than an implementation checklist', () => {
    const fieldDocument = buildRunInstructionSet({ task: createTask })
      .workspaceResources['docs/fields-video.md']

    assert.match(fieldDocument, /字段语义查询表/)
    assert.match(fieldDocument, /不是实现清单/)
    assert.match(fieldDocument, /supportedFields 使用的字段 id/)
    assert.match(fieldDocument, /“返回键”.*两者不得互换/)
    assert.match(fieldDocument, /先观察精确详情页，再用 grep 按页面实际出现的标签或字段 id 查询/)
  })

  it('makes a resolved choice transition directly to editing', () => {
    const prompt = buildContinuation({
      kind: 'choice_resolved',
      decision: { optionId: 'publisher', label: 'publisher（发行商）' }
    })

    assert.match(prompt, /当前歧义已经解决，探索阶段结束/)
    assert.match(prompt, /直接更新受该决定影响的 dev-notes 和所需的 index\.js\/plugin\.json/)
    assert.match(prompt, /相关文件一致后调用 plugin_dry_run/)
    assert.match(prompt, /不要求为该决定拆出额外开发批次/)
    assert.match(prompt, /不要重新读取文档或重新浏览/)
  })

  it('resumes a completed browser handoff from the interrupted location', () => {
    const prompt = buildContinuation({
      kind: 'browser_interaction_resolved',
      reason: 'login'
    })

    assert.match(prompt, /reason=login/)
    assert.match(prompt, /只检查 browser\(action="status"\)/)
    assert.match(prompt, /不要重新开始探索，也不要重复触发原操作/)
  })

  it('uses the host initial dry-run in debug mode without requesting a duplicate run', () => {
    const instructionSet = buildRunInstructionSet({
      task: { ...createTask, mode: 'debug' },
      debugResult: 'ok=true; title=YST-222'
    })

    assert.match(instructionSet.initialMessage, /宿主已经.*执行了初始 plugin_dry_run/)
    assert.match(instructionSet.initialMessage, /代码发生变化前不要重复运行/)
    assert.match(instructionSet.initialMessage, /不要为了形成多轮流程而修改代码/)
    assert.match(instructionSet.initialMessage, /ok=true; title=YST-222/)
    assert.doesNotMatch(instructionSet.initialMessage, /先调用 plugin_dry_run/)
  })

  it('generates stable v9 resources for identical inputs', () => {
    const first = buildRunInstructionSet({ task: createTask })
    const second = buildRunInstructionSet({ task: structuredClone(createTask) })
    assert.deepEqual(second, first)
    const hash = (resources: Record<string, string>) => createHash('sha256')
      .update(JSON.stringify(Object.entries(resources)))
      .digest('hex')
    assert.equal(hash(second.workspaceResources), hash(first.workspaceResources))
  })

  it('applies user feedback without manufacturing an extra development round', () => {
    const prompt = buildContinuation({ kind: 'user_feedback', text: '继续补齐字段' })

    assert.match(prompt, /dev-notes\.md、index\.js、plugin\.json 和 \.javdex\/latest-dry-run\.json/)
    assert.match(prompt, /不重新开始探索或通读大型文档/)
    assert.match(prompt, /只处理这次指示带来的明确差异/)
    assert.match(prompt, /不要为了维持多轮流程制造额外改动/)
  })

  it('treats the resume button as continuation rather than new defect feedback', () => {
    const prompt = buildContinuation({ kind: 'resume' })

    assert.match(prompt, /不把本次继续操作视为新的缺陷或需求/)
    assert.match(prompt, /dev-notes\.md、index\.js、plugin\.json 和 \.javdex\/latest-dry-run\.json/)
    assert.match(prompt, /没有时直接简短回应；有时选择最小的有效修改/)
    assert.match(prompt, /不要假设继续操作必须产生新的修改或开发轮次/)
    assert.doesNotMatch(prompt, /用户的新指示/)
  })

  it('exposes only dry-run, typed user input and the browser adapter tools', () => {
    const names = PLUGIN_DEV_TOOL_SCHEMAS.map((tool) => tool.function.name)
    assert.deepEqual(names, ['plugin_dry_run', 'browser', 'ask_user'])
    const descriptions = PLUGIN_DEV_TOOL_SCHEMAS
      .map((tool) => tool.function.description)
      .join('\n')
    assert.doesNotMatch(descriptions, /修改|重跑|探索|明显错误|三次|产品决定/)
    const browser = PLUGIN_DEV_TOOL_SCHEMAS.find((tool) => tool.function.name === 'browser')
    const action = browser?.function.parameters.properties.action as { enum?: string[] } | undefined
    const reason = browser?.function.parameters.properties.reason as { enum?: string[] } | undefined
    assert.deepEqual(action?.enum, [
      'open', 'snapshot', 'find', 'html', 'evaluate', 'click', 'fill', 'press', 'wait', 'status', 'handoff'
    ])
    assert.deepEqual(reason?.enum, ['human_verification', 'login', 'required_user_action'])
  })
})
