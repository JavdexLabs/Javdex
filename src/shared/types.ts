// Shared domain types used across main / preload / renderer processes.

export type ScrapedStatus = 0 | 1 | 2 // 0-未刮削, 1-刮削成功, 2-刮削失败

export interface VideoFile {
  id: number
  video_id: number
  file_path: string
  file_size: number | null
  file_duration_seconds: number | null
  file_mtime_ms: number | null
  label: string | null
  is_primary: number
  add_time: string
}

export interface Video {
  id: number
  code: string
  title: string | null
  summary: string | null
  cover_path: string | null
  poster_path: string | null
  original_title: string | null
  rating: number
  release_date: string | null
  maker: string | null
  publisher: string | null
  series: string | null
  director: string | null
  duration_seconds: number | null
  scraped_status: ScrapedStatus
  last_scraped_at: string | null
  updated_at: string | null
  add_time: string
  /** Joined for list/detail UI; not stored on videos. */
  primary_file_path?: string | null
  file_count?: number
}

export type ActressGender = 'female' | 'male'
export type ActressGenderFilter = ActressGender | 'all'

export type ActressListSortBy = 'video_count' | 'gallery' | 'age' | 'cup_size'
export type ListSortDir = 'asc' | 'desc'

export const ACTRESS_LIST_DEFAULTS = {
  sortBy: 'video_count' as ActressListSortBy,
  sortDir: 'desc' as ListSortDir,
  gender: 'female' as ActressGenderFilter
}

export interface Actress {
  id: number
  main_name: string
  avatar_path: string | null
  avatar_source_path: string | null
  avatar_crop_json: string | null
  poster_path: string | null
  birth_date: string | null
  debut_date: string | null
  height_cm: number | null
  bust_cm: number | null
  waist_cm: number | null
  hip_cm: number | null
  /** Single cup letter (A–Z); display suffix added in UI. */
  cup_size: string | null
  blood_type: string | null
  zodiac: string | null
  nationality: string | null
  profile_summary: string | null
  last_scraped_at: string | null
  updated_at: string | null
  gender: ActressGender | null
}

export interface Tag {
  id: number
  name: string
}

export type TagOrigin = 'manual' | 'scraped'

export interface VideoTag extends Tag {
  origin: TagOrigin
  source: string | null
}

export interface ActressName {
  id: number
  actress_id: number
  name: string
  type: 'main' | 'alias' | 'former' | 'native' | 'romaji' | 'english' | 'zh' | string
  locale: string | null
  source: string | null
  is_primary: number
}

export interface VideoAsset {
  id: number
  video_id: number
  type: 'cover' | 'poster' | 'sample' | string
  position: number
  remote_url: string | null
  local_path: string | null
  width: number | null
  height: number | null
  is_primary: number
  created_at: string | null
}

export interface VideoExternalStats {
  id: number
  video_id: number
  source: string
  rating_average: number | null
  rating_count: number | null
  fetched_at: string | null
}

export interface VideoSampleImportInput {
  source: 'file' | 'url'
  /** Absolute local image path, supplied by Electron webUtils.getPathForFile. */
  sourcePath?: string | null
  remoteUrl?: string | null
}

export interface ActressGalleryAsset {
  id: number
  actress_id: number
  type: 'profile' | 'gallery' | string
  position: number
  remote_url: string | null
  local_path: string | null
  width: number | null
  height: number | null
  created_at: string | null
}

export interface ActressGalleryImportInput {
  source: 'file' | 'url'
  /** Absolute local image path, supplied by Electron webUtils.getPathForFile. */
  sourcePath?: string | null
  remoteUrl?: string | null
}

/** A video enriched with its related actresses and tags (for detail views). */
export interface VideoDetail extends Video {
  files: VideoFile[]
  actresses: Actress[]
  tags: VideoTag[]
  assets: VideoAsset[]
  external_stats: VideoExternalStats[]
  /** Resolved for detail UI: scraped duration, else primary file duration. */
  resolved_duration_seconds?: number | null
}

