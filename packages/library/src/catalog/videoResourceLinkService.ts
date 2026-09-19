import type { VideoResourceLinkCheckResult } from '@shared/videoTypes'
import { normalizeHttpVideoResource } from '@shared/videoResourceLinks'
import { fetchPublicHttpHead } from '@library/net/publicHttpFetch'

interface VideoResourceLinkServiceDependencies {
  requestHead: typeof fetchPublicHttpHead
}

export interface VideoResourceLinkService {
  check(url: string): Promise<VideoResourceLinkCheckResult>
}

export function createVideoResourceLinkService(
  dependencies: Partial<VideoResourceLinkServiceDependencies> = {}
): VideoResourceLinkService {
  const requestHead = dependencies.requestHead ?? fetchPublicHttpHead
  return {
    async check(rawUrl): Promise<VideoResourceLinkCheckResult> {
      let locator: string
      try {
        locator = normalizeHttpVideoResource(rawUrl).locator
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
      try {
        const response = await requestHead(locator)
        return {
          ok: response.ok,
          status: response.status,
          sizeBytes: response.sizeBytes,
          ...(!response.ok
            ? { error: `探测返回 HTTP ${response.status}；不代表无法导入。` }
            : {})
        }
      } catch {
        return {
          ok: false,
          error: '未能读取大小。站点可能拒绝探测请求，仍可导入。'
        }
      }
    }
  }
}

export const videoResourceLinkService = createVideoResourceLinkService()
