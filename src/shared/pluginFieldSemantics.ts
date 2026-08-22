import {
  ALL_ACTRESS_SCRAPE_FIELDS,
  type ActressScrapeField,
  type ActressScrapeResult
} from './actressScrapeTypes'
import type { ScraperPluginKind } from './scraperPluginTypes'
import {
  ALL_VIDEO_SCRAPE_FIELDS,
  type ScrapeResult,
  type VideoScrapeField
} from './videoScrapeTypes'

export const PLUGIN_FIELD_SEMANTICS_VERSION = 2

export type PluginSemanticField = VideoScrapeField | ActressScrapeField
export type PluginFieldValueType =
  | 'text'
  | 'text-list'
  | 'date'
  | 'duration'
  | 'url'
  | 'url-list'
  | 'number'
  | 'rating'
  | 'person-list'
  | 'measurements'

export type PluginFieldNormalization =
  | 'text'
  | 'text-list'
  | 'date'
  | 'duration-seconds'
  | 'url'
  | 'url-list'
  | 'number'
  | 'rating-5'
  | 'person-name-list'
  | 'measurements-cm'

export interface PluginFieldSemanticDefinition {
  kind: ScraperPluginKind
  id: PluginSemanticField
  title: string
  description: string
  valueType: PluginFieldValueType
  resultKeys: string[]
  labels: {
    canonical: string[]
    strong: string[]
    ambiguous: string[]
  }
  linkRoutes: {
    strong: string[]
    supporting: string[]
    conflicting: string[]
  }
  conflictsWith: PluginSemanticField[]
  normalization: PluginFieldNormalization
  absencePolicy: 'optional-per-page' | 'required-when-observed'
}

function video(
  definition: Omit<PluginFieldSemanticDefinition, 'kind' | 'absencePolicy'> & {
    id: VideoScrapeField
    absencePolicy?: PluginFieldSemanticDefinition['absencePolicy']
  }
): PluginFieldSemanticDefinition {
  return { kind: 'video', absencePolicy: 'optional-per-page', ...definition }
}

function actress(
  definition: Omit<PluginFieldSemanticDefinition, 'kind' | 'absencePolicy'> & {
    id: ActressScrapeField
    absencePolicy?: PluginFieldSemanticDefinition['absencePolicy']
  }
): PluginFieldSemanticDefinition {
  return { kind: 'actress', absencePolicy: 'optional-per-page', ...definition }
}

const noLinks = { strong: [], supporting: [], conflicting: [] }