export interface Playlist {
  id: number
  name: string
  description: string | null
  cover_path: string | null
  created_at: string
  updated_at: string | null
}

export interface PlaylistListItem extends Playlist {
  video_count: number
  preview_cover_path: string | null
}

export interface PlaylistDetail extends Playlist {
  videos: Video[]
}

export type PlaylistVideoSortBy = 'added_at' | 'release_date'
export type PlaylistVideoSortDir = 'asc' | 'desc'

export interface PlaylistVideoMembership extends PlaylistListItem {
  contains_video: boolean
}

export interface PlaylistCreateInput {
  name: string
  description?: string | null
  /** Absolute path to a local image file to import as playlist cover. */
  coverSourcePath?: string | null
}

export interface PlaylistUpdateInput extends PlaylistCreateInput {
  /** Remove the custom playlist cover and fall back to the first video cover. */
  removeCover?: boolean
}

export interface ActressDetail extends Actress {
  name_zh: string | null
  name_en: string | null
  aliases: string[]
  names: ActressName[]
  gallery: ActressGalleryAsset[]
  videos: Video[]
}

export interface ActressListItem extends Actress {
  video_count: number
}

/** Which actress supplies the surviving main_name after a merge. */
export type ActressMergeMainNameFrom = 'keep' | 'merge'

export interface ActressMergeInput {
  keepId: number
  mergeId: number
  mainNameFrom: ActressMergeMainNameFrom
}

/** Payload for manual actress profile editing. Aliases, when present, fully replace existing. */
export type { ActressAvatarCommit, AvatarCropV1 } from './avatarCrop'

export interface ActressEditInput {
  main_name?: string
  name_zh?: string | null
  name_en?: string | null
  gender?: ActressGender | null
  birth_date?: string | null
  debut_date?: string | null
  height_cm?: number | null
  bust_cm?: number | null
  waist_cm?: number | null
  hip_cm?: number | null
  cup_size?: string | null
  blood_type?: string | null
  zodiac?: string | null
  nationality?: string | null
  profile_summary?: string | null
  aliases?: string[]
  /** Absolute path to a local image file to import as avatar. */
  avatarSourcePath?: string
  /** JPEG avatar bytes (base64) exported from the crop editor. */
  avatarImageBase64?: string
  /** Preferred avatar bundle commit (source + display + crop). */
  avatar?: import('./avatarCrop').ActressAvatarCommit
  /** Clear display/source/crop together. */
  clearAvatar?: boolean
}

/** Result returned by a scraper plugin after parsing a remote page. */
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
  /** From site cast markers (e.g. JavDB ♀/♂); omitted when unknown. */
  gender?: ActressGender
}

/** Result returned by an actress-profile scraper plugin. */
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
  /** Profile page URL used for scraping; used by plugin dev verify to open the correct reference page. */
  sourceUrl?: string
}

export type ScraperPluginKind = 'video' | 'actress'
export type ScraperPluginSource = 'builtin' | 'user' | 'composite'

export interface ScraperPluginDelay {
  minMs: number
  maxMs: number
}

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

/** Plugin package JSON written to disk on export. */
export type ScraperPluginPackageExport = ScraperPluginPackage

/** Plugin package JSON accepted on import. */
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

export type {
  BuiltInLlmProviderDefinition,
  CustomLlmProviderDefinition,
  LlmCustomModelDefinition,
  LlmModelDefinition,
  LlmProviderProtocol,
  LlmProviderStatus,
  LlmProviderUserConfig,
  LlmProviderViewModel,
  LlmSettingsSlice
} from './llmProviders'

export {
  BUILT_IN_LLM_PROVIDERS,
  LLM_PROVIDER_PROTOCOL_OPTIONS,
  buildLlmProviderViewModels,
  findLlmProviderViewModel,
  isReservedLlmProviderId,
  isValidCustomLlmProviderId,
  listAgentCompatibleProviders,
  listModelsForProvider,
  maskLlmApiKey,
  normalizeCustomLlmProviderId,
  normalizeDefaultLlmSelection
} from './llmProviders'

