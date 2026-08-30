import type { ActressGender } from './actressTypes'
import type { ScrapedStatus } from './commonTypes'

export type VideoClassificationField = 'maker' | 'publisher' | 'series' | 'director'

export interface VideoClassificationCandidate {
  id: number
  mainName: string
  aliases: string[]
  description: string | null
}

export type VideoClassificationResolutionStatus =
  | 'matched'
  | 'create'
  | 'created'
  | 'cleared'
  | 'preserved'
  | 'ambiguous'
  | 'invalid'

export interface VideoClassificationResolutionOutcome {
  field: VideoClassificationField
  status: VideoClassificationResolutionStatus
  inputName: string | null
  entityId: number | null
  candidates?: VideoClassificationCandidate[]
  message?: string
}

export interface VideoDirectorChoiceRequired {
  scrapedName: string
  candidates: VideoClassificationCandidate[]
}

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

export type VideoPluginScrapeResult = ScrapeResult | ScrapeResult[] | null

export interface PendingVideoScrapeCandidate {
  id: number
  position: number
  result: ScrapeResult
  sourceUrl: string | null
  stagedCoverPath: string | null
  stagedSamplePaths: Array<string | null>
  stagedActressAvatarPaths: Array<string | null>
}

export interface PendingVideoScrapeSource {
  id: number
  position: number
  pluginName: string
  pluginSource: 'builtin' | 'user' | 'composite'
  pluginVersion: string | null
  sourceName: string
  selectedFields: VideoScrapeField[]
  selectedCandidateId: number | null
  candidates: PendingVideoScrapeCandidate[]
}

export interface PendingVideoScrape {
  id: number
  videoId: number
  revision: number
  selectedFields: VideoScrapeField[]
  applicableFields: VideoScrapeField[]
  updateMode: VideoScrapeUpdateMode
  warnings: string[]
  createdAt: string
  updatedAt: string
  sources: PendingVideoScrapeSource[]
  stagedBytes: number
}

export interface PendingVideoScrapeResolutionResult {
  status: 'applied' | 'skipped' | 'merge-required'
  applied: boolean
  conflictVideoId?: number
  warnings: string[]
  directorChoice?: VideoDirectorChoiceRequired
}

export interface PendingVideoScrapeSelection {
  sourceId: number
  candidateId: number
}

export interface PendingVideoScrapeConfirmInput {
  pendingScrapeId: number
  selections: PendingVideoScrapeSelection[]
  directorSelectionId?: number
  /** Explicitly retained video for the conflict-only merge-and-apply flow. */
  mergeRetainedVideoId?: number
}

export interface ScrapedActress {
  name: string
  avatarUrl?: string
  gender?: ActressGender
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
  { id: 2, label: '刮削失败' }, { id: 'all', label: '全部影片' }
]
export interface VideoBatchScrapeFilter {
  /**
   * Limits targets to visible memberships in one active media library.
   * Omission is the legacy/global-catalog compatibility mode used by Settings and old callers.
   */
  libraryId?: number
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
  { id: 'all', label: '全部影片' }
]
export interface VideoRematchBatchRequest {
  scraperName?: string
  fields: VideoScrapeField[]
  scope: VideoRematchScope
  mode?: VideoScrapeUpdateMode
}
export interface VideoScrapeOneResult {
  result?: ScrapeResult
  applied: boolean
  pending?: boolean
  pendingScrapeId?: number
  warnings: string[]
  classifications: VideoClassificationResolutionOutcome[]
  directorChoice?: VideoDirectorChoiceRequired
}
