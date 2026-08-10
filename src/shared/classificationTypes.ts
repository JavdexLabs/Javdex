import type { SortDir } from './commonTypes'

export type OrganizationRole = 'maker' | 'publisher'
export type OrganizationStatus = 'unknown' | 'active' | 'inactive'
export type DirectorStatus = 'unknown' | 'active' | 'paused' | 'retired' | 'deceased'
export type SeriesStatus = 'unknown' | 'ongoing' | 'completed' | 'discontinued'
export type ClassificationListSortBy = 'video_count' | 'updated_at'
export type ClassificationEntityKind = 'organization' | 'director' | 'series'

export interface ClassificationEntityRef {
  kind: ClassificationEntityKind
  id: number
}

export type ClassificationImageInput =
  | { source: 'file'; sourcePath: string }
  | { source: 'url'; remoteUrl: string }
  | { source: 'video-cover'; videoId: number }

export interface ClassificationImageCleanupFailure {
  path: string
  error: string
}

export interface ClassificationImageUpdateResult {
  imagePath: string | null
  cleanupFailures: ClassificationImageCleanupFailure[]
}

export interface ClassificationImageCandidate {
  videoId: number
  code: string
  title: string | null
  coverPath: string
}

export interface ClassificationLinkInput {
  label: string
  url: string
}

export interface ClassificationLink extends ClassificationLinkInput {
  position: number
}

export type OrganizationLinkInput = ClassificationLinkInput
export type OrganizationLink = ClassificationLink

export interface OrganizationProfileInput {
  mainName: string
  aliases?: string[]
  summary?: string | null
  countryRegion?: string | null
  foundedYear?: number | null
  endedYear?: number | null
  status?: OrganizationStatus
  parentOrganizationId?: number | null
  links?: ClassificationLinkInput[]
}

export interface OrganizationCreateInput extends OrganizationProfileInput {
  role: OrganizationRole
}

export interface OrganizationUpdateInput extends OrganizationProfileInput {
  keepPreviousMainName?: boolean
}

export interface OrganizationListQuery {
  role: OrganizationRole
  search?: string
  sortBy?: ClassificationListSortBy
  sortDir?: SortDir
}

export interface OrganizationListItem {
  id: number
  mainName: string
  imagePath: string | null
  fallbackCoverPath: string | null
  videoCount: number
  updatedAt: string
}

export interface OrganizationSummary {
  id: number
  mainName: string
}

export interface OrganizationDetail extends OrganizationListItem {
  summary: string | null
  countryRegion: string | null
  foundedYear: number | null
  endedYear: number | null
  status: OrganizationStatus
  parent: OrganizationSummary | null
  aliases: string[]
  links: ClassificationLink[]
  roles: OrganizationRole[]
  makerVideoCount: number
  publisherVideoCount: number
  releaseYearStart: number | null
  releaseYearEnd: number | null
}

export interface OrganizationOption extends OrganizationSummary {
  aliases: string[]
  roles: OrganizationRole[]
}

export interface OrganizationMergeOption extends OrganizationOption {
  videoCount: number
  makerVideoCount: number
  publisherVideoCount: number
}

export type OrganizationAssignmentInput =
  | { organizationId: number }
  | { createName: string }

export interface OrganizationAssignmentResult {
  organizationId: number | null
  mainName: string | null
}

export type OrganizationMergeInput = ClassificationMergeInput

export interface OrganizationMergeResult {
  targetId: number
  sourceId: number
  transferredMakerVideoCount: number
  transferredPublisherVideoCount: number
  transferredChildCount: number
  transferredSeriesCount: number
  imagePath: string | null
  cleanupFailures: ClassificationImageCleanupFailure[]
}

export interface DirectorDeleteImpact {
  id: number
  videoCount: number
}

export interface DirectorDeleteResult {
  id: number
  unlinkedVideoCount: number
  cleanupFailures: ClassificationImageCleanupFailure[]
}

