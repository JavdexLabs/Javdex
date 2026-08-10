import type {
  LinkVideoResourceKind,
  VideoLinkResourceImportInput,
  VideoResourceSizeUnit
} from '@shared/videoTypes'
import {
  inferHttpVideoResourceKind,
  normalizeHttpVideoResource,
  resourceSizeToBytes
} from '@shared/videoResourceLinks'

export type VideoResourceKindSelection = 'auto' | LinkVideoResourceKind

export function buildVideoResourceImportInput(input: {
  code: string
  url: string
  kind: VideoResourceKindSelection
  displayName: string
  size: string
  sizeUnit: VideoResourceSizeUnit
}): VideoLinkResourceImportInput {
  const code = input.code.trim()
  if (!code) throw new Error('请输入影片番号')
  const { locator } = normalizeHttpVideoResource(input.url)
  return {
    code,
    url: locator,
    kind: input.kind === 'auto' ? inferHttpVideoResourceKind(locator) : input.kind,
    displayName: input.displayName.trim() || null,
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
