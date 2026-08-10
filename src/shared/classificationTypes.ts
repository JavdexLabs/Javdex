import type { SortDir } from './commonTypes'

export type OrganizationRole = 'maker' | 'publisher'
export type OrganizationStatus = 'unknown' | 'active' | 'inactive'
export type ClassificationListSortBy = 'video_count' | 'updated_at'

export interface OrganizationLinkInput {
  label: string
  url: string
}

export interface OrganizationLink extends OrganizationLinkInput {
  position: number
}

export interface OrganizationProfileInput {
  mainName: string
  aliases?: string[]
  summary?: string | null
  countryRegion?: string | null
  foundedYear?: number | null
  endedYear?: number | null
  status?: OrganizationStatus
  parentOrganizationId?: number | null
  links?: OrganizationLinkInput[]
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
  links: OrganizationLink[]
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
