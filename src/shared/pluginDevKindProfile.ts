import {
  buildActressReturnFieldGlossary,
  buildSupportedFieldsPromptSection,
  buildVideoReturnFieldGlossary
} from '@shared/scrapeFieldPromptDocs'
import {
  ACTRESS_SCRAPE_FIELD_OPTIONS,
  ALL_ACTRESS_SCRAPE_FIELDS,
  ALL_VIDEO_SCRAPE_FIELDS,
  VIDEO_SCRAPE_FIELD_OPTIONS,
  type ActressScrapeField,
  type PluginDevDryRunResult,
  type PluginDevPageInsight,
  type ScraperPluginKind,
  type VideoScrapeField
} from '@shared/types'

export interface PluginDevKindProfile {
  kind: ScraperPluginKind
  parserName: 'parseVideo' | 'parseActress'
  pageLabel: '详情页' | '资料页'
  entryKind: 'detail' | 'profile'
  queryHint: string
  resultIdentityKey: 'code' | 'mainName'
  kindLabel: string
  verifySubjectLabel: string
  testTargetLabel: string
  testTargetShortLabel: string
  siteUrlLabel: string
  defaultPluginNameSuffix: string
  allSupportedFields: readonly (VideoScrapeField | ActressScrapeField)[]
  fieldOptions: typeof VIDEO_SCRAPE_FIELD_OPTIONS | typeof ACTRESS_SCRAPE_FIELD_OPTIONS
  emptyPackageStub: string
  substantialCodePattern: RegExp
  dryRunMissingMessage: string
  aiDebugNeedsTargetMessage: string
  multiDryRunNote: string
  supportedFieldsMissingExample: string
  semanticFieldMismatchExample: string
  semanticAbsentFieldExamples: string
  buildReturnGlossary: () => string
  buildSupportedFieldsSection: () => string
  buildKindSpecificRules: () => string
  buildCreateModeDefaults: () => string
  buildSupportedFieldsCreateHints: () => { targetHint: string; missingHint: string }
  buildAbsentFieldExample: () => string
  buildDebugMultiTargetRule: () => string
  buildVerifyReferenceHint: () => string
  buildCodeModalPlaceholder: () => string
  summarizeDryRunResult: (result: Record<string, unknown>) => string
  pageMatchesReferenceTarget: (
    page: PluginDevPageInsight,
    target: string,
    lastResult?: unknown
  ) => boolean
  extractResultIdentity: (result: unknown) => string | undefined
}

/** True when reference page title/body likely belongs to the actress under verification. */
export function pageMatchesActressTarget(
  page: PluginDevPageInsight,
  targetName: string,
  lastResult?: unknown
): boolean {
  const target = targetName.trim()
  if (!target) return true

  const blob = `${page.title ?? ''}\n${page.text ?? ''}`
  const candidates = new Set<string>([target])
  if (lastResult && typeof lastResult === 'object') {
    const rec = lastResult as Record<string, unknown>
    for (const key of ['mainName', 'nameZh', 'nameEn'] as const) {
      const value = rec[key]
      if (typeof value === 'string' && value.trim()) candidates.add(value.trim())
    }
  }

  for (const name of candidates) {
    if (blob.includes(name)) return true
  }
  return false
}

