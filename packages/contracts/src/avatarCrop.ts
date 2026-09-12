import { AVATAR_OUTPUT_SIZE, AVATAR_VIEW_SIZE } from './avatarCropConstants'

/** Persisted on actresses.avatar_crop_json */
export interface AvatarCropV1 {
  version: 1
  /** sha256(sourceBytes).slice(0, 16) */
  sourceFingerprint: string
  viewSize: number
  outputSize: number
  zoom: number
  offsetX: number
  offsetY: number
}

export type AvatarCropState = AvatarCropV1

export interface ActressAvatarCommit {
  /** 512 JPEG base64 (no data: prefix) */
  displayImageBase64: string
  crop: AvatarCropV1
  /** New source bytes (local file / blob export) */
  sourceImageBase64?: string
  /** Absolute filesystem path for a new local source */
  sourceLocalPath?: string
  /** Existing library-relative asset to copy as the new source */
  sourceAssetPath?: string
}

export function createAvatarCropV1(input: {
  sourceFingerprint: string
  zoom: number
  offsetX: number
  offsetY: number
  viewSize?: number
  outputSize?: number
}): AvatarCropV1 {
  return {
    version: 1,
    sourceFingerprint: input.sourceFingerprint,
    viewSize: input.viewSize ?? AVATAR_VIEW_SIZE,
    outputSize: input.outputSize ?? AVATAR_OUTPUT_SIZE,
    zoom: input.zoom,
    offsetX: input.offsetX,
    offsetY: input.offsetY
  }
}

/** Parse and validate crop JSON; returns null when unusable for the given source. */
export function parseAvatarCrop(
  json: string | null | undefined,
  sourceFingerprint?: string | null
): AvatarCropV1 | null {
  if (!json?.trim()) return null
  try {
    const raw = JSON.parse(json) as Partial<AvatarCropV1>
    if (raw.version !== 1) return null
    if (typeof raw.sourceFingerprint !== 'string' || !raw.sourceFingerprint.trim()) return null
    if (sourceFingerprint && raw.sourceFingerprint !== sourceFingerprint) return null
    if (typeof raw.viewSize !== 'number' || !(raw.viewSize > 0)) return null
    if (typeof raw.outputSize !== 'number' || !(raw.outputSize > 0)) return null
    if (typeof raw.zoom !== 'number' || !(raw.zoom > 0)) return null
    if (typeof raw.offsetX !== 'number' || !Number.isFinite(raw.offsetX)) return null
    if (typeof raw.offsetY !== 'number' || !Number.isFinite(raw.offsetY)) return null
    return {
      version: 1,
      sourceFingerprint: raw.sourceFingerprint,
      viewSize: raw.viewSize,
      outputSize: raw.outputSize,
      zoom: raw.zoom,
      offsetX: raw.offsetX,
      offsetY: raw.offsetY
    }
  } catch {
    return null
  }
}

/** Scale offsets when the editor viewport size changes. */
export function scaleAvatarCropToViewSize(
  crop: AvatarCropV1,
  nextViewSize: number
): AvatarCropV1 {
  if (crop.viewSize === nextViewSize) return crop
  const ratio = nextViewSize / crop.viewSize
  return {
    ...crop,
    viewSize: nextViewSize,
    offsetX: crop.offsetX * ratio,
    offsetY: crop.offsetY * ratio
  }
}
