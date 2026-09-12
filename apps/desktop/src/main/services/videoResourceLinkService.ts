import type { VideoResourceLinkCheckResult } from '@shared/videoTypes'
import { normalizeHttpVideoResource } from '@shared/videoResourceLinks'
import { fetchPublicHttpHead } from './publicHttpFetch'

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
          ...(!response.ok ? { error: `链接返回 HTTP ${response.status}` } : {})
        }
      } catch {
        return { ok: false, error: '无法连接到该链接，请检查网络或稍后重试' }
      }
    }
  }
}

export const videoResourceLinkService = createVideoResourceLinkService()
