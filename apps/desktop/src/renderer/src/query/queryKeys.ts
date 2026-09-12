import type { ActressListQuery } from '@shared/actressTypes'
import type { CatalogScope } from '@shared/mediaLibraryTypes'
import type { VideoQuery } from '@shared/videoTypes'
import type { ClassificationEntityRef, OrganizationRole } from '@shared/classificationTypes'
import { libraryQueryHash } from '../listView/listQueryParams'

export const videoKeys = {
  all: ['videos'] as const,
  list: (scope: CatalogScope, query: VideoQuery, queryHash: string) =>
    ['videos', 'list', catalogScopeKey(scope), queryHash, query] as const,
  listFromParams: (scope: CatalogScope, params: URLSearchParams) =>
    ['videos', 'list', catalogScopeKey(scope), libraryQueryHash(params)] as const,
  detail: (scope: CatalogScope, id: number) =>
    ['videos', 'detail', catalogScopeKey(scope), id] as const,
  years: (scope: CatalogScope) => ['videos', 'years', catalogScopeKey(scope)] as const
}

export const mediaLibraryKeys = {
  all: ['media-libraries'] as const,
  activeList: () => ['media-libraries', 'list', 'active'] as const,
  fullList: () => ['media-libraries', 'list', 'with-archived'] as const,
  detail: (libraryId: number) => ['media-libraries', 'detail', libraryId] as const
}

export const homeKeys = {
  all: ['home'] as const,
  snapshot: (seed: string) => ['home', 'snapshot', seed] as const,
  search: (queryHash: string) => ['home', 'search', queryHash] as const
}

/** Stable, order-independent identity for an explicit catalog scope. */
export function catalogScopeKey(scope: CatalogScope): string {
  if (scope.kind === 'library') return `library:${scope.libraryId}`
  const ids = [...new Set(scope.libraryIds ?? [])].sort((left, right) => left - right)
  return ids.length > 0 ? `all:${ids.join(',')}` : 'all'
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
