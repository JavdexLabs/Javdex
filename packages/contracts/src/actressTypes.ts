import type { ActressProfileEditFields } from './actressEditContract'
import type { z } from 'zod'
import type {
  actressGalleryAssetSchema,
  actressNameSchema,
  actressSchema,
  actressDetailSchema,
  actressMetadataSchema,
  actressProfileSchema
} from './catalogDetailSchemas'
import type { ScrapedStatus, SortDir } from './commonTypes'
import type { VideoCard } from './videoTypes'
export type { ActressAvatarCommit, AvatarCropV1 } from './avatarCrop'

// 0-未刮削, 1-刮削成功, 2-刮削失败

export type ActressGender = 'female' | 'male'

export type ActressGenderFilter = ActressGender | 'all'

export type ActressListSortBy = 'video_count' | 'gallery' | 'age' | 'cup_size'

export const ACTRESS_LIST_DEFAULTS = {
  sortBy: 'video_count' as ActressListSortBy,
  sortDir: 'desc' as SortDir,
  gender: 'female' as ActressGenderFilter
}

export type Actress = z.infer<typeof actressSchema>

export type ActressName = z.infer<typeof actressNameSchema>

export type ActressGalleryAsset = z.infer<typeof actressGalleryAssetSchema>

export interface ActressGalleryImportInput {
  source: 'file' | 'url'
  /** Absolute local image path, supplied by Electron webUtils.getPathForFile. */
  sourcePath?: string | null
  remoteUrl?: string | null
}

export interface ActressListItem extends Actress {
  video_count: number
  /** SHA-256 fingerprint of the current readable display avatar, when available. */
  avatar_fingerprint?: string | null
}

export type ActressDetail = z.infer<typeof actressDetailSchema>

/** Minimal renderer-session input for local avatar face detection. */
export interface ActressFaceScanManifestItem {
  id: number
  main_name: string
  avatar_path: string
  avatar_fingerprint: string
}

/**
 * Canonical cumulative actress scrape-status filter vocabulary (ADR-0003).
 * Shared by library list URL filters and batch scrape status scope.
 */
export type ActressScrapeStatusFilter = 'all' | 'success' | 'unscraped' | 'failed'

/** Actress library list filter; same id set as batch scrape status. */
export type ActressListStatusFilter = ActressScrapeStatusFilter

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
  sortDir?: SortDir
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
  /** Opaque read snapshot identity; compare only for equality. */
  readRevision?: string
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

export interface ActressEditInput extends ActressProfileEditFields {
  /** Absolute path to a local image file to import as avatar. */
  avatarSourcePath?: string
  /** JPEG avatar bytes (base64) exported from the crop editor. */
  avatarImageBase64?: string
  /** Preferred avatar bundle commit (source + display + crop). */
  avatar?: import('./avatarCrop').ActressAvatarCommit
  /** Clear display/source/crop together. */
  clearAvatar?: boolean
}


/** Narrow identity choices, sorted by full main name then ID; no catalog statistics. */
export interface ActressPickerItem {
  id: number
  /** Display label: at most128 Unicode code points plus ellipsis; fetch detail for edits. */
  main_name: string
  /** Omitted when its JSON representation exceeds4096 bytes. */
  avatar_path: string | null
}
export interface ActressPickerQuery {
  search?: string
  limit?: number
  offset?: number
}
export interface ActressPickerPage {
  items: ActressPickerItem[]
  hasMore: boolean
  offset: number
}


export interface ActressPickerIdentity extends ActressPickerItem {
  revision: number
}


export interface ActressMergeCandidate extends ActressPickerItem {
  gender: ActressGender | null
  video_count: number
}
export interface ActressMergeCandidateQuery extends ActressPickerQuery {
  keepId: number
}
export interface ActressMergeCandidatePage {
  items: ActressMergeCandidate[]
  hasMore: boolean
  offset: number
}

export type ActressMetadata = z.infer<typeof actressMetadataSchema>

/** Associated works only; profile and gallery are separate reads. */
export interface ActressVideoPageQuery {
  withCover?: boolean
  limit?: number
  offset?: number
}

export interface ActressVideoPage {
  videos: VideoCard[]
  total: number
  limit: number
  offset: number
}

export interface ActressGalleryPageQuery {
  /** Locate a stable image in the current display order before paging. */
  anchorId?: number
  localOnly?: boolean
  limit?: number
  offset?: number
}

export interface ActressGalleryPage {
  /** Page-local anchor index; null when a requested anchor is absent. */
  anchorIndex?: number | null
  items: ActressGalleryAsset[]
  total: number
  limit: number
  offset: number
}

/** Profile header without complete work/gallery collections. Counts have explicit scopes. */
export type ActressProfile = z.infer<typeof actressProfileSchema>
