import { catalogReadService } from './catalogReadService'
import { createVideoQueryService, type VideoQueryService } from '@library/catalog/videoQueryService'
export { createVideoQueryService, type VideoQueryService } from '@library/catalog/videoQueryService'
import type { CatalogScope } from '@shared/mediaLibraryTypes'
import type { ScopedVideoListResult } from '@shared/catalogTypes'
import type { VideoQuery } from '@shared/videoTypes'

export interface AsyncVideoQueryService extends Omit<VideoQueryService, 'list' | 'listYears'> {
  list(scope: CatalogScope, query?: VideoQuery): Promise<ScopedVideoListResult>
  listYears(scope: CatalogScope): Promise<number[]>
}

/** Production query seam: catalog scans use the worker; point/resource reads stay local. */
export function createAsyncVideoQueryService(
  reader: Pick<typeof catalogReadService, 'readVideos' | 'readVideoYears'> = catalogReadService,
  local: VideoQueryService = createVideoQueryService()
): AsyncVideoQueryService {
  return {
    list: (scope, query) => reader.readVideos(scope, query),
    listYears: scope => reader.readVideoYears(scope),
    get: (scope, id) => local.get(scope, id),
    getResource: (libraryId, videoId, resourceId) => local.getResource(libraryId, videoId, resourceId)
  }
}

export const videoQueryService = createAsyncVideoQueryService()
