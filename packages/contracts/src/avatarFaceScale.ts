export const AVATAR_FACE_SCALE_PRESETS = ['close', 'standard', 'loose'] as const

export type AvatarFaceScalePreset = (typeof AVATAR_FACE_SCALE_PRESETS)[number]

export const DEFAULT_AVATAR_FACE_SCALE_PRESET: AvatarFaceScalePreset = 'standard'

export const MIN_AVATAR_FACE_RATIO = 0.5
export const MAX_AVATAR_FACE_RATIO = 0.75
export const DEFAULT_AVATAR_FACE_RATIO = MIN_AVATAR_FACE_RATIO

// Geometry calibration remains based on the original 70% reference. Keeping
// this separate lets the product default change without changing crop math.
const AVATAR_FACE_SCALE_REFERENCE_RATIO = 0.7

export const AVATAR_FACE_OVAL_HEIGHT_RATIO: Record<AvatarFaceScalePreset, number> = {
  close: 0.76,
  standard: 0.7,
  loose: 0.64
}

export function normalizeAvatarFaceScalePreset(value: unknown): AvatarFaceScalePreset {
  return AVATAR_FACE_SCALE_PRESETS.includes(value as AvatarFaceScalePreset)
    ? (value as AvatarFaceScalePreset)
    : DEFAULT_AVATAR_FACE_SCALE_PRESET
}

export function normalizeAvatarFaceRatio(
  value: unknown,
  fallback = DEFAULT_AVATAR_FACE_RATIO
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN
  const normalizedFallback = Math.min(
    MAX_AVATAR_FACE_RATIO,
    Math.max(MIN_AVATAR_FACE_RATIO, fallback)
  )
  if (!Number.isFinite(parsed)) return normalizedFallback
  const clamped = Math.min(MAX_AVATAR_FACE_RATIO, Math.max(MIN_AVATAR_FACE_RATIO, parsed))
  return Math.round(clamped * 100) / 100
}

export function getAvatarFaceScaleFactor(faceRatio: number): number {
  return normalizeAvatarFaceRatio(faceRatio) / AVATAR_FACE_SCALE_REFERENCE_RATIO
}
