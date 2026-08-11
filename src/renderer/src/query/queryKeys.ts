import type { ActressListQuery } from '@shared/actressTypes'
import type { VideoQuery } from '@shared/videoTypes'
import type { ClassificationEntityRef, OrganizationRole } from '@shared/classificationTypes'
import { libraryQueryHash } from '../listView/listQueryParams'

export const videoKeys = {
  all: ['videos'] as const,
  list: (query: VideoQuery, queryHash: string) => ['videos', 'list', queryHash, query] as const,
  listFromParams: (params: URLSearchParams) =>
    ['videos', 'list', libraryQueryHash(params)] as const,
  detail: (id: number) => ['videos', 'detail', id] as const
}

export const actressKeys = {
  all: ['actresses'] as const,
  list: (query: ActressListQuery, queryHash: string) =>
    ['actresses', 'list', queryHash, query] as const,
  faceScanManifest: () => ['actresses', 'face-scan-manifest'] as const,
  conflicts: () => ['actresses', 'conflicts'] as const,
  conflictCount: () => ['actresses', 'conflicts', 'count'] as const,
  conflictSummary: () => ['actresses', 'conflicts', 'summary'] as const
}

export const organizationKeys = {
  all: ['organizations'] as const,
  list: (role: OrganizationRole, queryHash: string) =>
    ['organizations', 'list', role, queryHash] as const,
  detail: (role: OrganizationRole | null, id: number) =>
    ['organizations', 'detail', role, id] as const,
  options: (search = '') => ['organizations', 'options', search] as const,
  mergeOptions: (search = '') => ['organizations', 'merge-options', search] as const
}

export const directorKeys = {
  all: ['directors'] as const,
  list: (queryHash: string) => ['directors', 'list', queryHash] as const,
  detail: (id: number) => ['directors', 'detail', id] as const,
  options: (search = '') => ['directors', 'options', search] as const
}

export const seriesKeys = {
  all: ['series'] as const,
  list: (queryHash: string) => ['series', 'list', queryHash] as const,
  detail: (id: number) => ['series', 'detail', id] as const,
  options: (search = '') => ['series', 'options', search] as const
}

export const classificationImageKeys = {
  all: ['classification-images'] as const,
  candidates: (entity: ClassificationEntityRef) =>
    ['classification-images', 'candidates', entity.kind, entity.id] as const
}

export const overviewStatsKeys = {
  all: ['settings', 'overviewStats'] as const,
  detail: (refreshKey = 0) => ['settings', 'overviewStats', refreshKey] as const
}
