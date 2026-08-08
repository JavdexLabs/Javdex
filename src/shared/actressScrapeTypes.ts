import {
  ACTRESS_SCRAPE_STATUS_LABELS,
  type ActressGenderFilter,
  type ActressScrapeStatusFilter
} from './actressTypes'
import type { ScrapeUpdateModeOption } from './videoScrapeTypes'

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
export type ActressBatchScrapeStatus = ActressScrapeStatusFilter
export type LegacyActressBatchScrapeStatus = 'scraped'

export const ACTRESS_BATCH_SCRAPE_SCOPE_OPTIONS: { id: ActressBatchScrapeScope; label: string }[] = [
  { id: 'female', label: '女优' }, { id: 'male', label: '男优' }, { id: 'all', label: '全部演员' }
]

/** Concrete status labels come from `ACTRESS_SCRAPE_STATUS_LABELS`; "all" is batch-scoped. */
export const ACTRESS_BATCH_SCRAPE_STATUS_OPTIONS: { id: ActressBatchScrapeStatus; label: string }[] = [
  { id: 'unscraped', label: ACTRESS_SCRAPE_STATUS_LABELS.unscraped },
  { id: 'success', label: ACTRESS_SCRAPE_STATUS_LABELS.success },
  { id: 'failed', label: ACTRESS_SCRAPE_STATUS_LABELS.failed },
  { id: 'all', label: '全部' }
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

export interface ActressScrapePluginRef {
  name: string
  /** Same vocabulary as `ScraperPluginSource` (kept structural to avoid a type cycle). */
  source: 'builtin' | 'user' | 'composite'
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
