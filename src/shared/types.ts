// Shared domain types used across main / preload / renderer processes.

import {
  DEFAULT_AVATAR_FACE_RATIO,
  DEFAULT_AVATAR_FACE_SCALE_PRESET,
  type AvatarFaceScalePreset
} from './avatarFaceScale'
import {
  DEFAULT_AVATAR_CENTERING_MODE,
  type AvatarCenteringMode
} from './avatarCentering'
import type {
  CorrectImportResult,
  Video,
  VideoAsset,
  VideoDetail,
  VideoEditInput,
  VideoExternalStats,
  VideoFile,
  VideoListResult,
  VideoQuery,
  VideoSampleImportInput,
  VideoTag
} from './videoTypes'
import {
  ACTRESS_BATCH_DEFAULT_MISSING_FIELDS,
  ACTRESS_BATCH_SCRAPE_SCOPE_OPTIONS,
  ACTRESS_BATCH_SCRAPE_STATUS_OPTIONS,
  ACTRESS_SCRAPE_FIELD_OPTIONS,
  ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS,
  ALL_ACTRESS_SCRAPE_FIELDS,
  ALL_VIDEO_SCRAPE_FIELDS,
  VIDEO_BATCH_SCRAPE_STATUS_OPTIONS,
  VIDEO_REMATCH_SCOPE_OPTIONS,
  VIDEO_SCRAPE_FIELD_OPTIONS,
  VIDEO_SCRAPE_UPDATE_MODE_OPTIONS,
  expandActressScrapeFields,
  type ActressAvatarAutoCropOutcome,
  type ActressAvatarAutoCropRequest,
  type ActressAvatarAutoCropResponse,
  type ActressAvatarAutoCropStatus,
  type ActressAvatarAutoCropTarget,
  type ActressBatchScrapeFilter,
  type ActressBatchScrapeRequest,
  type ActressBatchScrapeScope,
  type ActressBatchScrapeStatus,
  type ActressScrapeDisposition,
  type ActressScrapeField,
  type ActressScrapeFieldImpact,
  type ActressScrapePluginRef,
  type ActressScrapeResult,
  type ActressScrapeUpdateMode,
  type BatchLogEntry,
  type BatchProgress,
  type BatchScrapeState,
  type CompositeScraperDefinition,
  type CompositeScraperInput,
  type LegacyActressBatchScrapeStatus,
  type ScrapeResult,
  type ScrapeUpdateModeOption,
  type ScrapedActress,
  type ScraperPluginDelay,
  type ScraperPluginDelaySettings,
  type ScraperPluginDescriptor,
  type ScraperPluginKind,
  type ScraperPluginPackage,
  type ScraperPluginPackageExport,
  type ScraperPluginPackageImport,
  type ScraperPluginSource,
  type ScraperPluginUpdateInput,
  type VideoBatchScrapeFilter,
  type VideoBatchScrapeRequest,
  type VideoBatchScrapeStatus,
  type VideoRematchBatchRequest,
  type VideoRematchScope,
  type VideoScrapeField,
  type VideoScrapeOneResult,
  type VideoScrapeUpdateMode
} from './scrapeTypes'

export type {
  CorrectImportResult,
  Video,
  VideoAsset,
  VideoDetail,
  VideoEditInput,
  VideoExternalStats,
  VideoFile,
  VideoListResult,
  VideoQuery,
  VideoSampleImportInput,
  VideoTag
} from './videoTypes'

export {
  ACTRESS_BATCH_DEFAULT_MISSING_FIELDS,
  ACTRESS_BATCH_SCRAPE_SCOPE_OPTIONS,
  ACTRESS_BATCH_SCRAPE_STATUS_OPTIONS,
  ACTRESS_SCRAPE_FIELD_OPTIONS,
  ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS,
  ALL_ACTRESS_SCRAPE_FIELDS,
  ALL_VIDEO_SCRAPE_FIELDS,
  VIDEO_BATCH_SCRAPE_STATUS_OPTIONS,
  VIDEO_REMATCH_SCOPE_OPTIONS,
  VIDEO_SCRAPE_FIELD_OPTIONS,
  VIDEO_SCRAPE_UPDATE_MODE_OPTIONS,
  expandActressScrapeFields
} from './scrapeTypes'
export type {
  ActressAvatarAutoCropOutcome,
  ActressAvatarAutoCropRequest,
  ActressAvatarAutoCropResponse,
  ActressAvatarAutoCropStatus,
  ActressAvatarAutoCropTarget,
  ActressBatchScrapeFilter,
  ActressBatchScrapeRequest,
  ActressBatchScrapeScope,
  ActressBatchScrapeStatus,
  ActressScrapeDisposition,
  ActressScrapeField,
  ActressScrapeFieldImpact,
  ActressScrapePluginRef,
  ActressScrapeResult,
  ActressScrapeUpdateMode,
  BatchLogEntry,
  BatchProgress,
  BatchScrapeState,
  CompositeScraperDefinition,
  CompositeScraperInput,
  LegacyActressBatchScrapeStatus,
  ScrapeResult,
  ScrapeUpdateModeOption,
  ScrapedActress,
  ScraperPluginDelay,
  ScraperPluginDelaySettings,
  ScraperPluginDescriptor,
  ScraperPluginKind,
  ScraperPluginPackage,
  ScraperPluginPackageExport,
  ScraperPluginPackageImport,
  ScraperPluginSource,
  ScraperPluginUpdateInput,
  VideoBatchScrapeFilter,
  VideoBatchScrapeRequest,
  VideoBatchScrapeStatus,
  VideoRematchBatchRequest,
  VideoRematchScope,
  VideoScrapeField,
  VideoScrapeOneResult,
  VideoScrapeUpdateMode
} from './scrapeTypes'