const VIDEO_PROFILE: PluginDevKindProfile = {
  kind: 'video',
  parserName: 'parseVideo',
  pageLabel: '详情页',
  entryKind: 'detail',
  queryHint: 'ctx.code',
  resultIdentityKey: 'code',
  kindLabel: '影片',
  verifySubjectLabel: '影片',
  testTargetLabel: '测试番号',
  testTargetShortLabel: '番号',
  siteUrlLabel: '网站主页',
  defaultPluginNameSuffix: 'video-scraper',
  allSupportedFields: ALL_VIDEO_SCRAPE_FIELDS,
  fieldOptions: VIDEO_SCRAPE_FIELD_OPTIONS,
  emptyPackageStub: `async function parseVideo(ctx) {
  const code = ctx.code;
  return { code, title: null, sourceUrl: null };
}

module.exports = { parseVideo };
`,
  substantialCodePattern:
    /\bfetchPage\b|\bctx\.browser\b|cheerio\.load|\$\(|parseDetail|searchUrl|buildDirect/i,
  dryRunMissingMessage:
    '缺少测试番号。若用户未填写，请先从主页/详情页探测并选择 testTarget 或 testTargets。',
  aiDebugNeedsTargetMessage: 'AI调试需要至少填写一个测试番号',
  multiDryRunNote:
    '多番号 dry-run：supportedFields 应按所有详情页字段语义来源取并集；单页缺字段不代表站点不支持。',
  supportedFieldsMissingExample:
    '单个详情页无时长/评分/系列等信息时，不要删除对应 supportedFields；verify 备注用「页面无此字段」。整站模板从不提供某字段时，verify 备注用「站点无此字段」以自动移除。',
  semanticFieldMismatchExample:
    '；例如制作商、发行商、系列必须对应各自语义来源，不能互换，也不能用番号前缀充当发行商',
  semanticAbsentFieldExamples: '（例如无系列、无导演）',
  buildReturnGlossary: buildVideoReturnFieldGlossary,
  buildSupportedFieldsSection: () => buildSupportedFieldsPromptSection('video'),
  buildKindSpecificRules: () =>
    `- 返回的 code 番号必须统一为大写字母；从页面解析、与 ctx.code 匹配、写入返回对象前都要 toUpperCase 规范化。
- 同一 href（如 /studio/、/label/）可能在面包屑与元数据区各出现且文本不同；禁止在未 load 的文档根上全局 $('a[href^="/studio/"]').first()，应在 const $ = ctx.cheerio.load(html) 后于元数据区内查找。
- 优先在元数据区按标签（片商、厂牌、Maker、Label）或 DEFINITION_LISTS 定位字段。`,
  buildCreateModeDefaults: () =>
    `- create 模式缺省输入：若用户未填写插件名，先根据域名生成可用名称，并在探测到页面标题/站点品牌后用 plugin_update_package 改成更合适的唯一名称；若用户未填写测试番号，判断“主页或列表页”时从页面可见热门/最新条目中选择 2-3 个番号测试，判断“详情页”时从 URL、标题或页面正文提取当前番号测试。
- 多测试目标：逐个打开/测试目标详情页；supportedFields 以所有测试页面出现的字段语义来源取并集；plugin_dry_run 可传 testTarget 或 testTargets。`,
  buildSupportedFieldsCreateHints: () => ({
    targetHint:
      '当提供多个测试番号时，supportedFields 应取这些详情页实际出现字段语义来源的并集；某一个页面缺字段不代表要从并集中删除。',
    missingHint:
      '不得因当前测试番号缺字段就删除站点支持的字段（如本片无系列/无评分 ≠ 站点不支持系列/评分）。'
  }),
  buildAbsentFieldExample: () => '页面确实没有的字段（如部分影片无系列/导演）',
  buildDebugMultiTargetRule: () =>
    '若提供多个测试番号，必须连续检查每个番号的 dry-run case，不能只修最后一个。',
  buildVerifyReferenceHint: () => '',
  buildCodeModalPlaceholder: () =>
    'module.exports = { async parseVideo(ctx) { return null } }',
  summarizeDryRunResult(rec) {
    return `maker=${String(rec.maker ?? '无')} publisher=${String(rec.publisher ?? '无')} title=${String(rec.title ?? '无').slice(0, 40)}`
  },
  pageMatchesReferenceTarget(page, target, lastResult) {
    const candidates = new Set<string>()
    if (target.trim()) candidates.add(target.trim().toUpperCase())
    const code =
      lastResult && typeof lastResult === 'object'
        ? (lastResult as { code?: unknown }).code
        : undefined
    if (typeof code === 'string' && code.trim()) candidates.add(code.trim().toUpperCase())
    if (candidates.size === 0) return true
    const blob = `${page.title ?? ''}\n${page.text ?? ''}`.toUpperCase()
    for (const item of candidates) {
      if (blob.includes(item)) return true
    }
    return false
  },
  extractResultIdentity(result) {
    if (!result || typeof result !== 'object') return undefined
    const code = (result as { code?: unknown }).code
    return typeof code === 'string' && code.trim() ? code.trim() : undefined
  }
}

const ACTRESS_PROFILE: PluginDevKindProfile = {
  kind: 'actress',
  parserName: 'parseActress',
  pageLabel: '资料页',
  entryKind: 'profile',
  queryHint: 'ctx.mainName / ctx.aliases',
  resultIdentityKey: 'mainName',
  kindLabel: '演员',
  verifySubjectLabel: '演员资料',
  testTargetLabel: '测试演员',
  testTargetShortLabel: '演员',
  siteUrlLabel: '网站主页',
  defaultPluginNameSuffix: 'actress-scraper',
  allSupportedFields: ALL_ACTRESS_SCRAPE_FIELDS,
  fieldOptions: ACTRESS_SCRAPE_FIELD_OPTIONS,
  emptyPackageStub: `async function parseActress(ctx) {
  return { mainName: ctx.mainName, profileSummary: null, sourceUrl: null };
}

module.exports = { parseActress };
`,
  substantialCodePattern:
    /\bfetchPage\b|\bctx\.browser\b|cheerio\.load|\$\(|parseProfile|searchUrl/i,
  dryRunMissingMessage:
    '缺少测试演员名。若用户未填写，请先从列表页/搜索页/资料页探测并传 testTarget 或 testTargets。',
  aiDebugNeedsTargetMessage: 'AI调试需要至少填写一个测试演员',
  multiDryRunNote:
    '多演员 dry-run：supportedFields 应按所有资料页字段语义来源取并集；单个演员缺字段不代表站点不支持。',
  supportedFieldsMissingExample: `单个资料页无写真/三围/别名等信息时，不要删除对应 supportedFields；verify 备注用「页面无此字段」。整站模板从不提供某字段时，verify 备注用「站点无此字段」以自动移除。`,
  semanticFieldMismatchExample:
    '；例如头像、三围、简介必须对应各自语义来源，不能把搜索页标题或无关文本当作资料字段',
  semanticAbsentFieldExamples: '（例如无写真、无三围、无别名）',
  buildReturnGlossary: buildActressReturnFieldGlossary,
  buildSupportedFieldsSection: () => buildSupportedFieldsPromptSection('actress'),
  buildKindSpecificRules: () =>
    `- parseActress(ctx) 入参为 ctx.mainName 与 ctx.aliases，不要使用 ctx.code。
- 资料页通常需搜索进入或按 slug 直达；优先在资料页元数据区按标签（身高、三围、生日、简介等）定位字段。
- 演员搜索要尝试 ctx.mainName 与 ctx.aliases；动态搜索优先反编 AJAX 为 ctx.fetchPage，无法反编时用 ctx.fetchPage 打开搜索页 + ctx.browser 交互 + ctx.browser.html()，再从结果中的 /model/、/actress/、/star/ 等链接进入资料页。
- 数值字段（heightCm、bustCm 等）应返回 number；日期字段返回 YYYY-MM-DD 字符串；可用 ctx.helpers.normalizeDate 标准化。
- parseActress 应返回 sourceUrl（实际资料页 URL），供 verify 打开正确参考页。`,
  buildCreateModeDefaults: () =>
    `- create 模式缺省输入：若用户未填写插件名，先根据域名生成可用名称，并在探测到页面标题/站点品牌后用 plugin_update_package 改成更合适的唯一名称；若用户未填写测试演员名，从演员列表页、搜索页结果或资料页标题/URL slug 中选取 1-3 个可用于搜索的演员名测试。
- 多测试目标：逐个打开/测试目标资料页；supportedFields 以所有测试页面出现的字段语义来源取并集；plugin_dry_run 可传 testTarget 或 testTargets。`,
  buildSupportedFieldsCreateHints: () => ({
    targetHint:
      'supportedFields 应取资料页实际出现字段语义来源；当前测试演员资料页缺字段不代表要从声明中删除。',
    missingHint:
      '不得因当前测试演员缺字段就删除站点支持的字段（如该演员无写真/无三围 ≠ 站点不支持写真/三围）。'
  }),
  buildAbsentFieldExample: () => '页面确实没有的字段（如部分演员资料页无写真/三围/别名）',
  buildDebugMultiTargetRule: () =>
    '若提供多个测试演员，必须连续检查每个演员的 dry-run case，不能只修最后一个。',
  buildVerifyReferenceHint: () =>
    '\n重要：参考页面必须是上述测试演员的资料页。若参考页面标题/正文明显属于其他演员，不得用其语义否定当前调试结果。',
  buildCodeModalPlaceholder: () =>
    'module.exports = { async parseActress(ctx) { return null } }',
  summarizeDryRunResult(rec) {
    return `mainName=${String(rec.mainName ?? '无')}`
  },
  pageMatchesReferenceTarget: pageMatchesActressTarget,
  extractResultIdentity(result) {
    if (!result || typeof result !== 'object') return undefined
    const mainName = (result as { mainName?: unknown }).mainName
    return typeof mainName === 'string' && mainName.trim() ? mainName.trim() : undefined
  }
}

const PROFILES: Record<ScraperPluginKind, PluginDevKindProfile> = {
  video: VIDEO_PROFILE,
  actress: ACTRESS_PROFILE
}

export function getPluginDevKindProfile(kind: ScraperPluginKind): PluginDevKindProfile {
  return PROFILES[kind]
}

export function parseTestTargetList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean)
  }
  if (typeof value !== 'string') return []
  return value
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export interface PluginDevTestTargetInput {
  testTarget?: string
  testTargets?: string[] | unknown
}

