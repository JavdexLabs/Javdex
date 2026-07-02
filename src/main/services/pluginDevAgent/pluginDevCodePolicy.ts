import type { ScraperPluginKind } from '@shared/types'
import { appendCheerioDryRunHint, buildCheerioPluginRules } from '@shared/scrapeFieldPromptDocs'
import { getPluginDevKindProfile } from '@shared/pluginDevKindProfile'
import { hashCode } from './sessionStore'

const MAX_CODE_CHARS_FOR_AGENT = 14_000

/** True when package already has a real implementation, not the empty parser stub. */
export function hasSubstantialPluginCode(kind: ScraperPluginKind, code: string): boolean {
  const trimmed = code.trim()
  if (trimmed.length > 320) return true
  return getPluginDevKindProfile(kind).substantialCodePattern.test(trimmed)
}

export function formatPackageCodeForAgent(code: string, maxChars = MAX_CODE_CHARS_FOR_AGENT): string {
  const trimmed = code.trim()
  if (trimmed.length <= maxChars) return trimmed
  const head = Math.floor(maxChars * 0.72)
  const tail = maxChars - head - 80
  return `${trimmed.slice(0, head)}\n…（code 已截断，原始 ${trimmed.length} 字符；可用 plugin_get_state 查看完整 code）…\n${trimmed.slice(-tail)}`
}

export function incrementalEditPolicyText(): string {
  return `增量修改策略（已有实质 code 时优先遵守）：
- 第一优先 plugin_update_code(mode=replace_snippet)：只改 1～30 行（如单个正则、selector、字段赋值）；oldText 须含足够上下文且在 code 中唯一匹配。
- 第二优先 replace_function(functionName=…)：整函数替换；functionName 从 plugin_get_state 的 topLevelFunctions 选取（含 parseVideo/parseActress/parseTask 与 helper）。
- 修 helper 时用 functionName=helper 名，或 replace_snippet；不要在 parseVideo/parseActress 的 code 里重复声明 head 中已有的顶层 helper。
- 最后才用 replace_all：首次编写空 stub 可直接使用；已有实质 code 时只有用户明确要求重写，或 snippet/function 无法安全完成结构重组时，才可传 forceWholeRewrite=true 并写明 forceReason。
- 先用 plugin_get_state 查看 topLevelFunctions；需要源码时传 includeCode=true（可用 codeStartLine/codeLineCount 缩小范围），定位相关函数/行号；保留已验证可用的搜索、直达、字段解析逻辑。
- 用户反馈、verify 失败、dry-run 失败时：优先改对应字段解析片段，避免无谓整包重写。
- replace_function / replace_snippet 后检查 helper 是否仍裸用 $()；helper 须在内部 ctx.cheerio.load(html) 或接收已 load 的根对象。`
}

/** Cheerio rules for agent prompts — sandbox has no global `$`. */
export function buildCheerioRules(): string {
  return buildCheerioPluginRules()
}

export { appendCheerioDryRunHint }

export function codeFingerprint(code: string): string {
  return String(hashCode(code.trim()))
}
