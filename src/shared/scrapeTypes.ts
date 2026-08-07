import type { ActressGender, ActressGenderFilter } from './actressTypes'
import type { ScrapedStatus } from './commonTypes'

export interface ScrapeResult {
  code: string
  title?: string
  summary?: string
  coverUrl?: string
  releaseDate?: string
  maker?: string
  publisher?: string
  series?: string
  director?: string
  durationSeconds?: number
  sourceUrl?: string
  ratingAverage?: number
  ratingCount?: number
  sampleImageUrls?: string[]
  actresses?: ScrapedActress[]
  tags?: string[]
}

export interface ScrapedActress {
  name: string
  avatarUrl?: string
  gender?: ActressGender
}

export interface ActressScrapeResult {
  mainName?: string
  nameZh?: string
  nameEn?: string
  avatarUrl?: string
  birthDate?: string
  debutDate?: string
  heightCm?: number
  bustCm?: number
  waistCm?: number
  hipCm?: number
  cupSize?: string
  bloodType?: string
  zodiac?: string
  nationality?: string
  profileSummary?: string
  galleryImageUrls?: string[]
  aliases?: string[]
  sourceUrl?: string
}

export type VideoScrapeField =
  | 'title' | 'summary' | 'cover' | 'releaseDate' | 'maker' | 'publisher' | 'series'
  | 'director' | 'duration' | 'actressesFemale' | 'actressesMale' | 'tags' | 'source'
  | 'rating' | 'samples'

export const VIDEO_SCRAPE_FIELD_OPTIONS: { id: VideoScrapeField; label: string }[] = [
  { id: 'title', label: '标题' }, { id: 'summary', label: '简介' },
  { id: 'cover', label: '封面' }, { id: 'releaseDate', label: '发行日期' },
  { id: 'maker', label: '制作商' }, { id: 'publisher', label: '发行商' },
  { id: 'series', label: '系列' }, { id: 'director', label: '导演' },
  { id: 'duration', label: '时长' }, { id: 'actressesFemale', label: '女优' },
  { id: 'actressesMale', label: '男优' }, { id: 'tags', label: '标签' },
  { id: 'source', label: '来源链接' }, { id: 'rating', label: '站点评分' },
  { id: 'samples', label: '样张' }
]

export const ALL_VIDEO_SCRAPE_FIELDS = VIDEO_SCRAPE_FIELD_OPTIONS.map((option) => option.id)
export type VideoScrapeUpdateMode = 'replace' | 'fillEmpty' | 'replaceIfPresent'

export interface ScrapeUpdateModeOption<M extends string = VideoScrapeUpdateMode> {
  id: M
  label: string
  description: string
}

export const VIDEO_SCRAPE_UPDATE_MODE_OPTIONS: ScrapeUpdateModeOption<VideoScrapeUpdateMode>[] = [
  { id: 'fillEmpty', label: '空字段补齐', description: '只写入库内尚未填写的字段，已有内容保持不变' },
  { id: 'replaceIfPresent', label: '有值覆盖', description: '已选字段在刮削有结果时更新，无结果则保留原值' },
  { id: 'replace', label: '覆盖更新', description: '已选字段按刮削结果整体替换，无结果则清空' }
]

export type VideoBatchScrapeStatus = ScrapedStatus | 'all'
export const VIDEO_BATCH_SCRAPE_STATUS_OPTIONS: { id: VideoBatchScrapeStatus; label: string }[] = [
  { id: 0, label: '未刮削' }, { id: 1, label: '已刮削成功' },
  { id: 2, label: '刮削失败' }, { id: 'all', label: '库内全部' }
]
export interface VideoBatchScrapeFilter {
  status: VideoBatchScrapeStatus
  videoIds?: number[]
  missingFields?: VideoScrapeField[]
  sourceName?: string
  ratingSourceName?: string
  scraperName?: string
}
export interface VideoBatchScrapeRequest extends VideoBatchScrapeFilter {
  fields: VideoScrapeField[]
  mode?: VideoScrapeUpdateMode
}
export type VideoRematchScope = 'scraped' | 'failed' | 'all'
export const VIDEO_REMATCH_SCOPE_OPTIONS: { id: VideoRematchScope; label: string }[] = [
  { id: 'scraped', label: '已刮削成功' }, { id: 'failed', label: '刮削失败' },
  { id: 'all', label: '库内全部' }
]
export interface VideoRematchBatchRequest {
  scraperName?: string
  fields: VideoScrapeField[]
  scope: VideoRematchScope
  mode?: VideoScrapeUpdateMode
}
export interface VideoScrapeOneResult {
  result: ScrapeResult
  applied: boolean
  warnings: string[]
}