/** Merge testTarget and testTargets into a deduped list. */
export function normalizeTestTargets(input: PluginDevTestTargetInput): string[] {
  const single = typeof input.testTarget === 'string' ? input.testTarget.trim() : ''
  const fromList = parseTestTargetList(input.testTargets)
  return [...new Set([...(single ? [single] : []), ...fromList].filter(Boolean))]
}

export function resolveDryRunTargetsFromArgs(
  _kind: ScraperPluginKind,
  args: Record<string, unknown>,
  sessionTargets: string[]
): string[] {
  const fromArgs = normalizeTestTargets({
    testTarget: typeof args.testTarget === 'string' ? args.testTarget : undefined,
    testTargets: args.testTargets
  })
  return [...new Set([...fromArgs, ...sessionTargets].filter(Boolean))]
}

export function buildDryRunToolArgs(targets: string[]): Record<string, unknown> {
  if (targets.length === 0) return {}
  if (targets.length === 1) return { testTarget: targets[0] }
  return { testTargets: targets }
}

export function testTargetsFromDryRun(
  kind: ScraperPluginKind,
  dryRun: PluginDevDryRunResult | null | undefined
): string[] {
  if (!dryRun) return []
  const profile = getPluginDevKindProfile(kind)
  const values: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) values.push(value.trim())
  }

  if (dryRun.cases?.length) {
    for (const item of dryRun.cases) {
      push(item.target)
      push(profile.extractResultIdentity(item.result))
    }
  } else {
    push(profile.extractResultIdentity(dryRun.result))
  }

  return [...new Set(values)]
}

