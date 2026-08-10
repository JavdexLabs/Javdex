import type { SortDir } from './commonTypes'

export type OrganizationRole = 'maker' | 'publisher'
export type OrganizationStatus = 'unknown' | 'active' | 'inactive'
export type DirectorStatus = 'unknown' | 'active' | 'paused' | 'retired' | 'deceased'
export type SeriesStatus = 'unknown' | 'ongoing' | 'completed' | 'discontinued'
export type ClassificationListSortBy = 'video_count' | 'updated_at'

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
  releaseYearStart: number | null
  releaseYearEnd: number | null
}

export interface OrganizationOption extends OrganizationSummary {
  aliases: string[]
  roles: OrganizationRole[]
}

export type OrganizationAssignmentInput =
  | { organizationId: number }
  | { createName: string }

export interface OrganizationAssignmentResult {
  organizationId: number | null
  mainName: string | null
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