export type ActressScrapeField =
  | 'avatar' | 'gallery' | 'birthDate' | 'nameZh' | 'nameEn' | 'debutDate' | 'heightCm'
  | 'measurements' | 'cupSize' | 'bloodType' | 'zodiac' | 'nationality' | 'profileSummary'
  | 'aliases'
export const ACTRESS_SCRAPE_FIELD_OPTIONS: { id: ActressScrapeField; label: string }[] = [
  { id: 'avatar', label: '头像' }, { id: 'gallery', label: '写真' },
  { id: 'birthDate', label: '生日' }, { id: 'nameZh', label: '中文名' },
  { id: 'nameEn', label: '英文名' }, { id: 'debutDate', label: '出道日期' },
  { id: 'heightCm', label: '身高' }, { id: 'measurements', label: '三围' },
  { id: 'cupSize', label: '罩杯' }, { id: 'bloodType', label: '血型' },
  { id: 'zodiac', label: '星座' }, { id: 'nationality', label: '国籍' },
  { id: 'profileSummary', label: '简介' }, { id: 'aliases', label: '别名' }
]
export const ALL_ACTRESS_SCRAPE_FIELDS = ACTRESS_SCRAPE_FIELD_OPTIONS.map((option) => option.id)
export function expandActressScrapeFields(fields: readonly string[]): ActressScrapeField[] {
  const allowed = new Set(ALL_ACTRESS_SCRAPE_FIELDS)
  return [...new Set(fields)].filter((field): field is ActressScrapeField =>
    allowed.has(field as ActressScrapeField)
  )
}
export const ACTRESS_BATCH_DEFAULT_MISSING_FIELDS: ActressScrapeField[] = [
  'avatar', 'birthDate', 'heightCm', 'measurements'
]
export type ActressBatchScrapeScope = ActressGenderFilter
export type ActressBatchScrapeStatus = 'unscraped' | 'success' | 'failed' | 'all'
export type LegacyActressBatchScrapeStatus = 'scraped'
export const ACTRESS_BATCH_SCRAPE_SCOPE_OPTIONS: { id: ActressBatchScrapeScope; label: string }[] = [
  { id: 'female', label: '女优' }, { id: 'male', label: '男优' }, { id: 'all', label: '全部演员' }
]
export const ACTRESS_BATCH_SCRAPE_STATUS_OPTIONS: { id: ActressBatchScrapeStatus; label: string }[] = [
  { id: 'unscraped', label: '未刮削' }, { id: 'success', label: '刮削成功' },
  { id: 'failed', label: '刮削失败' }, { id: 'all', label: '全部' }
]
export type ActressScrapeUpdateMode = 'replace' | 'fillEmpty' | 'replaceIfPresent'
export type ActressScrapeFieldImpactAction = 'set' | 'clear' | 'append' | 'replace' | 'preserve'
export type ActressScrapeFieldImpactReason =
  | 'replace' | 'fillEmpty' | 'replaceIfPresent' | 'noValue' | 'existingValue' | 'resourceUnavailable'
export interface ActressScrapeFieldImpact {
  field: ActressScrapeField
  part?: 'bustCm' | 'waistCm' | 'hipCm'
  action: ActressScrapeFieldImpactAction
  currentValue: string | number | string[] | null
  nextValue: string | number | string[] | null
  reason: ActressScrapeFieldImpactReason
}

