import {
  ACTRESS_SCRAPE_FIELD_OPTIONS,
  VIDEO_SCRAPE_FIELD_OPTIONS,
  type ScraperPluginKind
} from './types'

const VIDEO_SUPPORTED_FIELD_RETURN_MAP: Record<string, string> = {
  title: 'title',
  summary: 'summary',
  cover: 'coverUrl',
  releaseDate: 'releaseDate（YYYY-MM-DD；若来源只有年月，用 YYYY-MM-01）',
  maker: 'maker（制作商）',
  publisher: 'publisher（发行商）',
  series: 'series（系列）',
  director: 'director（导演）',
  duration: 'durationSeconds（秒）',
  actressesFemale: 'actresses[]，每项 gender 为 female 或未设置',
  actressesMale: 'actresses[]，每项 gender 为 male',
  tags: 'tags（标签数组）',
  source: 'sourceUrl（详情页来源链接）',
  rating: 'ratingAverage（5 分制，最多 1 位小数）、ratingCount',
  samples: 'sampleImageUrls（样张图片 URL 数组）'
}

const ACTRESS_SUPPORTED_FIELD_RETURN_MAP: Record<string, string> = {
  avatar: 'avatarUrl（头像）',
  gallery: 'galleryImageUrls（写真图片 URL 数组）',
  birthDate: 'birthDate（生日，YYYY-MM-DD）',
  nameZh: 'nameZh（中文名）',
  nameEn: 'nameEn（英文名）',
  debutDate: 'debutDate（出道日期，YYYY-MM-DD）',
  heightCm: 'heightCm（身高，厘米）',
  measurements: 'bustCm、waistCm、hipCm（三围，厘米）',
  cupSize: 'cupSize（罩杯，单字母 A-Z）',
  bloodType: 'bloodType（血型）',
  zodiac: 'zodiac（星座）',
  nationality: 'nationality（国籍）',
  profileSummary: 'profileSummary（个人简介）',
  aliases: 'aliases（别名数组）'
}

export function buildSupportedFieldsPromptSection(kind: ScraperPluginKind): string {
  const options = kind === 'video' ? VIDEO_SCRAPE_FIELD_OPTIONS : ACTRESS_SCRAPE_FIELD_OPTIONS
  const returnMap =
    kind === 'video' ? VIDEO_SUPPORTED_FIELD_RETURN_MAP : ACTRESS_SUPPORTED_FIELD_RETURN_MAP
  const lines = options.map((option) => {
    const returnKeys = returnMap[option.id]
    return `- ${option.id}（${option.label}）→ parse${
      kind === 'video' ? 'Video' : 'Actress'
    } 返回 ${returnKeys}`
  })
  return `supportedFields（插件包声明字段，只能使用以下 id；未声明的字段即使代码返回也会被忽略）：
${lines.join('\n')}`
}

export function buildVideoReturnFieldGlossary(): string {
  return `返回字段中文含义：
- code：番号（必须统一为大写字母；从页面解析或与 ctx.code 比较前先做 toUpperCase 规范化）
- title：标题
- summary：简介
- coverUrl：封面图 URL
- releaseDate：发行日期（YYYY-MM-DD；若来源只有年月，用 YYYY-MM-01；不要使用 00 日）
- maker：制作商
- publisher：发行商
- series：系列
- director：导演
- durationSeconds：时长（秒）
- sourceUrl：详情页来源链接
- ratingAverage：站点评分均值，必须换算为 5 分制，范围为 > 0 且 <= 5，最多保留 1 位小数；0 分或不合法评分不要返回
- ratingCount：站点评分人数；仅在 ratingAverage 有效时返回
- sampleImageUrls：样张图片 URL 数组
- actresses：演员数组，每项含 name、可选 avatarUrl、可选 gender（female/male）
- tags：标签数组`
}

export function buildActressReturnFieldGlossary(): string {
  return `返回字段中文含义：
- mainName：主名
- nameZh：中文名
- nameEn：英文名
- avatarUrl：头像 URL
- birthDate：生日（YYYY-MM-DD）
- debutDate：出道日期（YYYY-MM-DD；若来源只有年月，如 2021年10月，用 2021-10-01；不要使用 00 日）
- heightCm：身高（厘米）
- bustCm：胸围（厘米）
- waistCm：腰围（厘米）
- hipCm：臀围（厘米）
- cupSize：罩杯（单字母 A-Z）
- bloodType：血型
- zodiac：星座
- nationality：国籍
- profileSummary：个人简介
- galleryImageUrls：写真图片 URL 数组
- aliases：别名数组
- sourceUrl：资料页来源链接（parseActress 应设为实际解析的资料页 URL，供调试验证打开参考页）`
}

/** Chinese labels for keys returned by parseVideo / dry-run result objects. */
export const VIDEO_PARSE_RESULT_KEY_LABELS: Record<string, string> = {
  code: '番号',
  title: '标题',
  summary: '简介',
  coverUrl: '封面',
  cover: '封面',
  releaseDate: '发行日期',
  maker: '制作商',
  publisher: '发行商',
  series: '系列',
  director: '导演',
  durationSeconds: '时长',
  duration: '时长',
  sourceUrl: '来源链接',
  source: '来源链接',
  ratingAverage: '站点评分',
  ratingCount: '站点评分人数',
  rating: '站点评分',
  sampleImageUrls: '样张',
  samples: '样张',
  actresses: '演员',
  actressesFemale: '女优',
  actressesMale: '男优',
  tags: '标签'
}

/** Chinese labels for keys returned by parseActress / dry-run result objects. */
export const ACTRESS_PARSE_RESULT_KEY_LABELS: Record<string, string> = {
  mainName: '主名',
  nameZh: '中文名',
  nameEn: '英文名',
  avatarUrl: '头像',
  avatar: '头像',
  birthDate: '生日',
  debutDate: '出道日期',
  heightCm: '身高',
  bustCm: '胸围',
  waistCm: '腰围',
  hipCm: '臀围',
  cupSize: '罩杯',
  bloodType: '血型',
  zodiac: '星座',
  nationality: '国籍',
  profileSummary: '资料',
  profile: '资料',
  galleryImageUrls: '写真',
  gallery: '写真',
  aliases: '别名',
  measurements: '三围',
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
