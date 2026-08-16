import { getVideoDetail, getVideoResourceById, listVideos, listYears } from '../db/videoRepo'
import { resolveVideoDisplayDurationSeconds } from '../scanner/videoDuration'
import type {
  VideoDetail,
  VideoListResult,
  VideoQuery,
  VideoResource,
  VideoResourceDetail
} from '@shared/videoTypes'
import { maskVideoResourceLocator } from '@shared/videoResourceLinks'

export interface VideoQueryService {
  list(query?: VideoQuery): VideoListResult
  get(id: number): VideoDetail | null
  getResource(videoId: number, resourceId: number): VideoResource | null
  listYears(): number[]
}

interface VideoQueryServiceDependencies {
  listVideos: typeof listVideos
  getVideoDetail: typeof getVideoDetail
  getVideoResourceById: typeof getVideoResourceById
  listYears: typeof listYears
  resolveDuration: typeof resolveVideoDisplayDurationSeconds
}

export function createVideoQueryService(
  dependencies: Partial<VideoQueryServiceDependencies> = {}
): VideoQueryService {
  const readList = dependencies.listVideos ?? listVideos
  const readDetail = dependencies.getVideoDetail ?? getVideoDetail
  const readResource = dependencies.getVideoResourceById ?? getVideoResourceById
  const readYears = dependencies.listYears ?? listYears
  const resolveDuration = dependencies.resolveDuration ?? resolveVideoDisplayDurationSeconds

  return {
    list(query): VideoListResult {
      return readList(query ?? {})
    },
    get(id): VideoDetail | null {
      const detail = readDetail(id)
      if (!detail) return null
      const primary = detail.resources.find((resource) => resource.is_primary === 1)
      const resolved_duration_seconds = resolveDuration({
        duration_seconds: detail.duration_seconds,
        primary_resource_duration_seconds: primary?.duration_seconds ?? null
      })
      const resources: VideoResourceDetail[] = detail.resources.map((resource) => {
        const { locator, resource_key: _resourceKey, ...projected } = resource
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
    getResource(videoId, resourceId): VideoResource | null {
      const resource = readResource(resourceId)
      return resource?.video_id === videoId ? resource : null
    },
    listYears(): number[] {
      return readYears()
    }
  }
}

export const videoQueryService = createVideoQueryService()