export interface PluginDevAgentInput {
  kind: ScraperPluginKind
  siteName: string
  siteUrl?: string
  description?: string
  supportedFields: Array<VideoScrapeField | ActressScrapeField>
  /** Unified test targets (video codes or actress names). */
  testTargets?: string[]
}

export type PluginDevAgentMode = 'create' | 'debug' | 'feedback'

export type PluginDevSessionStatus =
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type PluginDevAgentPhase =
  | 'idle'
  | 'discover'
  | 'implement'
  | 'dry_run'
  | 'verify'
  | 'finish'
  | 'waiting_user'

export interface PluginDevAgentContextStats {
  messageCount: number
  originalChars: number
  compressedChars: number
  savedChars: number
  estimatedTokens: number
  totalTokens: number
  maxTokens: number
  overBudget: boolean
}

export interface PluginDevAgentStartInput extends PluginDevAgentInput {
  mode: PluginDevAgentMode
  userMessage?: string
  package?: ScraperPluginPackage
  /** Prior manual or UI dry-run to seed the session context. */
  lastDryRun?: PluginDevDryRunResult
  /** Test override; production uses settings.pluginDevAgentMaxSteps. */
  maxSteps?: number
  /** Test override; production uses settings.pluginDevAgentMaxContextTokens. */
  maxContextTokens?: number
}

export interface PluginDevAgentMessageInput {
  sessionId: string
  text: string
  /** Latest dry-run from UI to refresh session context when continuing. */
  lastDryRun?: PluginDevDryRunResult
}

export type PluginDevAgentEvent =
  | { type: 'step_start'; sessionId: string; step: number }
  | { type: 'phase_updated'; sessionId: string; step: number; phase: PluginDevAgentPhase }
  | {
      type: 'context_updated'
      sessionId: string
      step: number
      stats: PluginDevAgentContextStats
    }
  | { type: 'assistant_text'; sessionId: string; step: number; text: string }
  | {
      type: 'tool_start'
      sessionId: string
      step: number
      tool: string
      args: Record<string, unknown>
    }
  | {
      type: 'tool_result'
      sessionId: string
      step: number
      tool: string
      ok: boolean
      summary: string
      detail?: string
    }
  | {
      type: 'package_updated'
      sessionId: string
      step: number
      package: ScraperPluginPackage
    }
  | {
      type: 'plugin_installed'
      sessionId: string
      step: number
      package: ScraperPluginPackage
      descriptor: ScraperPluginDescriptor
    }
  | {
      type: 'dry_run_updated'
      sessionId: string
      step: number
      dryRun: PluginDevDryRunResult
    }
  | {
      type: 'verification_updated'
      sessionId: string
      step: number
      verification: PluginDevVerificationReport
    }
  | { type: 'waiting_user'; sessionId: string; step: number; reason: string }
  | {
      type: 'done'
      sessionId: string
      step: number
      success: boolean
      summary: string
      package: ScraperPluginPackage
      dryRun?: PluginDevDryRunResult
      verification?: PluginDevVerificationReport
    }
  | { type: 'error'; sessionId: string; step: number; message: string }

export interface PluginDevAgentSessionResult {
  sessionId: string
  status: PluginDevSessionStatus
  package: ScraperPluginPackage
  dryRun?: PluginDevDryRunResult
  verification?: PluginDevVerificationReport
  summary: string
}

export interface PluginDevPageInsight {
  label: string
  url: string
  title: string
  text: string
  forms: Array<{
    selector: string
    action?: string
    method?: string
    inputs: Array<{
      selector: string
      name?: string
      type?: string
      placeholder?: string
      value?: string
    }>
    buttons: Array<{
      selector: string
      text: string
      type?: string
    }>
  }>
  links: Array<{
    text: string
    href: string
    region?: 'breadcrumb' | 'metadata' | 'other'
    parentSelector?: string
  }>
  domRegions?: Array<{
    label: string
    selector: string
    html: string
  }>
  definitionLists?: Array<{
    selector: string
    items: Array<{
      term: string
      value: string
      valueHtml?: string
    }>
  }>
}

