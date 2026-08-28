import type {
  VideoBatchScrapeFilter,
  VideoBatchScrapeRequest
} from '@shared/videoScrapeTypes'

export type VideoBatchCatalogScope =
  | { kind: 'all' }
  | { kind: 'library'; libraryId: number }

function scopeLibraryId(scope: VideoBatchCatalogScope): number | undefined {
  if (scope.kind === 'all') return undefined
  if (!Number.isSafeInteger(scope.libraryId) || scope.libraryId <= 0) {
    throw new Error('媒体库 ID 必须是正整数')
  }
  return scope.libraryId
}

export function withVideoBatchFilterScope(
  scope: VideoBatchCatalogScope,
  filter: Omit<VideoBatchScrapeFilter, 'libraryId'>
): VideoBatchScrapeFilter {
  const libraryId = scopeLibraryId(scope)
  return libraryId === undefined ? filter : { ...filter, libraryId }
}

export function withVideoBatchRequestScope(
  scope: VideoBatchCatalogScope,
  request: Omit<VideoBatchScrapeRequest, 'libraryId'>
): VideoBatchScrapeRequest {
  const libraryId = scopeLibraryId(scope)
  return libraryId === undefined ? request : { ...request, libraryId }
}