export type { AvatarFaceScalePreset } from './avatarFaceScale'
export type { AvatarCenteringMode } from './avatarCentering'

export type ScrapedStatus = 0 | 1 | 2 // 0-未刮削, 1-刮削成功, 2-刮削失败

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
  scraped_status: ScrapedStatus
  last_scraped_at: string | null
  updated_at: string | null
  gender: ActressGender | null
  revision?: number
}

export interface Tag {
  id: number
  name: string
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
  /** SHA-256 fingerprint of the current readable display avatar, when available. */
  avatar_fingerprint?: string | null
}

/** Minimal renderer-session input for local avatar face detection. */
export interface ActressFaceScanManifestItem {
  id: number
  main_name: string
  avatar_path: string
  avatar_fingerprint: string
}

/** Canonical actress library status filter vocabulary (also the URL values). */
export type ActressListStatusFilter = 'all' | 'success' | 'unscraped' | 'failed'

/** Actress avatar filter, including the renderer-only local face-detection state. */
export type ActressAvatarFilter = 'all' | 'with' | 'without' | 'without-face'

export const ACTRESS_LIST_STATUS_SCRAPED_STATUS: Record<
  Exclude<ActressListStatusFilter, 'all'>,
  ScrapedStatus
> = {
  unscraped: 0,
  success: 1,
  failed: 2
}

const ACTRESS_LIST_STATUS_BY_SCRAPED_STATUS = new Map<
  ScrapedStatus,
  Exclude<ActressListStatusFilter, 'all'>
>(
  (
    Object.entries(ACTRESS_LIST_STATUS_SCRAPED_STATUS) as [
      Exclude<ActressListStatusFilter, 'all'>,
      ScrapedStatus
    ][]
  ).map(([filter, status]) => [status, filter])
)

/** Filter vocabulary for a stored cumulative status value. */
export function actressStatusFilterOf(
  status: ScrapedStatus
): Exclude<ActressListStatusFilter, 'all'> {
  return ACTRESS_LIST_STATUS_BY_SCRAPED_STATUS.get(status) ?? 'unscraped'
}

/**
 * Single label source for the three concrete cumulative scrape states, shared by the
 * library filter, avatar badge, detail page, and batch scope so the strings never drift.
 */
export const ACTRESS_SCRAPE_STATUS_LABELS: Record<Exclude<ActressListStatusFilter, 'all'>, string> = {
  unscraped: '未刮削',
  success: '刮削成功',
  failed: '刮削失败'
}

/** Actress library status-filter labels; the "all" option is filter-specific ("全部状态"). */
export const ACTRESS_STATUS_FILTER_LABELS: Record<ActressListStatusFilter, string> = {
  all: '全部状态',
  ...ACTRESS_SCRAPE_STATUS_LABELS
}

export interface ActressListQuery {
  search?: string
  gender?: ActressGenderFilter
  status?: ActressListStatusFilter
  avatar?: ActressAvatarFilter
  sortBy?: ActressListSortBy
  sortDir?: ListSortDir
  limit?: number
  offset?: number
  /** Renderer-session subset used to page already classified local face results. */
  actressIds?: number[]
}

/** Actresses per cumulative status within the current search and gender scope. */
export type ActressListStatusCounts = Record<ActressListStatusFilter, number>

export interface ActressListPage {
  items: ActressListItem[]
  total: number
  statusCounts: ActressListStatusCounts
}