export interface PluginDevDiscovery {
  pages: PluginDevPageInsight[]
  notes: string[]
}

export type PluginDevVerificationStatus =
  | 'ok'
  | 'missing_in_result'
  | 'not_on_page'
  | 'suspicious'
  | 'invalid_key'

export interface PluginDevFieldVerification {
  field: string
  status: PluginDevVerificationStatus
  actual?: string
  pageHint?: string
  note: string
}

export interface PluginDevVerificationReport {
  referencePage?: PluginDevPageInsight
  items: PluginDevFieldVerification[]
  summary: string
}

export interface PluginDevVerifyInput {
  kind: ScraperPluginKind
  lastResult?: unknown
  discovery?: PluginDevDiscovery
  supportedFields: Array<VideoScrapeField | ActressScrapeField>
  userFeedback?: string
  /** Agent mode; affects verify prompt and post-verify supportedFields sync behavior. */
  mode?: PluginDevAgentMode
  /** Target under verification (single case). */
  testTarget?: string
  testTargets?: string[]
}

export interface PluginDevDryRunInput {
  package: ScraperPluginPackage
  /** Primary target for this dry-run invocation. */
  testTarget?: string
  testTargets?: string[]
}

export interface PluginDevDryRunCase {
  target: string
  ok: boolean
  result: ScrapeResult | ActressScrapeResult | null
  logs: string[]
  error?: string
}

export interface PluginDevDryRunResult {
  ok: boolean
  result: ScrapeResult | ActressScrapeResult | null
  logs: string[]
  error?: string
  /** Present when one Agent dry-run covered multiple test targets. */
  cases?: PluginDevDryRunCase[]
}

export interface PluginDevInstallInput {
  package: ScraperPluginPackage
  overwriteUser?: boolean
}

/** Selectable fields when manually re-scraping a video. */
export type VideoScrapeField =
  | 'title'
  | 'summary'
  | 'cover'
  | 'releaseDate'
  | 'maker'
  | 'publisher'
  | 'series'
  | 'director'
  | 'duration'
  | 'actressesFemale'
  | 'actressesMale'
  | 'tags'
  | 'source'
  | 'rating'
  | 'samples'

export const VIDEO_SCRAPE_FIELD_OPTIONS: { id: VideoScrapeField; label: string }[] = [
  { id: 'title', label: '标题' },
  { id: 'summary', label: '简介' },
  { id: 'cover', label: '封面' },
  { id: 'releaseDate', label: '发行日期' },
  { id: 'maker', label: '制作商' },
  { id: 'publisher', label: '发行商' },
  { id: 'series', label: '系列' },
  { id: 'director', label: '导演' },
  { id: 'duration', label: '时长' },
  { id: 'actressesFemale', label: '女优' },
  { id: 'actressesMale', label: '男优' },
  { id: 'tags', label: '标签' },
  { id: 'source', label: '来源链接' },
  { id: 'rating', label: '站点评分' },
  { id: 'samples', label: '样张' }
]

export const ALL_VIDEO_SCRAPE_FIELDS: VideoScrapeField[] = VIDEO_SCRAPE_FIELD_OPTIONS.map((o) => o.id)

/** How rematch applies selected fields to existing video metadata. */
export type VideoScrapeUpdateMode = 'replace' | 'fillEmpty' | 'replaceIfPresent'

export interface ScrapeUpdateModeOption<M extends string = VideoScrapeUpdateMode> {
  id: M
  label: string
  description: string
}

export const VIDEO_SCRAPE_UPDATE_MODE_OPTIONS: ScrapeUpdateModeOption<VideoScrapeUpdateMode>[] = [
  {
    id: 'fillEmpty',
    label: '空字段补齐',
    description: '只写入库内尚未填写的字段，已有内容保持不变'
  },
  {
    id: 'replaceIfPresent',
    label: '有值覆盖',
    description: '已选字段在刮削有结果时更新，无结果则保留原值'
  },
  {
    id: 'replace',
    label: '覆盖更新',
    description: '已选字段按刮削结果整体替换，无结果则清空'
  }
]

