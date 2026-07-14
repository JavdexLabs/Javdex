export const AVATAR_CENTERING_MODES = ['face', 'head'] as const

export type AvatarCenteringMode = (typeof AVATAR_CENTERING_MODES)[number]

export const DEFAULT_AVATAR_CENTERING_MODE: AvatarCenteringMode = 'face'

export function normalizeAvatarCenteringMode(value: unknown): AvatarCenteringMode {
  return AVATAR_CENTERING_MODES.includes(value as AvatarCenteringMode)
    ? (value as AvatarCenteringMode)
    : DEFAULT_AVATAR_CENTERING_MODE
}
