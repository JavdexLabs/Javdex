import { normalizePrivacyModeScopes, type AppSettings } from '@shared/types'

export type PrivacyModeSettings = Pick<
  AppSettings,
  'privacyModeEnabled' | 'privacyModeScopes'
>

const PRIVACY_MODE_SNAPSHOT_KEY = 'privacyModeSnapshot'

const SCOPE_DATASET_KEYS = {
  covers: 'privacyCovers',
  videoSamples: 'privacyVideoSamples',
  actressGallery: 'privacyActressGallery'
} as const

/** Mirror persisted privacy settings onto the root element for display-only CSS protection. */
export function applyPrivacyMode(settings: PrivacyModeSettings): void {
  const root = document.documentElement
  const scopes = new Set(settings.privacyModeScopes)
  root.dataset.privacyMode = settings.privacyModeEnabled ? 'true' : 'false'
  for (const scope of Object.keys(SCOPE_DATASET_KEYS) as Array<
    keyof typeof SCOPE_DATASET_KEYS
  >) {
    const datasetKey = SCOPE_DATASET_KEYS[scope]
    root.dataset[datasetKey] = scopes.has(scope) ? 'true' : 'false'
  }
  try {
    localStorage.setItem(
      PRIVACY_MODE_SNAPSHOT_KEY,
      JSON.stringify({
        privacyModeEnabled: settings.privacyModeEnabled,
        privacyModeScopes: settings.privacyModeScopes
      } satisfies PrivacyModeSettings)
    )
  } catch {
    // The persisted main-process settings remain authoritative when storage is unavailable.
  }
}

export function readCachedPrivacyMode(): PrivacyModeSettings | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(PRIVACY_MODE_SNAPSHOT_KEY) ?? 'null') as
      | Partial<PrivacyModeSettings>
      | null
    if (!parsed || typeof parsed.privacyModeEnabled !== 'boolean') return null
    return {
      privacyModeEnabled: parsed.privacyModeEnabled,
      privacyModeScopes: normalizePrivacyModeScopes(parsed.privacyModeScopes)
    }
  } catch {
    return null
  }
}

/** Restore the last display state before React mounts to avoid exposing images during startup. */
export function restoreCachedPrivacyMode(): void {
  const cached = readCachedPrivacyMode()
  if (cached) applyPrivacyMode(cached)
}