/** Which videos to include in a unified batch scrape/update run. */
export type VideoBatchScrapeStatus = ScrapedStatus | 'all'

export const VIDEO_BATCH_SCRAPE_STATUS_OPTIONS: {
  id: VideoBatchScrapeStatus
  label: string
}[] = [
  { id: 0, label: '未刮削' },
  { id: 1, label: '已刮削成功' },
  { id: 2, label: '刮削失败' },
  { id: 'all', label: '库内全部' }
]

export interface VideoBatchScrapeFilter {
  /** Filter by current scrape status. */
  status: VideoBatchScrapeStatus
  /** Optional explicit target videos, used by library multi-select actions. */
  videoIds?: number[]
  /** Optional range filter: include videos missing any selected metadata field. */
  missingFields?: VideoScrapeField[]
}

export interface VideoBatchScrapeRequest extends VideoBatchScrapeFilter {
  scraperName?: string
  fields: VideoScrapeField[]
  /** Default: replace — only write into empty fields when fillEmpty. */
  mode?: VideoScrapeUpdateMode
}

/** Which videos to include in a batch metadata rematch run. */
export type VideoRematchScope = 'scraped' | 'failed' | 'all'

export const VIDEO_REMATCH_SCOPE_OPTIONS: { id: VideoRematchScope; label: string }[] = [
  { id: 'scraped', label: '已刮削成功' },
  { id: 'failed', label: '刮削失败' },
  { id: 'all', label: '库内全部' }
]

export interface VideoRematchBatchRequest {
  scraperName?: string
  fields: VideoScrapeField[]
  scope: VideoRematchScope
  /** Default: replace — only write into empty fields when fillEmpty. */
  mode?: VideoScrapeUpdateMode
}

export interface VideoScrapeOneResult {
  result: ScrapeResult
  /** False when fillEmpty mode had nothing empty to update. */
  applied: boolean
}

/** Selectable fields when manually re-scraping an actress profile. */
export type ActressScrapeField =
  | 'avatar'
  | 'gallery'
  | 'birthDate'
  | 'nameZh'
  | 'nameEn'
  | 'debutDate'
  | 'heightCm'
  | 'measurements'
  | 'cupSize'
  | 'bloodType'
  | 'zodiac'
  | 'nationality'
  | 'profileSummary'
  | 'aliases'

export const ACTRESS_SCRAPE_FIELD_OPTIONS: { id: ActressScrapeField; label: string }[] = [
  { id: 'avatar', label: '头像' },
  { id: 'gallery', label: '写真' },
  { id: 'birthDate', label: '生日' },
  { id: 'nameZh', label: '中文名' },
  { id: 'nameEn', label: '英文名' },
  { id: 'debutDate', label: '出道日期' },
  { id: 'heightCm', label: '身高' },
  { id: 'measurements', label: '三围' },
  { id: 'cupSize', label: '罩杯' },
  { id: 'bloodType', label: '血型' },
  { id: 'zodiac', label: '星座' },
  { id: 'nationality', label: '国籍' },
  { id: 'profileSummary', label: '简介' },
  { id: 'aliases', label: '别名' }
]

export const ALL_ACTRESS_SCRAPE_FIELDS: ActressScrapeField[] = ACTRESS_SCRAPE_FIELD_OPTIONS.map(
  (o) => o.id
)

/** Keep only canonical actress scrape field ids. */
export function expandActressScrapeFields(fields: readonly string[]): ActressScrapeField[] {
  const allowed = new Set(ALL_ACTRESS_SCRAPE_FIELDS)
  const out: ActressScrapeField[] = []
  const seen = new Set<string>()
  for (const field of fields) {
    if (!allowed.has(field as ActressScrapeField) || seen.has(field)) continue
    seen.add(field)
    out.push(field as ActressScrapeField)
  }
  return out
}

/** Default missing-field filter for actress batch profile scrape. */
export const ACTRESS_BATCH_DEFAULT_MISSING_FIELDS: ActressScrapeField[] = [
  'avatar',
  'birthDate',
  'heightCm',
  'measurements'
]

