import type Database from 'better-sqlite3'
import { getVideoDetail, getVideoResourceInLibrary } from '@library/db/videoRepo'
import {
  scopedVideoCatalogRepo,
  createScopedVideoCatalogRepo,
  type ScopedStoredVideoDetail,
  type ScopedVideoCatalogRepo
} from '@library/db/scopedVideoCatalogRepo'
import { resolveVideoDisplayDurationSeconds } from '@library/scan/videoDuration'
import type { CatalogScope } from '@shared/mediaLibraryTypes'
import type { ScopedVideoDetail, ScopedVideoListResult } from '@shared/catalogTypes'
import type {
  VideoQuery,
  VideoResource
} from '@shared/videoTypes'
import { projectVideoDetail } from '@library/catalog/videoDetailProjection'

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
  database: Database.Database
  projectDetail: typeof projectVideoDetail
  /** Manage queries may read canonical records without an active membership. Desktop scoped reads may not. */
  includeUnscoped: boolean
}

export function createVideoQueryService(
  dependencies: Partial<VideoQueryServiceDependencies> = {}
): VideoQueryService {
  const catalog = dependencies.catalog ?? (dependencies.database
    ? createScopedVideoCatalogRepo(dependencies.database) : scopedVideoCatalogRepo)
  const readResource = dependencies.getVideoResourceInLibrary ?? ((libraryId, resourceId) =>
    getVideoResourceInLibrary(libraryId, resourceId, dependencies.database))
  const resolveDuration = dependencies.resolveDuration ?? resolveVideoDisplayDurationSeconds

  return {
    list(scope, query): ScopedVideoListResult {
      return catalog.list(scope, query ?? {})
    },
    get(scope, id): ScopedVideoDetail | null {
      let detail: ScopedStoredVideoDetail | null = catalog.get(scope, id)
      if (!detail && dependencies.includeUnscoped) {
        const canonical = getVideoDetail(id, dependencies.database)
        if (canonical) detail = { ...canonical, activeLibraryId: 0, membershipAddedAt: '', libraries: [] }
      }
      if (!detail) return null
      return (dependencies.projectDetail ?? projectVideoDetail)(detail, { resolveDuration })
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
