import { normalizeLocalPathIdentity } from './localPathIdentity'

export type SourceManagedVideoResource = {
  kind: 'local' | 'direct' | 'web' | 'magnet' | 'ed2k'
  locator: string
  strmSourcePath?: string | null
}

/**
 * Stable identity for resources whose source is managed by a media-library root.
 * Remote resources deliberately return null so the same URL can be attached to
 * more than one library without claiming ownership of an external source.
 */
export function buildVideoResourceSourceIdentity(
  resource: SourceManagedVideoResource
): string | null {
  const strmSourcePath = resource.strmSourcePath?.trim()
  if (strmSourcePath) {
    return `strm:${normalizeLocalPathIdentity(strmSourcePath)}`
  }
  if (resource.kind === 'local') {
    return `local:${normalizeLocalPathIdentity(resource.locator)}`
  }
  return null
}