export type ActressBatchScrapeScope = ActressGenderFilter

export type ActressBatchScrapeStatus = 'unscraped' | 'scraped' | 'all'

export const ACTRESS_BATCH_SCRAPE_SCOPE_OPTIONS: {
  id: ActressBatchScrapeScope
  label: string
}[] = [
  { id: 'female', label: '女优' },
  { id: 'male', label: '男优' },
  { id: 'all', label: '全部演员' }
]

export const ACTRESS_BATCH_SCRAPE_STATUS_OPTIONS: {
  id: ActressBatchScrapeStatus
  label: string
}[] = [
  { id: 'unscraped', label: '从未刮削' },
  { id: 'scraped', label: '已刮削' },
  { id: 'all', label: '全部' }
]

export type ActressScrapeUpdateMode = 'replace' | 'fillEmpty' | 'replaceIfPresent'

export const ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS: ScrapeUpdateModeOption<ActressScrapeUpdateMode>[] = [
  {
    id: 'fillEmpty',
    label: '空字段补齐',
    description: '只写入库内尚未填写的字段，已有内容保持不变'
  },
  {
    id: 'replaceIfPresent',
    label: '有值覆盖',
    description: '已选字段在刮削有结果时更新，无结果则保留原值'
  },
  {
    id: 'replace',
    label: '覆盖更新',
    description: '已选字段按刮削结果整体替换，无结果则清空'
  }
]

export interface ActressBatchScrapeFilter {
  /** Filter by actor gender. Unknown gender is treated as female for compatibility. */
  scope: ActressBatchScrapeScope
  /** Filter by profile scrape history. Default: all. */
  scrapeStatus?: ActressBatchScrapeStatus
  /** Optional range filter: include actresses missing any selected profile field. */
  missingFields?: ActressScrapeField[]
}

export interface ActressBatchScrapeRequest extends ActressBatchScrapeFilter {
  scraperName?: string
  fields: ActressScrapeField[]
  mode?: ActressScrapeUpdateMode
  /** When true, scrapers also try stored aliases / zh / en names. Default false. */
  useAliases?: boolean
}

/** UI color theme id (maps to CSS variables on html[data-theme]). */
export type ThemeId = 'graphite' | 'warm' | 'slate' | 'light'

const VALID_THEMES: ThemeId[] = ['graphite', 'warm', 'slate', 'light']

export function normalizeTheme(value: unknown): ThemeId {
  return VALID_THEMES.includes(value as ThemeId) ? (value as ThemeId) : 'graphite'
}

export interface AppSettings {
  /** Folders to scan for media files. */
  libraryPaths: string[]
  /** Minimum local file duration (minutes) required for scan import; 0 disables the filter. */
  minScanImportDurationMinutes: number
  /** Optional HTTP/HTTPS proxy for scraping, e.g. http://127.0.0.1:7890 */
  proxyUrl: string
  /** When false, scrape requests use a direct connection even if proxyUrl is set. */
  proxyUrlEnabled: boolean
  /** Optional HTTP/HTTPS proxy for LLM API requests. */
  llmProxyUrl: string
  /** When false, LLM requests use a direct connection even if llmProxyUrl is set. */
  llmProxyUrlEnabled: boolean
  /** Default video metadata scraper plugin name. */
  defaultScraper: string
  /** Default actress profile scraper plugin name. */
  defaultActressScraper: string
  /** Min/max delay (ms) between batch scrape tasks to avoid anti-crawling. */
  batchDelayMinMs: number
  batchDelayMaxMs: number
  /** Interface color theme. */
  theme: ThemeId
  /** Display-only: use first local sample as video detail background when no poster is set. */
  videoDetailUseFirstSampleBackground: boolean
  /** Display-only: use first local gallery photo as actress detail background when no poster is set. */
  actressDetailUseFirstGalleryBackground: boolean
  /** Encrypt cover/avatar files on disk as .enc blobs. */
  assetEncryption: boolean
  /** Custom folder for cover/avatar storage; empty uses default userData/media_assets. */
  mediaAssetsPath: string
  /** Resolved absolute media assets path; populated by settings:get only. */
  mediaAssetsResolvedPath?: string
  /** Per scraper random interval ranges used by batch scraping. */
  scraperPluginDelays: ScraperPluginDelaySettings
  /** Field-level virtual scraper definitions. */
  compositeScrapers: {
    video: CompositeScraperDefinition[]
    actress: CompositeScraperDefinition[]
  }
  /** Default LLM provider id for agent and verification flows. */
  defaultLlmProviderId: string
  /** Default model id under {@link defaultLlmProviderId}. */
  defaultLlmModelId: string
  /** Per-provider API key and optional base URL overrides. */
  llmProviderConfigs: Record<string, import('./llmProviders').LlmProviderUserConfig>
  /** User-defined LLM providers. */
  customLlmProviders: import('./llmProviders').CustomLlmProviderDefinition[]
  /** User-added models keyed by provider id. */
  llmCustomModels: import('./llmProviders').LlmCustomModelDefinition[]
  /** Max agent ReAct steps; 0 means unlimited. */
  pluginDevAgentMaxSteps: number
  /** Max estimated input context tokens for plugin development agent. */
  pluginDevAgentMaxContextTokens: number
}