export function fieldLabelForKind(kind: ScraperPluginKind, field: string): string {
  const profile = getPluginDevKindProfile(kind)
  return profile.fieldOptions.find((option) => option.id === field)?.label ?? field
}

export function allFieldIdsForKind(kind: ScraperPluginKind): string[] {
  return getPluginDevKindProfile(kind).fieldOptions.map((option) => option.id)
}

export function allFieldsForKind(
  kind: ScraperPluginKind
): Array<VideoScrapeField | ActressScrapeField> {
  return [...getPluginDevKindProfile(kind).allSupportedFields]
}

export function describeFieldsForKind(
  kind: ScraperPluginKind,
  fields: readonly (VideoScrapeField | ActressScrapeField)[]
): string {
  const profile = getPluginDevKindProfile(kind)
  return fields
    .map((field) => {
      const label = profile.fieldOptions.find((option) => option.id === field)?.label ?? field
      return `${field}(${label})`
    })
    .join(', ')
}

export function buildDynamicSearchRules(kind: ScraperPluginKind): string {
  const profile = getPluginDevKindProfile(kind)
  return `- 搜索方案识别：优先使用标准 form/action/method/name 组合构造搜索 URL；只有页面没有可用 form，或 inspect 显示 selector=document / method=interactive 的输入框时，才进入脚本/AJAX 识别分支。
- 动态搜索：若页面没有 form，或 inspect 显示 selector=document / method=interactive 的输入框，必须检查按钮、脚本、AJAX/XHR 入口；不要把“URL 没变化”当作搜索失败。
- AJAX 搜索常见模式是点击/输入后把结果写入 #results、.results、.search-result 等容器。探测时操作后必须 browser_wait 再 browser_inspect/browser_html 查看更新后的 DOM。
- 插件实现优先级（动态/AJAX 站点，按顺序尝试）：
  1. 标准 GET 搜索 URL（form action + query 参数，${profile.queryHint} 填入参数）→ ctx.fetchPage → 解析 ${profile.entryKind} 链接 → ctx.fetchPage 进入${profile.pageLabel}。
  2. 反编 AJAX/XHR：用 browser_evaluate/inspect 找到稳定 endpoint 与参数，在插件里改写为 ctx.fetchPage(反编后的 URL) 获取搜索/片段 HTML，再解析 ${profile.entryKind} 链接进入${profile.pageLabel}。
  3. 无法稳定反编 AJAX（需 token/签名、POST body 难复现、结果只由前端脚本渲染）时：ctx.fetchPage 打开搜索页 → ctx.browser.type/click/press/waitForSelector/wait → const html = await ctx.browser.html() → const $search = ctx.cheerio.load(html) 解析 ${profile.entryKind} 链接 → 再 ctx.fetchPage 或继续 browser 进入${profile.pageLabel}。
- dry-run 若搜索无结果且探测曾需交互才出结果，检查是否误用纯 fetchPage 猜 URL；先尝试反编 AJAX，不行再补 ctx.browser 交互流程。
- 搜索结果页/结果片段只用于定位 ${profile.entryKind} 链接；返回字段必须来自${profile.pageLabel}，除非站点确实在结果中渲染完整记录。`
}

export function pageMatchesReferenceTargetForKind(
  kind: ScraperPluginKind,
  page: PluginDevPageInsight,
  target: string,
  lastResult?: unknown
): boolean {
  return getPluginDevKindProfile(kind).pageMatchesReferenceTarget(page, target, lastResult)
}

/** True when user text explicitly asks to remove fields from supportedFields. */
export function userRequestedSupportedFieldRemoval(text: string | undefined): boolean {
  if (!text?.trim()) return false
  return /(?:删除|移除|去掉|取消).{0,12}(?:支持字段|supported\s*fields?|字段支持)|(?:支持字段|supported\s*fields?).{0,12}(?:删除|移除|去掉|取消)|从支持字段.{0,8}(?:删除|移除|去掉)/i.test(
    text
  )
}
