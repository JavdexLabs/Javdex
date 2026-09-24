import type { ScopedStoredVideoDetail, ScopedVideoDetail } from '@shared/catalogTypes'
import type { VideoResource } from '@shared/videoTypes'
import { maskVideoResourceLocator } from '@shared/videoResourceLinks'
import { resolveVideoDisplayDurationSeconds } from '@library/scan/videoDuration'

interface VideoDetailProjectionOptions {
  /** Host-owned path policy; never resolves a display path back to a playable file. */
  projectResource?: (resource: VideoResource) => VideoResource
  resolveDuration?: typeof resolveVideoDisplayDurationSeconds
}

/** One presentation contract for local and remote catalog detail queries. */
export function projectVideoDetail(
  detail: ScopedStoredVideoDetail,
  options: VideoDetailProjectionOptions = {}
): ScopedVideoDetail {
  const primary = detail.resources.find(resource => resource.is_primary === 1)
  const resolveDuration = options.resolveDuration ?? resolveVideoDisplayDurationSeconds
  return {
    ...detail,
    resolved_duration_seconds: resolveDuration({
      duration_seconds: detail.duration_seconds,
      primary_resource_duration_seconds: primary?.duration_seconds ?? null
    }),
    resources: detail.resources.map(resource => {
      const { locator, resource_key: _resourceKey, source_identity: _sourceIdentity, ...projected } =
        options.projectResource ? options.projectResource(resource) : resource
      return {
        ...projected,
        display_locator: resource.kind === 'local'
          ? locator
          : maskVideoResourceLocator(locator, resource.kind)
      }
    })
  }
}