export function normalizeMinScanImportDurationMinutes(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SETTINGS.minScanImportDurationMinutes
  return Math.min(600, Math.round(parsed))
}

export function normalizePluginDevAgentMaxSteps(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : 0
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.min(500, Math.round(parsed))
}

export function normalizePluginDevAgentMaxContextTokens(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : 128000
  if (!Number.isFinite(parsed) || parsed <= 0) return 128000
  return Math.min(512000, Math.max(8000, Math.round(parsed)))
}

export const DEFAULT_SETTINGS: AppSettings = {
  libraryPaths: [],
  minScanImportDurationMinutes: 30,
  proxyUrl: '',
  proxyUrlEnabled: false,
  llmProxyUrl: '',
  llmProxyUrlEnabled: false,
  defaultScraper: 'JavDB',
  defaultActressScraper: 'Xslist',
  batchDelayMinMs: 3000,
  batchDelayMaxMs: 5000,
  theme: 'graphite',
  videoDetailUseFirstSampleBackground: false,
  actressDetailUseFirstGalleryBackground: true,
  assetEncryption: false,
  mediaAssetsPath: '',
  scraperPluginDelays: {
    video: {},
    actress: {}
  },
  compositeScrapers: {
    video: [],
    actress: []
  },
  defaultLlmProviderId: '',
  defaultLlmModelId: '',
  llmProviderConfigs: {},
  customLlmProviders: [],
  llmCustomModels: [],
  pluginDevAgentMaxSteps: 0,
  pluginDevAgentMaxContextTokens: 128000
}

export function resolveScrapeProxyUrl(
  settings: Pick<AppSettings, 'proxyUrl' | 'proxyUrlEnabled'>
): string {
  return settings.proxyUrlEnabled && settings.proxyUrl.trim() ? settings.proxyUrl.trim() : ''
}

export function resolveLlmProxyUrl(
  settings: Pick<AppSettings, 'llmProxyUrl' | 'llmProxyUrlEnabled'>
): string {
  return settings.llmProxyUrlEnabled && settings.llmProxyUrl.trim() ? settings.llmProxyUrl.trim() : ''
}

// ---- Query / filter parameters ----