export type ScraperPluginKind = 'video' | 'actress'
export type ScraperPluginSource = 'builtin' | 'user' | 'composite'
export interface ScraperPluginDelay { minMs: number; maxMs: number }
export interface ScraperPluginDelaySettings {
  video: Record<string, ScraperPluginDelay>
  actress: Record<string, ScraperPluginDelay>
}
export interface CompositeScraperDefinition {
  kind: ScraperPluginKind
  name: string
  description?: string
  fieldPluginMap: Partial<Record<VideoScrapeField | ActressScrapeField, string>>
}
export interface ScraperPluginDescriptor {
  kind: ScraperPluginKind
  name: string
  version: string
  description: string
  author?: string
  homepage?: string
  source: ScraperPluginSource
  removable: boolean
  exportable: boolean
  editable?: boolean
  overridesBuiltIn?: boolean
  supportedFields: Array<VideoScrapeField | ActressScrapeField>
  delay?: ScraperPluginDelay
  fieldPluginMap?: Partial<Record<VideoScrapeField | ActressScrapeField, string>>
}
export interface ScraperPluginPackage {
  schemaVersion: 1
  kind: ScraperPluginKind
  name: string
  version?: string
  description?: string
  author?: string
  homepage?: string
  supportedFields?: Array<VideoScrapeField | ActressScrapeField>
  code: string
}
export type ScraperPluginPackageExport = ScraperPluginPackage
export type ScraperPluginPackageImport = ScraperPluginPackage
export interface ScraperPluginUpdateInput {
  version?: string
  description?: string
  author?: string
  homepage?: string
  supportedFields?: Array<VideoScrapeField | ActressScrapeField>
  delay?: ScraperPluginDelay
}
export interface CompositeScraperInput {
  name: string
  description?: string
  fieldPluginMap: Partial<Record<VideoScrapeField | ActressScrapeField, string>>
}
export interface ActressScrapePluginRef {
  name: string
  source: ScraperPluginSource
  version?: string
}
export type ActressScrapeDisposition =
  | { status: 'success'; ok: true; result: ActressScrapeResult; warnings?: string[]; skipped?: boolean; avatarUpdated?: boolean; pendingId?: never; error?: never }
  | { status: 'pending'; ok: true; pendingId: number; result: ActressScrapeResult; warnings?: string[]; skipped?: false; avatarUpdated?: false; error?: never }
  | { status: 'failure'; ok: false; error: string; warnings?: string[]; result?: never; skipped?: false; avatarUpdated?: false; pendingId?: never }
export const ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS: ScrapeUpdateModeOption<ActressScrapeUpdateMode>[] = [
  { id: 'fillEmpty', label: '空字段补齐', description: '只写入库内尚未填写的字段，已有内容保持不变' },
  { id: 'replaceIfPresent', label: '有值覆盖', description: '已选字段在刮削有结果时更新，无结果则保留原值' },
  { id: 'replace', label: '覆盖更新', description: '已选字段按刮削结果整体替换，无结果则清空' }
]
export interface ActressBatchScrapeFilter {
  actressIds?: number[]
  scope: ActressBatchScrapeScope
  scrapeStatus?: ActressBatchScrapeStatus
  missingFields?: ActressScrapeField[]
}
export interface ActressBatchScrapeRequest extends ActressBatchScrapeFilter {
  scraperName?: string
  fields: ActressScrapeField[]
  mode?: ActressScrapeUpdateMode
  useAliases?: boolean
  autoCropAvatar?: boolean
}
export interface ActressAvatarAutoCropTarget { actressId: number; mainName: string }
export type ActressAvatarAutoCropStatus = 'success' | 'skipped' | 'failed'
export interface ActressAvatarAutoCropOutcome { status: ActressAvatarAutoCropStatus; message?: string }
export interface ActressAvatarAutoCropRequest extends ActressAvatarAutoCropTarget { requestId: string }
export interface ActressAvatarAutoCropResponse extends ActressAvatarAutoCropOutcome { requestId: string }