export const VIDEO_FIELD_SEMANTICS: readonly PluginFieldSemanticDefinition[] = [
  video({ id: 'title', title: '标题', description: '作品在详情页展示的正式标题。', valueType: 'text', resultKeys: ['title'], labels: { canonical: ['title', '标题', '標題'], strong: ['name', 'headline', '作品名', '影片标题', '影片標題', 'og:title', 'twitter:title'], ambiguous: [] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'text' }),
  video({ id: 'summary', title: '简介', description: '作品剧情、内容或介绍文本。', valueType: 'text', resultKeys: ['summary'], labels: { canonical: ['summary', 'description', '简介', '簡介'], strong: ['剧情', '劇情', '描述', '作品介绍', '作品介紹', 'og:description', 'twitter:description'], ambiguous: [] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'text' }),
  video({ id: 'cover', title: '封面', description: '作品主封面图片，不是推荐卡片或样张。', valueType: 'url', resultKeys: ['coverUrl'], labels: { canonical: ['cover', '封面'], strong: ['封面图', '封面圖', 'poster', 'og:image', 'twitter:image'], ambiguous: ['image'] }, linkRoutes: noLinks, conflictsWith: ['samples'], normalization: 'url' }),
  video({ id: 'releaseDate', title: '发行日期', description: '页面向用户显示的作品发行日期；可见字段优先于冲突的 metadata。', valueType: 'date', resultKeys: ['releaseDate'], labels: { canonical: ['release date', '发行日期', '發行日期', '発売日'], strong: ['上市日期', '发售日', '發售日', 'og:video:release_date', 'datepublished'], ambiguous: ['date'], }, linkRoutes: noLinks, conflictsWith: [], normalization: 'date' }),
  video({ id: 'maker', title: '制作商', description: '实际制作作品的公司、厂商或工作室，不等同于发行实体。', valueType: 'text', resultKeys: ['maker'], labels: { canonical: ['maker', 'studio', '制作商', '製作商'], strong: ['片商', 'メーカー'], ambiguous: ['厂商', '廠商'] }, linkRoutes: { strong: ['/maker/', '/makers/', '/studio/', '/studios/'], supporting: [], conflicting: ['/publisher/', '/publishers/'] }, conflictsWith: ['publisher'], normalization: 'text' }),
  video({ id: 'publisher', title: '发行商', description: '负责发行、销售作品或作为发行厂牌展示的实体，不等同于制作商。', valueType: 'text', resultKeys: ['publisher'], labels: { canonical: ['publisher', '发行商', '發行商'], strong: ['发行厂牌', '發行廠牌'], ambiguous: ['label', '厂牌', '廠牌'] }, linkRoutes: { strong: ['/publisher/', '/publishers/'], supporting: ['/label/', '/labels/'], conflicting: ['/maker/', '/makers/', '/studio/', '/studios/'] }, conflictsWith: ['maker'], normalization: 'text' }),
  video({ id: 'series', title: '系列', description: '作品所属系列名称。', valueType: 'text', resultKeys: ['series'], labels: { canonical: ['series', '系列'], strong: ['シリーズ'], ambiguous: [] }, linkRoutes: { strong: ['/series/'], supporting: [], conflicting: [] }, conflictsWith: [], normalization: 'text' }),
  video({ id: 'director', title: '导演', description: '作品导演或监督。', valueType: 'text', resultKeys: ['director'], labels: { canonical: ['director', '导演', '導演', '監督'], strong: [], ambiguous: [] }, linkRoutes: { strong: ['/director/', '/directors/'], supporting: [], conflicting: [] }, conflictsWith: [], normalization: 'text' }),
  video({ id: 'duration', title: '时长', description: '作品播放时长，插件结果统一为秒。', valueType: 'duration', resultKeys: ['durationSeconds'], labels: { canonical: ['duration', '时长', '時長'], strong: ['长度', '長度', '収録時間', 'og:video:duration'], ambiguous: ['time'] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'duration-seconds' }),
  video({ id: 'actressesFemale', title: '女优', description: '性别为 female 的出演者，仅投影 actresses 中的女性成员。', valueType: 'person-list', resultKeys: ['actresses'], labels: { canonical: ['actress', 'actresses', '女优', '女優'], strong: ['女性演员', '女性演員', '出演女优', '出演女優'], ambiguous: ['cast', '演员', '演員'] }, linkRoutes: { strong: ['/actress/', '/actresses/'], supporting: ['/star/', '/stars/'], conflicting: ['/actor/', '/actors/'] }, conflictsWith: ['actressesMale'], normalization: 'person-name-list' }),
  video({ id: 'actressesMale', title: '男优', description: '性别为 male 的出演者，仅投影 actresses 中的男性成员。', valueType: 'person-list', resultKeys: ['actresses'], labels: { canonical: ['actor', 'actors', '男优', '男優'], strong: ['男性演员', '男性演員', '出演男优', '出演男優'], ambiguous: ['cast', '演员', '演員'] }, linkRoutes: { strong: ['/actor/', '/actors/'], supporting: [], conflicting: ['/actress/', '/actresses/'] }, conflictsWith: ['actressesFemale'], normalization: 'person-name-list' }),
  video({ id: 'tags', title: '标签', description: '作品类型、题材或内容标签集合。', valueType: 'text-list', resultKeys: ['tags'], labels: { canonical: ['tags', '标签', '標籤'], strong: ['genre', 'genres', '类型', '類型', 'カテゴリ'], ambiguous: ['category'] }, linkRoutes: { strong: ['/genre/', '/genres/', '/tag/', '/tags/'], supporting: ['/category/', '/categories/'], conflicting: [] }, conflictsWith: [], normalization: 'text-list' }),
  video({ id: 'source', title: '来源链接', description: '本次实际解析并与测试番号匹配的详情页 URL。', valueType: 'url', resultKeys: ['sourceUrl'], labels: { canonical: ['source', 'url', '来源', '來源'], strong: ['详情页', '詳情頁', 'og:url'], ambiguous: [] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'url' }),
  video({ id: 'rating', title: '评分', description: '站点评分均值与人数；均值统一换算为 5 分制。', valueType: 'rating', resultKeys: ['ratingAverage', 'ratingCount'], labels: { canonical: ['rating', '评分', '評分'], strong: ['aggregateRating', 'ratingValue', 'score', '星评', '星評'], ambiguous: ['stars'] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'rating-5' }),
  video({ id: 'samples', title: '样张', description: '作品详情页中的样张或截图 URL 集合，不包含主封面。', valueType: 'url-list', resultKeys: ['sampleImageUrls'], labels: { canonical: ['samples', '样张', '樣張'], strong: ['screenshots', '截图', '截圖', 'サンプル画像'], ambiguous: ['gallery'], }, linkRoutes: noLinks, conflictsWith: ['cover'], normalization: 'url-list' })
]

export const ACTRESS_FIELD_SEMANTICS: readonly PluginFieldSemanticDefinition[] = [
  actress({ id: 'avatar', title: '头像', description: '演员资料页主头像。', valueType: 'url', resultKeys: ['avatarUrl'], labels: { canonical: ['avatar', '头像', '頭像'], strong: ['profile photo', '主图', '主圖'], ambiguous: ['photo', 'image'] }, linkRoutes: noLinks, conflictsWith: ['gallery'], normalization: 'url' }),
  actress({ id: 'gallery', title: '写真', description: '演员写真或资料图集 URL。', valueType: 'url-list', resultKeys: ['galleryImageUrls'], labels: { canonical: ['gallery', '写真', '圖集', '图集'], strong: ['photos', '画像'], ambiguous: ['images'] }, linkRoutes: noLinks, conflictsWith: ['avatar'], normalization: 'url-list' }),
  actress({ id: 'birthDate', title: '生日', description: '演员出生日期。', valueType: 'date', resultKeys: ['birthDate'], labels: { canonical: ['birthday', 'birthDate', 'birth date', '生日', '出生'], strong: ['生年月日'], ambiguous: ['年龄', '年齡'] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'date' }),
  actress({ id: 'nameZh', title: '中文名', description: '演员中文名称。', valueType: 'text', resultKeys: ['nameZh'], labels: { canonical: ['中文名', 'chinese name'], strong: ['中文名称', '中文名稱'], ambiguous: [] }, linkRoutes: noLinks, conflictsWith: ['nameEn'], normalization: 'text' }),
  actress({ id: 'nameEn', title: '英文名', description: '演员英文或罗马字名称。', valueType: 'text', resultKeys: ['nameEn'], labels: { canonical: ['英文名', 'english name'], strong: ['romanized name', 'ローマ字'], ambiguous: [] }, linkRoutes: noLinks, conflictsWith: ['nameZh'], normalization: 'text' }),
  actress({ id: 'debutDate', title: '出道日期', description: '演员首次出道日期。', valueType: 'date', resultKeys: ['debutDate'], labels: { canonical: ['debut', 'debut date', '出道', 'デビュー'], strong: ['出道日期', '出道時間'], ambiguous: [] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'date' }),
  actress({ id: 'heightCm', title: '身高', description: '演员身高，单位厘米。', valueType: 'number', resultKeys: ['heightCm'], labels: { canonical: ['height', '身高'], strong: ['身長'], ambiguous: [] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'number' }),
  actress({ id: 'measurements', title: '三围', description: '胸围、腰围、臀围，单位厘米。', valueType: 'measurements', resultKeys: ['bustCm', 'waistCm', 'hipCm'], labels: { canonical: ['measurements', '三围', '三圍'], strong: ['bust', 'waist', 'hip', '胸围', '胸圍', '腰围', '腰圍', '臀围', '臀圍', 'スリーサイズ'], ambiguous: ['size'] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'measurements-cm' }),
  actress({ id: 'cupSize', title: '罩杯', description: '胸罩罩杯字母。', valueType: 'text', resultKeys: ['cupSize'], labels: { canonical: ['cup', 'cup size', '罩杯'], strong: ['カップ'], ambiguous: [] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'text' }),
  actress({ id: 'bloodType', title: '血型', description: '演员血型。', valueType: 'text', resultKeys: ['bloodType'], labels: { canonical: ['blood type', '血型'], strong: ['血液型'], ambiguous: [] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'text' }),
  actress({ id: 'zodiac', title: '星座', description: '演员星座。', valueType: 'text', resultKeys: ['zodiac'], labels: { canonical: ['zodiac', '星座'], strong: [], ambiguous: [] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'text' }),
  actress({ id: 'nationality', title: '国籍', description: '演员国籍或所属国家。', valueType: 'text', resultKeys: ['nationality'], labels: { canonical: ['nationality', '国籍', '國籍'], strong: ['country', '国家', '國家'], ambiguous: [] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'text' }),
  actress({ id: 'profileSummary', title: '简介', description: '演员个人资料简介，不是页面标题。', valueType: 'text', resultKeys: ['profileSummary'], labels: { canonical: ['profile', 'profile summary', '简介', '簡介'], strong: ['description', '资料', '資料', '个人简介', '個人簡介'], ambiguous: ['bio', 'about'] }, linkRoutes: noLinks, conflictsWith: [], normalization: 'text' }),
  actress({ id: 'aliases', title: '别名', description: '演员别名、曾用名或其他名称。', valueType: 'text-list', resultKeys: ['aliases'], labels: { canonical: ['aliases', 'alias', '别名', '別名'], strong: ['alternateName', '曾用名', '其他名称', '其他名稱'], ambiguous: ['also known as'], }, linkRoutes: noLinks, conflictsWith: [], normalization: 'text-list' })
]

export const PLUGIN_FIELD_SEMANTICS: readonly PluginFieldSemanticDefinition[] = [
  ...VIDEO_FIELD_SEMANTICS,
  ...ACTRESS_FIELD_SEMANTICS
]

const BY_KIND = {
  video: new Map(VIDEO_FIELD_SEMANTICS.map((item) => [item.id, item])),
  actress: new Map(ACTRESS_FIELD_SEMANTICS.map((item) => [item.id, item]))
}

export function fieldSemanticsForKind(kind: ScraperPluginKind): readonly PluginFieldSemanticDefinition[] {
  return kind === 'video' ? VIDEO_FIELD_SEMANTICS : ACTRESS_FIELD_SEMANTICS
}

export function fieldSemanticDefinition(
  kind: ScraperPluginKind,
  field: string
): PluginFieldSemanticDefinition | undefined {
  return BY_KIND[kind].get(field as never)
}

export function normalizeSemanticText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\p{White_Space}+/gu, ' ')
    .toLocaleLowerCase()
}

export function normalizeSemanticLabel(value: unknown): string {
  return normalizeSemanticText(value).replace(/[：:]$/, '').trim()
}

export function projectPluginResultField(
  kind: ScraperPluginKind,
  field: PluginSemanticField,
  result: Record<string, unknown>
): unknown {
  if (kind === 'video') {
    const videoField = field as VideoScrapeField
    if (videoField === 'actressesFemale' || videoField === 'actressesMale') {
      const gender = videoField === 'actressesFemale' ? 'female' : 'male'
      return Array.isArray(result.actresses)
        ? result.actresses.filter((item) =>
            Boolean(item) && typeof item === 'object' &&
            ((item as { gender?: unknown }).gender ?? 'female') === gender
          )
        : []
    }
    if (videoField === 'rating') {
      return result.ratingAverage == null && result.ratingCount == null
        ? undefined
        : { average: result.ratingAverage, count: result.ratingCount }
    }
  }
  if (kind === 'actress' && field === 'measurements') {
    const values = {
      bustCm: result.bustCm,
      waistCm: result.waistCm,
      hipCm: result.hipCm
    }
    return Object.values(values).every((value) => value == null) ? undefined : values
  }
  const definition = fieldSemanticDefinition(kind, field)
  if (!definition) return result[field]
  const values = definition.resultKeys
    .map((key) => result[key])
    .filter((value) => value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0))
  return values.length <= 1 ? values[0] : values
}

export function assertCompleteFieldSemantics(): void {
  const videoIds = new Set(VIDEO_FIELD_SEMANTICS.map((item) => item.id))
  const actressIds = new Set(ACTRESS_FIELD_SEMANTICS.map((item) => item.id))
  for (const field of ALL_VIDEO_SCRAPE_FIELDS) {
    if (!videoIds.has(field)) throw new Error(`缺少影片字段语义定义：${field}`)
  }
  for (const field of ALL_ACTRESS_SCRAPE_FIELDS) {
    if (!actressIds.has(field)) throw new Error(`缺少演员字段语义定义：${field}`)
  }
}

export type PluginSemanticResult = ScrapeResult | ActressScrapeResult
