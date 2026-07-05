import type { PluginDevAgentStartInput, ScraperPluginKind } from '@shared/types'
import { APP_DISPLAY_NAME } from '@shared/appIdentity'
import {
  buildDynamicSearchRules,
  describeFieldsForKind,
  getPluginDevKindProfile,
  normalizeTestTargets
} from '@shared/pluginDevKindProfile'
import type { PluginDevSession } from './types'
import {
  buildCheerioRules,
  formatPackageCodeForAgent,
  hasSubstantialPluginCode,
  incrementalEditPolicyText,
  appendCheerioDryRunHint
} from './pluginDevCodePolicy'
import type { PluginDevDryRunResult } from '@shared/types'

function describeTestTargets(input: PluginDevAgentStartInput): string {
  const unique = normalizeTestTargets(input)
  return unique.length > 0 ? unique.join(', ') : '未提供'
}

function buildSupportedFieldsPolicy(input: PluginDevAgentStartInput): string {
  const profile = getPluginDevKindProfile(input.kind)
  if (input.mode === 'create') {
    const { targetHint, missingHint } = profile.buildSupportedFieldsCreateHints()
    return `supportedFields 策略（开始开发）：
- supportedFields 是“插件/站点能力声明”，不是“当前测试目标实际返回了哪些字段”。
- 确认站点不提供某字段时：plugin_verify 备注须写「站点无此字段」或「站点详情页模板无此字段标签」，verify 后会自动从 supportedFields 移除；也可手动 plugin_update_package。
- ${targetHint}
- ${missingHint}
- 若只是当前${profile.pageLabel}缺某字段（如本片无系列），保留 supportedFields，parse 留空，verify 备注用「页面无此字段」。
- 进入 implement/dry_run 后，除非发现新的站点级证据，否则不必反复调整 supportedFields。`
  }
  return `supportedFields 策略（调试已安装插件）：
- plugin_verify 后系统只会自动新增 supportedFields，不会自动删除。
- 删除支持字段须用户明确要求，再调用 plugin_update_package（可传 confirmUserRemoval: true）。
- 测试目标缺少部分字段是正常现象；验证时留空视为正确。`
}

function buildKindSpecificResultRules(kind: ScraperPluginKind): string {
  if (kind !== 'video') return ''
  return `- 影片评分 ratingAverage 必须返回 5 分制数值，范围 > 0 且 <= 5，最多保留 1 位小数；来源为 10 分制时先除以 2。评分为 0、为空、NaN、超出范围或无法判断时，不要返回 ratingAverage/ratingCount。`
}

export function buildAgentSystemPrompt(kind: ScraperPluginKind): string {
  const profile = getPluginDevKindProfile(kind)
  return `你是 ${APP_DISPLAY_NAME} 刮削插件开发 agent。你必须通过工具完成开发和调试，不要臆测页面结构。

工作流（严格遵守）：
1. create 模式先用 browser_fetch_page / browser_inspect / browser_html / browser_evaluate 探测真实页面结构与字段来源；debug 模式跳过从零探测，先使用启动时已有 code 的 dry-run 结果。
2. 用 plugin_update_code 编写或修复插件；已有实质 code 时优先 replace_snippet（几行）→ replace_function（整函数），replace_all 仅作有明确理由的兜底。debug/用户反馈模式先基于现有 code 与 dry-run 结果判断，再决定是否探测页面。
3. 用 plugin_dry_run 获取客观调试结果。
4. 用 plugin_verify 做语义验证；用户反馈优先级最高。${profile.buildAbsentFieldExample()}留空视为正确，不要强行解析。
   - 修改 code 后必须先 plugin_dry_run，再 plugin_verify；verify 会拒绝过期的 dry-run。
   - 仅修改 supportedFields 且工具提示“上次语义验证仍有效”时，不要重复 plugin_verify，可继续 finish；若验证已失效，可直接 plugin_verify，无需重新 dry-run。
   - 开始开发（create）时 verify 会自动新增/删除 supportedFields；调试已安装插件时 verify 只自动新增，不自动删除。
5. 只有 dry-run 与验证通过后，才能 plugin_finish(success=true)。

阶段规则：
- discover：先打开页面、搜索/直达${profile.pageLabel}、inspect/html/evaluate 确认 DOM，不要靠猜选择器。
${profile.buildCreateModeDefaults()}
${buildDynamicSearchRules(kind)}
- debug 模式：不要按 create 模式从头探测和实现。必须先使用当前已有 code 的 dry-run 结果进入调试；${profile.buildDebugMultiTargetRule()}只有 dry-run 失败、verify 不通过、或用户反馈需要定位字段来源时，才最小化使用浏览器工具探测并修复 code。
- supportedFields：create 模式 verify 后自动新增并移除；debug 模式 verify 后只自动新增，删除须用户明确要求后再 plugin_update_package。
- implement：只在明确字段来源后更新代码；若验证指出字段错，优先用 replace_snippet 改对应解析片段；避免无谓整函数/整包重写。
${incrementalEditPolicyText()}
${buildCheerioRules()}
- dry_run：每次修改 code 后必须重新运行。
- verify：用页面语义和用户反馈审核结果；未通过则回到 implement。
- finish：只有 dry-run ok 且 verify 无失败项才结束。

关键规则：
${profile.buildKindSpecificRules()}
${buildKindSpecificResultRules(kind)}
- 修复是否成功以 plugin_dry_run 的 JSON 为准，不是口头判断。
- 仅当 browser_status.isChallenge 为 true，或 browser_fetch_page 返回 code=CHALLENGE 时，才调用 session_request_user；普通内容页不要因页面加载慢或 404 误判为 Cloudflare。

${profile.buildSupportedFieldsSection()}
${profile.buildReturnGlossary()}

插件运行时规范：
- 代码必须是 CommonJS；导出 async function ${profile.parserName}(ctx)，也兼容 parseTask。
- 禁止 import/require、Node API、文件系统或直接网络请求；只能使用 ctx 提供能力。
- ctx.fetchPage(url, { readySelector?, timeoutMs? }) 返回 HTML 字符串；ctx.fetchBuffer(url) 返回二进制。
- ctx.cheerio 是 cheerio 模块本身；用法 const $ = ctx.cheerio.load(htmlString)，再 $('.selector')。无全局 $。
- ctx.helpers.absoluteUrl、normalizeDate、normalizeText、unique 可用于标准化。
- 动态搜索实现顺序：① GET 搜索 URL + fetchPage；② 反编 AJAX 为 fetchPage；③ 无法反编时用 fetchPage 打开搜索页 + ctx.browser（type/click/press/waitForSelector/wait）+ browser.html() 取交互后 HTML。
- ctx.browser：snapshot/click/type/press/waitForSelector/wait/inspect/html/url；与 fetchPage 共用验证窗口与会话。
- 返回 null 表示未匹配；返回对象字段必须使用上方“返回字段中文含义”里的标准 key。
`
}

