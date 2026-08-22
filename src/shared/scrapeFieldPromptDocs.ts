import { ACTRESS_SCRAPE_FIELD_OPTIONS } from './actressScrapeTypes'
import type { ScraperPluginKind } from './scraperPluginTypes'
import { VIDEO_SCRAPE_FIELD_OPTIONS } from './videoScrapeTypes'
import {
  PLUGIN_FIELD_SEMANTICS_VERSION,
  fieldSemanticDefinition,
  fieldSemanticsForKind
} from './pluginFieldSemantics'
import { pluginResultContract } from './pluginResultContract'

function contractResultKeys(kind: ScraperPluginKind, fieldId: string): string[] {
  return pluginResultContract.describe(kind).keys
    .filter((item) => item.fieldIds.includes(fieldId as never))
    .map((item) => item.key)
}

function fieldOptionLabels(
  options: ReadonlyArray<{ id: string; label: string }>
): Record<string, string> {
  return Object.fromEntries(options.map((option) => [option.id, option.label]))
}

export function buildSupportedFieldsPromptSection(kind: ScraperPluginKind): string {
  const options = kind === 'video' ? VIDEO_SCRAPE_FIELD_OPTIONS : ACTRESS_SCRAPE_FIELD_OPTIONS
  const lines = options.map((option) => {
    const definition = fieldSemanticDefinition(kind, option.id)
    const returnKeys = contractResultKeys(kind, option.id).join('、') || option.id
    return `- ${option.id}（${option.label}）→ parse${
      kind === 'video' ? 'Video' : 'Actress'
    } 返回 ${returnKeys}；${definition?.description ?? ''}`
  })
  return `supportedFields（插件包声明字段，只能使用以下 id；未声明的字段即使代码返回也会被忽略）：
${lines.join('\n')}`
}

export function buildPluginFieldSemanticsPrompt(
  kind: ScraperPluginKind,
  supportedFields?: readonly string[]
): string {
  const selected = supportedFields?.length ? new Set(supportedFields) : undefined
  const fields = fieldSemanticsForKind(kind).filter((field) => !selected || selected.has(field.id))
  return `字段语义查询表（registry v${PLUGIN_FIELD_SEMANTICS_VERSION}，不是实现清单）：
每项标题开头是 plugin.json.supportedFields 使用的字段 id；“返回键”是 parse 结果对象使用的键，两者不得互换。
create 模式应先观察精确详情页，再用 grep 按页面实际出现的标签或字段 id 查询本表；不要为了逐项排除字段而通读或继续浏览。
${fields.map((field) => [
    `- ${field.id}（${field.title}）`,
    `  定义：${field.description}`,
    `  返回键：${contractResultKeys(kind, field.id).join('、')}；类型：${field.valueType}；标准化：${field.normalization}`,
    `  强标签：${[...field.labels.canonical, ...field.labels.strong].join('、') || '无'}`,
    `  歧义标签：${field.labels.ambiguous.join('、') || '无'}`,
    `  强链接路径：${field.linkRoutes.strong.join('、') || '无'}；冲突字段：${field.conflictsWith.join('、') || '无'}`,
    `  缺失策略：${field.absencePolicy === 'optional-per-page' ? '当前页未出现时留空，不代表站点不支持' : '页面观察到时必须返回'}`
  ].join('\n')).join('\n')}`
}

/** Chinese labels for keys returned by parseVideo / dry-run result objects. */
export const VIDEO_PARSE_RESULT_KEY_LABELS: Record<string, string> = {
  ...fieldOptionLabels(VIDEO_SCRAPE_FIELD_OPTIONS),
  code: '番号',
  coverUrl: '封面',
  durationSeconds: '时长',
  sourceUrl: '来源链接',
  ratingAverage: '站点评分',
  ratingCount: '站点评分人数',
  sampleImageUrls: '样张',
  actresses: '演员'
}

/** Chinese labels for keys returned by parseActress / dry-run result objects. */
export const ACTRESS_PARSE_RESULT_KEY_LABELS: Record<string, string> = {
  ...fieldOptionLabels(ACTRESS_SCRAPE_FIELD_OPTIONS),
  mainName: '主名',
  avatarUrl: '头像',
  bustCm: '胸围',
  waistCm: '腰围',
  hipCm: '臀围',
  galleryImageUrls: '写真',
  profile: '简介',
  sourceUrl: '来源链接'
}

export function formatParseResultKeyLabel(kind: ScraperPluginKind, key: string): string {
  const map = kind === 'video' ? VIDEO_PARSE_RESULT_KEY_LABELS : ACTRESS_PARSE_RESULT_KEY_LABELS
  const label = map[key]
  return label ? `${label}(${key})` : key
}

/** Cheerio rules for plugin code — sandbox has no global `$`. */
export function buildCheerioPluginRules(): string {
  return `cheerio 解析（违反会导致 dry-run 报错 "$ is not a function"）：
- 沙箱无全局 $、无 cheerio 变量；禁止 import/require cheerio，禁止 cheerio.load(html)。
- 每个 HTML 字符串必须先 load：const $ = ctx.cheerio.load(html)（搜索页可用 $search，详情页可用 $detail），再使用 $() 选择器。
- 辅助函数禁止裸用 $('.selector')；须 (1) 接收 html 并在函数内 const $ = ctx.cheerio.load(html)，或 (2) 接收已 load 的根对象作为首参（如 parseDetail($, code) 且调用方传入 ctx.cheerio.load(html)）。
- 错误：function parseDetail(html) { return { title: $('.title').text() }; }
- 正确：function parseDetail(html, ctx) { const $ = ctx.cheerio.load(html); return { title: $('.title').text() }; }`
}

export function appendCheerioDryRunHint(error: string | undefined): string | undefined {
  if (!error || !/\$ is not a function/i.test(error)) return error
  return `${error} — CHEERIO_HINT: 沙箱无全局 $。每个 HTML 须先 const $ = ctx.cheerio.load(html)；helper 内同样须 load 或接收 cheerio 根对象。禁止 cheerio.load / import cheerio。`
}
