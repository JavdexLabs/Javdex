import { getVideoDetail, listVideos, listYears } from '../db/videoRepo'
import { resolveVideoDisplayDurationSeconds } from '../scanner/videoDuration'
import type { VideoDetail, VideoListResult, VideoQuery } from '@shared/videoTypes'

export interface VideoQueryService {
  list(query?: VideoQuery): VideoListResult
  get(id: number): VideoDetail | null
  listYears(): number[]
}

interface VideoQueryServiceDependencies {
  listVideos: typeof listVideos
  getVideoDetail: typeof getVideoDetail
  listYears: typeof listYears
  resolveDuration: typeof resolveVideoDisplayDurationSeconds
}

export function createVideoQueryService(
  dependencies: Partial<VideoQueryServiceDependencies> = {}
): VideoQueryService {
  const readList = dependencies.listVideos ?? listVideos
  const readDetail = dependencies.getVideoDetail ?? getVideoDetail
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
      return { ...detail, resolved_duration_seconds }
    },
    listYears(): number[] {
      return readYears()
    }
  }
}

export const videoQueryService = createVideoQueryService()