function summarizeLogTail(logs: readonly string[] | undefined): string[] {
  if (!logs?.length) return []
  return logs.slice(-6).map((line) => (line.length > 500 ? `${line.slice(0, 500)}…` : line))
}

export function summarizeDryRunForAgent(dryRun: PluginDevDryRunResult | undefined): string {
  if (!dryRun) return '无'
  return JSON.stringify(
    {
      ok: dryRun.ok,
      error: appendCheerioDryRunHint(dryRun.error),
      result: dryRun.result,
      logCount: dryRun.logs.length,
      logTail: summarizeLogTail(dryRun.logs)
    },
    null,
    2
  )
}

function formatCurrentCodeBlock(session: PluginDevSession): string {
  if (!session.package.code.trim()) return ''
  return `\n\n当前插件 code：\n\`\`\`javascript\n${formatPackageCodeForAgent(session.package.code)}\n\`\`\``
}

export function buildContinueUserMessage(text: string, session: PluginDevSession): string {
  const trimmed = text.trim()
  const dryRun = session.lastDryRun
  const dryRunBlock = dryRun ? `\n\n当前调试结果摘要：\n${summarizeDryRunForAgent(dryRun)}` : ''
  const codeBlock = formatCurrentCodeBlock(session)
  const policy =
    session.incrementalEditOnly || hasSubstantialPluginCode(session.kind, session.package.code)
      ? `\n\n${incrementalEditPolicyText()}`
      : ''
  return `用户反馈（最高优先级，在已有插件上增量修复，不是从零开发）：
${trimmed}${dryRunBlock}${codeBlock}${policy}

请先基于上方 code 与 dry-run 结果定位问题，优先 replace_snippet 最小修改，再 replace_function；只有明确需要整体重构时才带 forceReason 使用 replace_all。只有 dry-run/verify 仍无法定位字段来源时，才最小化使用浏览器工具。`
}

function formatDryRunBlock(dryRun: PluginDevSession['lastDryRun']): string {
  return dryRun ? `\n上次调试结果摘要：\n${summarizeDryRunForAgent(dryRun)}` : ''
}

export function buildInitialUserMessage(
  input: PluginDevAgentStartInput,
  session: PluginDevSession
): string {
  const profile = getPluginDevKindProfile(input.kind)
  const testTarget = describeTestTargets(input)
  const siteName = input.siteName.trim()
  const base = `任务模式：${input.mode}
站点/插件名：${siteName || '未填写；请根据域名或页面标题自动生成'}
主页或示例地址：${input.siteUrl || session.package.homepage || '未提供'}
测试目标：${testTarget}
需要支持的字段：${describeFieldsForKind(input.kind, input.supportedFields)}
补充需求：${input.description || '无'}

${buildSupportedFieldsPolicy(input)}`

  if (input.mode === 'create') {
    return `${base}

请从零开发可调试的刮削插件。先用浏览器工具探测站点搜索与${profile.pageLabel}结构，再编写 code，最后 dry-run 并 verify。`
  }

  if (input.userMessage?.trim()) {
    const action = input.mode === 'debug' ? '调试并修复' : '修复'
    const label = input.mode === 'debug' ? '调试指示' : '用户反馈'
    const dryRunBlock = formatDryRunBlock(session.lastDryRun)
    const codeBlock = formatCurrentCodeBlock(session)
    const incremental =
      hasSubstantialPluginCode(session.kind, session.package.code) || input.mode === 'debug'
        ? `\n\n${incrementalEditPolicyText()}`
        : ''
    return `${base}

${label}（最高优先级）：
${input.userMessage.trim()}

${input.mode === 'debug' ? 'AI调试模式已跳过从零探测和初次实现，请从当前 code 与 dry-run 结果开始判断。' : '在已有插件上增量修复，不是从零开发。'}请根据上述指示${action}，必须 dry-run 验证通过后再 finish。${dryRunBlock}${codeBlock}${incremental}`
  }

  const dryRunBlock = formatDryRunBlock(session.lastDryRun)
  const codeBlock = formatCurrentCodeBlock(session)

  return `${base}
${dryRunBlock}${codeBlock}

请调试并修复当前插件。AI调试模式已跳过从零探测和初次实现；先基于当前 code 与 dry-run 结果做判断，再 verify。只有 dry-run 失败、verify 不通过或需要定位字段来源时，才最小化使用浏览器确认真实页面结构；修改 code 时优先 replace_snippet，再 replace_function，replace_all 仅在明确需要整体重构时使用。`
}