export interface VideoQuery {
  search?: string
  scrapedStatus?: ScrapedStatus | 'all'
  minRating?: number
  year?: number | 'all'
  actressId?: number
  tagId?: number
  /** Multi-tag filter (video must contain ALL of these tags). */
  tagIds?: number[]
  maker?: string
  publisher?: string
  series?: string
  director?: string
  /** Filter by code label prefix, e.g. MUKD matches MUKD-501. */
  codePrefix?: string
  sortBy?: 'add_time' | 'release_date' | 'rating' | 'code'
  sortDir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/** Payload for manual metadata editing. Provided keys are applied; scraped tags and
 * actresses, when present, fully replace the existing relations for that origin. */
export interface VideoEditInput {
  title?: string | null
  summary?: string | null
  release_date?: string | null
  maker?: string | null
  publisher?: string | null
  series?: string | null
  director?: string | null
  duration_seconds?: number | null
  rating?: number
  /** Scraped tags only; custom tags are edited on the detail page. */
  tags?: string[]
  /** Female cast; when present, replaces female-linked cast for this video. */
  actressesFemale?: string[]
  /** Male cast; when present, replaces male-linked cast for this video. */
  actressesMale?: string[]
  /** Absolute path to a local image file to import as cover. */
  coverSourcePath?: string
}

/** Free-text metadata dimensions backed by a column on `videos`. */
export type FacetType = 'maker' | 'publisher' | 'series' | 'director'

export interface FacetItem {
  value: string
  video_count: number
  /** A representative cover for the list thumbnail. */
  cover_path: string | null
}

export interface VideoListResult {
  items: Video[]
  total: number
}

/** Aggregate counts for the settings overview dashboard. */
export interface LibraryOverviewStats {
  videos: {
    total: number
    scraped: number
    unscraped: number
    failed: number
  }
  actresses: {
    total: number
    female: number
    male: number
    /** Female performers with a scrape timestamp. */
    scraped: number
    /** Female performers without a scrape timestamp. */
    unscraped: number
  }
  playlists: number
  tags: number
  galleryAssets: number
  facets: {
    directors: number
    makers: number
    publishers: number
    series: number
  }
}

// ---- Scan results ----

export interface ScanResult {
  scannedFiles: number
  imported: number
  skipped: number
  /** Files skipped because local duration is below the scan import threshold. */
  skippedShort: number
  failed: number
  cancelled?: boolean
  /** Videos whose file was moved/renamed but code matched — metadata kept, path updated. */
  relocated: number
  /** Videos removed: path outside library folders, or file missing under a library folder. */
  removed: number
  newCodes: string[]
  /** Absolute paths of files whose 番号 could not be parsed from the filename. */
  unrecognizedFiles: string[]
}

export interface ScanProgress {
  scanned: number
  imported: number
  currentFile: string
}

/** Outcome of renaming an unrecognized file on disk and attempting re-import. */
export interface RenameImportResult {
  /** New absolute path after rename. */
  newPath: string
  /** New file name (with extension). */
  newName: string
  /** Whether the renamed file parsed into a code and was imported. */
  imported: boolean
  /** Parsed code, if the new name was recognizable. */
  code: string | null
}

/** Outcome of manual import with a user-supplied code (no format validation). */
export interface ManualImportResult {
  code: string
  imported: boolean
  /** Path already registered in the library. */
  skippedPath?: boolean
  /** Same code exists elsewhere — file path updated. */
  relocated?: boolean
}

/** Outcome of correcting an existing video's code from the detail page. */
export interface CorrectImportResult {
  code: string
  previousCode: string
  /** Merged into another record; the current video row was removed. */
  mergedIntoId?: number
}

// ---- Batch scrape progress ----

export interface BatchProgress {
  total: number
  current: number
  success: number
  failed: number
  /** Code currently being processed. */
  currentCode: string | null
  status: 'idle' | 'running' | 'paused' | 'done' | 'cancelled'
  logs: BatchLogEntry[]
}

export interface BatchScrapeState {
  kind: 'video' | 'actress' | null
  progress: BatchProgress | null
}

export interface BatchLogEntry {
  time: string
  code: string
  level: 'info' | 'success' | 'error'
  message: string
}

/** Progress for full-library asset encrypt/decrypt migration. */
export interface AssetCryptoProgress {
  phase: 'encrypt' | 'decrypt' | 'relocate'
  current: number
  total: number
  currentFile: string
  status: 'running' | 'done' | 'error'
  error?: string
}

// ---- Generic IPC response wrapper ----

export interface IpcResponse<T> {
  ok: boolean
  data?: T
  error?: string
}

export interface PlayResult {
  ok: boolean
  /** True when the file no longer exists on disk. */
  fileMissing?: boolean
  error?: string
}
