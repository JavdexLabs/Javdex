import type {
  ExternalVideoResourceKind,
  LinkVideoResourceKind,
  VideoLinkResourceFields,
  VideoLinkResourceImportInput,
  VideoResourceLinkCheckResult,
  VideoResourceSizeUnit
} from '@shared/videoTypes'
import type { RelatedLinkInput } from '@shared/relatedLinkTypes'
import {
  inferVideoResourceKind,
  normalizeExternalVideoResource,
  resourceSizeToBytes
} from '@shared/videoResourceLinks'
import { normalizeVideoCode } from '@shared/videoCode'

export type VideoResourceKindSelection = 'auto' | LinkVideoResourceKind

export interface VideoResourceDraft {
  url: string
  kind: VideoResourceKindSelection
  displayName: string
  size: string
  sizeUnit: VideoResourceSizeUnit
}

export function emptyVideoResourceDraft(): VideoResourceDraft {
  return { url: '', kind: 'auto', displayName: '', size: '', sizeUnit: 'GB' }
}

export function effectiveVideoResourceKind(
  selection: VideoResourceKindSelection,
  url: string
): ExternalVideoResourceKind {
  return selection === 'auto' ? inferVideoResourceKind(url) : selection
}

export function canProbeDirectResourceSize(
  selection: VideoResourceKindSelection,
  url: string
): boolean {
  return effectiveVideoResourceKind(selection, url) === 'direct'
}

export function formatVideoResourceLinkCheck(result: VideoResourceLinkCheckResult): string {
  if (!result.ok) return result.error ?? '未能读取大小；仍可导入。'
  const parts = ['直链有响应']
  if (result.status) parts.push(`HTTP ${result.status}`)
  if (result.sizeBytes) parts.push('已填入文件大小')
  return parts.join(' · ')
}

export function normalizeOptionalVideoCode(rawCode: string): string | null {
  if (!rawCode.trim()) return null
  return normalizeVideoCode(rawCode)
}

export function buildVideoResourceImportInput(input: {
  code: string
  url: string
  kind: VideoResourceKindSelection
  displayName: string
  size: string
  sizeUnit: VideoResourceSizeUnit
}): {
  code: string
  url: string
  kind: NonNullable<VideoLinkResourceImportInput['kind']>
  displayName: string | null
  sizeBytes: number | null
} {
  const code = normalizeVideoCode(input.code)
  const normalized = normalizeExternalVideoResource(
    input.url,
    input.kind === 'auto' ? undefined : input.kind
  )
  return {
    code,
    url: normalized.locator,
    kind: normalized.kind,
    displayName: input.displayName.trim() || normalized.suggestedDisplayName,
    sizeBytes: resourceSizeToBytes(input.size, input.sizeUnit)
  }
}

export function buildPlaybackResourceFields(
  input: VideoResourceDraft
): VideoLinkResourceFields | null {
  if (!input.url.trim()) return null
  const built = buildVideoResourceImportInput({
    code: 'PLACEHOLDER',
    url: input.url,
    kind: input.kind,
    displayName: input.displayName,
    size: input.size,
    sizeUnit: input.sizeUnit
  })
  return {
    url: built.url,
    kind: built.kind,
    displayName: built.displayName,
    sizeBytes: built.sizeBytes
  }
}

export function buildVideoManualImportInput(input: {
  code: string
  resources?: readonly VideoResourceDraft[]
  url?: string
  kind?: VideoResourceKindSelection
  displayName?: string
  size?: string
  sizeUnit?: VideoResourceSizeUnit
  links: readonly RelatedLinkInput[]
}): Omit<VideoLinkResourceImportInput, 'libraryId' | 'target'> {
  const drafts = input.resources ?? [
    {
      url: input.url ?? '',
      kind: input.kind ?? 'auto',
      displayName: input.displayName ?? '',
      size: input.size ?? '',
      sizeUnit: input.sizeUnit ?? 'GB'
    }
  ]
  const resources = drafts
    .map((draft) => buildPlaybackResourceFields(draft))
    .filter((item): item is VideoLinkResourceFields => item != null)
  const links = input.links
    .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
    .filter((link) => link.url)
  return {
    code: normalizeVideoCode(input.code),
    ...(resources.length ? { resources } : {}),
    ...(links.length ? { links } : {})
  }
}

export function resourceBytesToFormSize(bytes: number): {
  value: string
  unit: VideoResourceSizeUnit
} {
  const units: Array<[VideoResourceSizeUnit, number]> = [
    ['TB', 1024 ** 4],
    ['GB', 1024 ** 3],
    ['MB', 1024 ** 2]
  ]
  const [unit, factor] = units.find(([, divisor]) => bytes >= divisor) ?? units[2]
  return { value: String(Number((bytes / factor).toFixed(2))), unit }
}
