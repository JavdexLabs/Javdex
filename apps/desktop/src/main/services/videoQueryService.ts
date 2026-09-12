import { catalogReadService } from './catalogReadService'
import { getVideoResourceInLibrary } from '@library/db/videoRepo'
import {
  scopedVideoCatalogRepo,
  type ScopedStoredVideoDetail,
  type ScopedVideoCatalogRepo
} from '@library/db/scopedVideoCatalogRepo'
import { resolveVideoDisplayDurationSeconds } from '../scanner/videoDuration'
import type { CatalogScope } from '@shared/mediaLibraryTypes'
import type { ScopedVideoDetail, ScopedVideoListResult } from '@shared/catalogTypes'
import type {
  VideoQuery,
  VideoResource,
  VideoResourceDetail
} from '@shared/videoTypes'
import { maskVideoResourceLocator } from '@shared/videoResourceLinks'

export interface VideoQueryService {
  list(scope: CatalogScope, query?: VideoQuery): ScopedVideoListResult
  get(scope: CatalogScope, id: number): ScopedVideoDetail | null
  getResource(libraryId: number, videoId: number, resourceId: number): VideoResource | null
  listYears(scope: CatalogScope): number[]
}

interface VideoQueryServiceDependencies {
  catalog: ScopedVideoCatalogRepo
  getVideoResourceInLibrary: typeof getVideoResourceInLibrary
  resolveDuration: typeof resolveVideoDisplayDurationSeconds
}

export function createVideoQueryService(
  dependencies: Partial<VideoQueryServiceDependencies> = {}
): VideoQueryService {
  const catalog = dependencies.catalog ?? scopedVideoCatalogRepo
  const readResource = dependencies.getVideoResourceInLibrary ?? getVideoResourceInLibrary
  const resolveDuration = dependencies.resolveDuration ?? resolveVideoDisplayDurationSeconds

  return {
    list(scope, query): ScopedVideoListResult {
      return catalog.list(scope, query ?? {})
    },
    get(scope, id): ScopedVideoDetail | null {
      const detail: ScopedStoredVideoDetail | null = catalog.get(scope, id)
      if (!detail) return null
      const primary = detail.resources.find((resource) => resource.is_primary === 1)
      const resolved_duration_seconds = resolveDuration({
        duration_seconds: detail.duration_seconds,
        primary_resource_duration_seconds: primary?.duration_seconds ?? null
      })
      const resources: VideoResourceDetail[] = detail.resources.map((resource) => {
        const {
          locator,
          resource_key: _resourceKey,
          source_identity: _sourceIdentity,
          ...projected
        } = resource
        return {
          ...projected,
          display_locator:
            resource.kind === 'local'
              ? locator
              : maskVideoResourceLocator(locator, resource.kind)
        }
      })
      return { ...detail, resources, resolved_duration_seconds }
    },
    getResource(libraryId, videoId, resourceId): VideoResource | null {
      const resource = readResource(libraryId, resourceId)
      return resource?.video_id === videoId ? resource : null
    },
    listYears(scope): number[] {
      return catalog.listYears(scope)
    }
  }
}

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
