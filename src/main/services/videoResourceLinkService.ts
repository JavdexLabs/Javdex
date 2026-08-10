import type { VideoResourceLinkCheckResult } from '@shared/videoTypes'
import { normalizeHttpVideoResource } from '@shared/videoResourceLinks'

interface VideoResourceLinkServiceDependencies {
  fetchImpl: typeof fetch
}

export interface VideoResourceLinkService {
  check(url: string): Promise<VideoResourceLinkCheckResult>
}

export function createVideoResourceLinkService(
  dependencies: Partial<VideoResourceLinkServiceDependencies> = {}
): VideoResourceLinkService {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  return {
    async check(rawUrl): Promise<VideoResourceLinkCheckResult> {
      let locator: string
      try {
        locator = normalizeHttpVideoResource(rawUrl).locator
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
      try {
        const response = await fetchImpl(locator, {
          method: 'HEAD',
          redirect: 'follow',
          signal: AbortSignal.timeout(8000)
        })
        const rawLength = response.headers.get('content-length')
        const parsedLength = rawLength == null ? null : Number(rawLength)
        return {
          ok: response.ok,
          status: response.status,
          sizeBytes:
            parsedLength != null && Number.isSafeInteger(parsedLength) && parsedLength > 0
              ? parsedLength
              : null,
          ...(!response.ok ? { error: `链接返回 HTTP ${response.status}` } : {})
        }
      } catch {
        return { ok: false, error: '无法连接到该链接，请检查网络或稍后重试' }
      }
    }
  }
}

export const videoResourceLinkService = createVideoResourceLinkService()
