import type {
  LinkVideoResourceKind,
  VideoLinkResourceImportInput,
  VideoResourceSizeUnit
} from '@shared/videoTypes'
import {
  normalizeExternalVideoResource,
  resourceSizeToBytes
} from '@shared/videoResourceLinks'
import { normalizeVideoCode } from '@shared/videoCode'

export type VideoResourceKindSelection = 'auto' | LinkVideoResourceKind

export function buildVideoResourceImportInput(input: {
  code: string
  url: string
  kind: VideoResourceKindSelection
  displayName: string
  size: string
  sizeUnit: VideoResourceSizeUnit
}): VideoLinkResourceImportInput {
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