/** Read-only source metadata used by renderer-side smart avatar composition. */
export interface ActressAvatarSourceInfo {
  assetPath: string
  sourceFingerprint: string
  /** True when the selected asset is a legacy display avatar that must become the source. */
  requiresSourceAdoption: boolean
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

/** One row in the exportable plugin-dev agent work log (full fidelity for workflow analysis). */
export type PluginDevAgentWorkLogEntry =
  | {
      at: string
      kind: 'event'
      event: PluginDevAgentEvent
    }
  | {
      at: string
      kind: 'user_message'
      sessionId: string
      source: 'start' | 'continue'
      text: string
    }

export interface PluginDevAgentWorkLogExport {
  schemaVersion: 1
  kind: 'pluginDevAgentWorkLog'
  exportedAt: string
  sessionId: string
  meta: {
    mode: PluginDevAgentMode
    pluginKind: ScraperPluginKind
    siteName: string
    siteUrl?: string
    status: PluginDevSessionStatus
    phase: PluginDevAgentPhase
    step: number
    totalTokens: number
    maxSteps: number
    maxContextTokens: number
    testTargets: string[]
    supportedFields: string[]
    endedAt?: string
  }
  /** Compact human-readable timeline derived from entries. */
  timeline: string[]
  entries: PluginDevAgentWorkLogEntry[]
  package: ScraperPluginPackage
  lastDryRun?: PluginDevDryRunResult
  lastVerification?: PluginDevVerificationReport
}

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

export type ActressPendingNameType = 'main' | 'zh' | 'en' | 'alias'

export interface PendingActressScrapeCandidate {
  pendingId: number
  revision: number
  actressId: number
  actressRevision: number
  actressMainName: string
  actressAvatarPath: string | null
  plugin: ActressScrapePluginRef
  queryName: string
  selectedFields: ActressScrapeField[]
  applicableFields: ActressScrapeField[]
  mode: ActressScrapeUpdateMode
  result: ActressScrapeResult
  warnings: string[]
  createdAt: string
  batchJobId?: string
  resources: PendingActressScrapeResource[]
  conflicts: Array<{ name: string; normalizedName: string; type: ActressPendingNameType }>
  /** Exact field result when this candidate actress receives the current conflict name. */
  fieldImpactsWhenAssignedToCandidate: ActressScrapeFieldImpact[]
  /** Exact field result when the current conflict name is kept away from this candidate. */
  fieldImpacts: ActressScrapeFieldImpact[]
  willApplyAfterDecision: boolean
  remainingConflictCountAfterDecision: number
}

export interface PendingActressScrapeResource {
  field: 'avatar' | 'gallery'
  position: number
  remoteUrl?: string
  stagedPath: string
  width: number | null
  height: number | null
}

export interface DiscardPendingActressScrapeInput {
  pendingId: number
  expectedRevision: number
}

export interface DiscardPendingActressScrapeResult {
  remainingPending: number
}

export interface ActressConflictCurrentOwner {
  actressId: number
  revision: number
  mainName: string
  avatarPath: string | null
  nameTypes: ActressPendingNameType[]
  hasPendingScrape: boolean
}

export interface PendingActressNameClaim {
  claimId: number
  actressId: number
  name: string
  type: ActressPendingNameType
  locale: string | null
  source: string | null
  isPrimary: boolean
}

export interface ActressNameConflictGroup {
  status: 'conflict' | 'applicable'
  normalizedName: string
  displayName: string
  currentOwner: ActressConflictCurrentOwner | null
  /** Every actress that currently declares this normalized name, including legacy ambiguous claims. */
  claimants: ActressConflictCurrentOwner[]
  /** Ambiguous historical claims awaiting an explicit ownership decision. */
  pendingNameClaims: PendingActressNameClaim[]
  candidates: PendingActressScrapeCandidate[]
  /** Exact main-process merge preflight for every pair shown in this group. */
  mergePairs?: Array<{
    actressIds: [number, number]
    blockedReason: string | null
  }>
}

export interface ActressConflictReviewSummary {
  groupCount: number
  conflictGroupCount: number
  applicableGroupCount: number
  pendingScrapeCount: number
  pendingNameClaimGroupCount: number
}

export interface InspectActressConflictNameInput {
  actressId: number
  name: string
  pendingId?: number
}

export interface InspectActressConflictNameResult {
  normalizedName: string
  status: 'available' | 'conflict'
}

export interface ActressConflictDecisionSnapshot {
  status: 'conflict' | 'applicable'
  normalizedName: string
  currentOwnerActressId: number | null
  currentOwnerRevision: number | null
  claimants: Array<{ actressId: number; revision: number }>
  pendingNameClaims: Array<{
    claimId: number
    actressId: number
    name: string
    type: ActressPendingNameType
  }>
  candidates: Array<{
    pendingId: number
    pendingRevision: number
    actressId: number
    actressRevision: number
  }>
}

export interface ActressConflictReplacementMainName {
  actressId: number
  mainName: string
}

export interface ValidateIllegalNameReplacementsInput {
  snapshot: ActressConflictDecisionSnapshot
  replacementMainNames: ActressConflictReplacementMainName[]
  /** Ownership decisions keep this claimant's main name; illegal-name decisions omit it. */
  destinationOwnerActressId?: number
}

export type ValidateIllegalNameReplacementsResult =
  | { status: 'valid' }
  | {
      status: 'invalid'
      errors: Array<{ actressId: number; message: string }>
    }
  | { status: 'stale'; message: string }

interface ActressConflictDecisionBase {
  snapshot: ActressConflictDecisionSnapshot
  replacementMainNames: ActressConflictReplacementMainName[]
}

export type ResolveActressConflictInput = ActressConflictDecisionBase &
  (
    | {
        kind: 'editName'
        pendingId: number
        name: string
        nameType: ActressPendingNameType
        newName: string
      }
    | {
        kind: 'editPendingNameClaim'
        claimId: number
        actressId: number
        name: string
        nameType: ActressPendingNameType
        newName: string
      }
    | { kind: 'assignToCurrentActress'; pendingId: number }
    | {
        kind: 'assignToExistingActress'
        ownerActressId: number
        ownerActressRevision: number
      }
    | {
        kind: 'mergeActresses'
        pendingId?: number
        keepActressId: number
        keepActressRevision: number
        mergeActressId: number
        mergeActressRevision: number
        finalMainName: string
      }
    | { kind: 'markIllegalName' }
    | { kind: 'applyPending'; pendingId: number }
  )

export type ResolveActressConflictResult =
  | { status: 'success'; remainingPending: number }
  | { status: 'stale'; message: string }

/** UI color theme id (maps to CSS variables on html[data-theme]). */
export type ThemeId = 'graphite' | 'warm' | 'slate' | 'light'

const VALID_THEMES: ThemeId[] = ['graphite', 'warm', 'slate', 'light']

export function normalizeTheme(value: unknown): ThemeId {
  return VALID_THEMES.includes(value as ThemeId) ? (value as ThemeId) : 'graphite'
}

export const PRIVACY_MODE_SCOPES = [
  'covers',
  'videoSamples',
  'actressGallery',
  'actressDefaultAvatar',
  'imagePreview',
  'mediaEditors',
  'globalBackground'
] as const

export type PrivacyModeScope = (typeof PRIVACY_MODE_SCOPES)[number]

export function normalizePrivacyModeScopes(value: unknown): PrivacyModeScope[] {
  if (!Array.isArray(value)) return [...PRIVACY_MODE_SCOPES]
  const validScopes = new Set<unknown>(PRIVACY_MODE_SCOPES)
  return Array.from(
    new Set(value.filter((scope): scope is PrivacyModeScope => validScopes.has(scope)))
  )
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
  /** Apply display-only anti-peep protection to selected UI surfaces and interactions. */
  privacyModeEnabled: boolean
  /** UI surfaces and interactions protected while anti-peep mode is enabled. */
  privacyModeScopes: PrivacyModeScope[]
  /** Default face size used by local smart avatar composition. */
  avatarFaceRatio: number
  /** @deprecated Retained to migrate settings written before the continuous face-ratio control. */
  avatarFaceScalePreset: AvatarFaceScalePreset
  /** Default anchor used by local smart avatar composition. */
  avatarCenteringMode: AvatarCenteringMode
  /** Keep detected hair crown and chin inside the avatar crop. */
  avatarPreserveFullHead: boolean
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
  privacyModeEnabled: false,
  privacyModeScopes: [...PRIVACY_MODE_SCOPES],
  avatarFaceRatio: DEFAULT_AVATAR_FACE_RATIO,
  avatarFaceScalePreset: DEFAULT_AVATAR_FACE_SCALE_PRESET,
  avatarCenteringMode: DEFAULT_AVATAR_CENTERING_MODE,
  avatarPreserveFullHead: false,
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

/** Free-text metadata dimensions backed by a column on `videos`. */
export type FacetType = 'maker' | 'publisher' | 'series' | 'director'

export interface FacetItem {
  value: string
  video_count: number
  /** A representative cover for the list thumbnail. */
  cover_path: string | null
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
    /** Female performers with cumulative 刮削成功. */
    scraped: number
    /** Female performers with cumulative 刮削失败. */
    failed: number
    /** Female performers with cumulative 未刮削. */
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