export interface SeriesDeleteImpact {
  id: number
  videoCount: number
  directChildCount: number
}

export interface SeriesDeleteResult {
  id: number
  unlinkedVideoCount: number
  detachedChildCount: number
  cleanupFailures: ClassificationImageCleanupFailure[]
}

export interface DirectorProfileInput {
  mainName: string
  aliases?: string[]
  summary?: string | null
  countryRegion?: string | null
  birthDate?: string | null
  deathDate?: string | null
  birthPlace?: string | null
  careerStartYear?: number | null
  careerEndYear?: number | null
  status?: DirectorStatus
  links?: ClassificationLinkInput[]
}

export interface DirectorUpdateInput extends DirectorProfileInput {
  keepPreviousMainName?: boolean
}

export interface DirectorListQuery {
  search?: string
  sortBy?: ClassificationListSortBy
  sortDir?: SortDir
}

export interface DirectorListItem {
  id: number
  mainName: string
  imagePath: string | null
  fallbackCoverPath: string | null
  videoCount: number
  updatedAt: string
}

export interface DirectorDetail extends DirectorListItem {
  aliases: string[]
  summary: string | null
  countryRegion: string | null
  birthDate: string | null
  deathDate: string | null
  birthPlace: string | null
  careerStartYear: number | null
  careerEndYear: number | null
  status: DirectorStatus
  links: ClassificationLink[]
  releaseYearStart: number | null
  releaseYearEnd: number | null
}

export interface DirectorOption {
  id: number
  mainName: string
  aliases: string[]
  countryRegion: string | null
  birthDate: string | null
  careerStartYear: number | null
  careerEndYear: number | null
  videoCount: number
}

export type DirectorAssignmentInput = { directorId: number } | { createName: string }

export interface DirectorAssignmentResult {
  directorId: number | null
  mainName: string | null
}

export interface ClassificationMergeInput {
  targetId: number
  sourceId: number
}

export type DirectorMergeInput = ClassificationMergeInput

export interface DirectorMergeResult {
  targetId: number
  sourceId: number
  transferredVideoCount: number
  imagePath: string | null
  cleanupFailures: ClassificationImageCleanupFailure[]
}

export interface SeriesProfileInput {
  mainName: string
  aliases?: string[]
  summary?: string | null
  ownerOrganizationId?: number | null
  parentSeriesId?: number | null
  startYear?: number | null
  endYear?: number | null
  status?: SeriesStatus
  links?: ClassificationLinkInput[]
}

export interface SeriesUpdateInput extends SeriesProfileInput {
  keepPreviousMainName?: boolean
}

export interface SeriesListQuery {
  search?: string
  sortBy?: ClassificationListSortBy
  sortDir?: SortDir
}

export interface SeriesListItem {
  id: number
  mainName: string
  imagePath: string | null
  fallbackCoverPath: string | null
  ownerOrganization: OrganizationSummary | null
  videoCount: number
  updatedAt: string
}

export interface SeriesSummary {
  id: number
  mainName: string
  ownerOrganization: OrganizationSummary | null
}

export interface SeriesDetail extends SeriesListItem {
  aliases: string[]
  summary: string | null
  parentSeries: SeriesSummary | null
  startYear: number | null
  endYear: number | null
  status: SeriesStatus
  links: ClassificationLink[]
  releaseYearStart: number | null
  releaseYearEnd: number | null
}

export interface SeriesOption extends SeriesSummary {
  aliases: string[]
  videoCount: number
}

export type SeriesAssignmentInput = { seriesId: number } | { createName: string }

export interface SeriesAssignmentResult {
  seriesId: number | null
  mainName: string | null
}

export type SeriesMergeInput = ClassificationMergeInput

export interface SeriesMergeResult {
  targetId: number
  sourceId: number
  transferredVideoCount: number
  transferredChildCount: number
  imagePath: string | null
  cleanupFailures: ClassificationImageCleanupFailure[]
}
