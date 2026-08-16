import { DEFAULT_AVATAR_FACE_RATIO, DEFAULT_AVATAR_FACE_SCALE_PRESET, type AvatarFaceScalePreset } from './avatarFaceScale'
import { DEFAULT_AVATAR_CENTERING_MODE, type AvatarCenteringMode } from './avatarCentering'
import type { CompositeScraperDefinition, ScraperPluginDelaySettings } from './scraperPluginTypes'
import type { LibraryScanSummary } from './libraryTypes'
import {
  DEFAULT_SCRAPER_SERVICE_CONFIGS,
  type ScraperServiceConfigs
} from './scraperServiceTypes'

/** UI color theme id (maps to CSS variables on html[data-theme]). */
export type ThemeId = 'graphite' | 'warm' | 'slate' | 'light'

const VALID_THEMES: ThemeId[] = ['graphite', 'warm', 'slate', 'light']

export function normalizeTheme(value: unknown): ThemeId {
  return VALID_THEMES.includes(value as ThemeId) ? (value as ThemeId) : 'graphite'
}

export const COVER_DISPLAY_MODES = ['portrait', 'landscape'] as const

export type CoverDisplayMode = (typeof COVER_DISPLAY_MODES)[number]

export function normalizeCoverDisplayMode(value: unknown): CoverDisplayMode {
  return value === 'landscape' ? 'landscape' : 'portrait'
}

export const PRIVACY_MODE_SCOPES = [
  'covers',
  'videoSamples',
  'actressGallery',
  'actressDefaultAvatar',
  'imagePreview',
  'mediaEditors',
  'globalBackground'
] as const

export type PrivacyModeScope = (typeof PRIVACY_MODE_SCOPES)[number]

export const AUTO_SCAN_INTERVAL_MINUTES = [15, 30, 60, 180, 360] as const

export type AutoScanIntervalMinutes = (typeof AUTO_SCAN_INTERVAL_MINUTES)[number]

export function normalizeAutoScanIntervalMinutes(value: unknown): AutoScanIntervalMinutes {
  const parsed = typeof value === 'number' ? value : Number(value)
  return AUTO_SCAN_INTERVAL_MINUTES.includes(parsed as AutoScanIntervalMinutes)
    ? (parsed as AutoScanIntervalMinutes)
    : 60
}

export function normalizePrivacyModeScopes(value: unknown): PrivacyModeScope[] {
  if (!Array.isArray(value)) return [...PRIVACY_MODE_SCOPES]
  const validScopes = new Set<unknown>(PRIVACY_MODE_SCOPES)
  return Array.from(
    new Set(value.filter((scope): scope is PrivacyModeScope => validScopes.has(scope)))
  )
}

export interface AppSettings {
  /** Folders to scan for media files. */
  libraryPaths: string[]
  /** Internal queue: roots whose local resource records are removed after the next successful scan. */
  pendingLibraryPathCleanups: string[]
  /** Opt-in destructive cleanup run only after a safe full library scan. */
  autoDeleteResourceLessVideos: boolean
  /** Run a full library scan in the background when the configured interval is due. */
  autoScanEnabled: boolean
  /** Minimum elapsed minutes between automatic full-library scans. */
  autoScanIntervalMinutes: AutoScanIntervalMinutes
  /** Most recent scan audit record. */
  lastLibraryScanSummary: LibraryScanSummary | null
  /** Minimum local file duration (minutes) required for scan import; 0 disables the filter. */
  minScanImportDurationMinutes: number
  /** Automatically attach scanned resources when their normalized code has one clear owner. */
  autoMergeSameCodeResources: boolean
  /** Optional HTTP/HTTPS proxy for scraping, e.g. http://127.0.0.1:7890 */
  proxyUrl: string
  /** When false, scrape requests use a direct connection even if proxyUrl is set. */
  proxyUrlEnabled: boolean
  /** Optional HTTP/HTTPS proxy for LLM API requests. */
  llmProxyUrl: string
  /** When false, LLM requests use a direct connection even if llmProxyUrl is set. */
  llmProxyUrlEnabled: boolean
  /** Default video metadata scraper plugin name. */
  defaultScraper: string
  /** Default actress profile scraper plugin name. */
  defaultActressScraper: string
  /** Min/max delay (ms) between batch scrape tasks to avoid anti-crawling. */
  batchDelayMinMs: number
  batchDelayMaxMs: number
  /** Interface color theme. */
  theme: ThemeId
  /** Apply display-only anti-peep protection to selected UI surfaces and interactions. */
  privacyModeEnabled: boolean
  /** UI surfaces and interactions protected while anti-peep mode is enabled. */
  privacyModeScopes: PrivacyModeScope[]
  /** Default face size used by local smart avatar composition. */
  avatarFaceRatio: number
  /** @deprecated Retained to migrate settings written before the continuous face-ratio control. */
  avatarFaceScalePreset: AvatarFaceScalePreset
  /** Default anchor used by local smart avatar composition. */
  avatarCenteringMode: AvatarCenteringMode
  /** Keep detected hair crown and chin inside the avatar crop. */
  avatarPreserveFullHead: boolean
  /** Display-only: use first local sample as video detail background when no poster is set. */
  videoDetailUseFirstSampleBackground: boolean
  /** Display-only: use first local gallery photo as actress detail background when no poster is set. */
  actressDetailUseFirstGalleryBackground: boolean
  /** Display compact resource-kind badges on every video card. */
  showVideoResourceTypeBadges: boolean
  /** Media-library video cards use portrait posters or landscape covers. */
  coverDisplayMode: CoverDisplayMode
  /** Encrypt cover/avatar files on disk as .enc blobs. */
  assetEncryption: boolean
  /** Custom folder for cover/avatar storage; empty uses default userData/media_assets. */
  mediaAssetsPath: string
  /** Per scraper random interval ranges used by batch scraping. */
  scraperPluginDelays: ScraperPluginDelaySettings
  /** Non-secret configuration for trusted scraper services. */
  scraperServiceConfigs: ScraperServiceConfigs
  /** Field-level virtual scraper definitions. */
  compositeScrapers: {
    video: CompositeScraperDefinition[]
    actress: CompositeScraperDefinition[]
  }
  /** Default LLM provider id for agent and verification flows. */
  defaultLlmProviderId: string
  /** Default model id under {@link defaultLlmProviderId}. */
  defaultLlmModelId: string
  /** Non-secret per-provider protocol and optional base URL overrides. */
  llmProviderConfigs: Record<string, import('./llmProviders').LlmProviderUserConfig>
  /** User-defined LLM providers. */
  customLlmProviders: import('./llmProviders').CustomLlmProviderDefinition[]
  /** User-added models keyed by provider id. */
  llmCustomModels: import('./llmProviders').LlmCustomModelDefinition[]
  /** Max agent ReAct steps; 0 means unlimited. */
  pluginDevAgentMaxSteps: number
  /** Max estimated input context tokens for plugin development agent. */
  pluginDevAgentMaxContextTokens: number
}

export interface SettingsRecoveryNotice {
  backupFileName: string
  message: string
}

export interface LlmSecretStorageState {
  protection: 'secure' | 'degraded' | 'unavailable'
  backend: string
  migrationError?: string
}

export type SettingsSnapshot = Omit<AppSettings, 'llmProviderConfigs'> & {
  llmProviderConfigs: Record<string, import('./llmProviders').LlmProviderPublicConfig>
  mediaAssetsResolvedPath: string
  recoveryNotice: SettingsRecoveryNotice | null
  llmSecretStorage: LlmSecretStorageState
}

export type RendererSettingsPatch = Partial<
  Omit<
    AppSettings,
    | 'assetEncryption'
    | 'lastLibraryScanSummary'
    | 'llmProviderConfigs'
    | 'mediaAssetsPath'
    | 'pendingLibraryPathCleanups'
    | 'scraperServiceConfigs'
  >
>

export function normalizeMinScanImportDurationMinutes(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SETTINGS.minScanImportDurationMinutes
  return Math.min(600, Math.round(parsed))
}

export function normalizePluginDevAgentMaxSteps(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : 0
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.min(500, Math.round(parsed))
}

export function normalizePluginDevAgentMaxContextTokens(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : 128000
  if (!Number.isFinite(parsed) || parsed <= 0) return 128000
  return Math.min(512000, Math.max(8000, Math.round(parsed)))
}

export const DEFAULT_SETTINGS: AppSettings = {
  libraryPaths: [],
  pendingLibraryPathCleanups: [],
  autoDeleteResourceLessVideos: false,
  autoScanEnabled: false,
  autoScanIntervalMinutes: 60,
  lastLibraryScanSummary: null,
  minScanImportDurationMinutes: 30,
  autoMergeSameCodeResources: true,
  proxyUrl: '',
  proxyUrlEnabled: false,
  llmProxyUrl: '',
  llmProxyUrlEnabled: false,
  defaultScraper: 'JavDB',
  defaultActressScraper: 'Xslist',
  batchDelayMinMs: 3000,
  batchDelayMaxMs: 5000,
  theme: 'graphite',
  privacyModeEnabled: false,
  privacyModeScopes: [...PRIVACY_MODE_SCOPES],
  avatarFaceRatio: DEFAULT_AVATAR_FACE_RATIO,
  avatarFaceScalePreset: DEFAULT_AVATAR_FACE_SCALE_PRESET,
  avatarCenteringMode: DEFAULT_AVATAR_CENTERING_MODE,
  avatarPreserveFullHead: false,
  videoDetailUseFirstSampleBackground: false,
  actressDetailUseFirstGalleryBackground: true,
  showVideoResourceTypeBadges: false,
  coverDisplayMode: 'portrait',
  assetEncryption: false,
  mediaAssetsPath: '',
  scraperPluginDelays: {
    video: {},
    actress: {}
  },
  scraperServiceConfigs: {
    metatube: { ...DEFAULT_SCRAPER_SERVICE_CONFIGS.metatube }
  },
  compositeScrapers: {
    video: [],
    actress: []
  },
  defaultLlmProviderId: '',
  defaultLlmModelId: '',
  llmProviderConfigs: {},
  customLlmProviders: [],
  llmCustomModels: [],
  pluginDevAgentMaxSteps: 0,
  pluginDevAgentMaxContextTokens: 128000
}

export function resolveScrapeProxyUrl(
  settings: Pick<AppSettings, 'proxyUrl' | 'proxyUrlEnabled'>
): string {
  return settings.proxyUrlEnabled && settings.proxyUrl.trim() ? settings.proxyUrl.trim() : ''
}

export function resolveLlmProxyUrl(
  settings: Pick<AppSettings, 'llmProxyUrl' | 'llmProxyUrlEnabled'>
): string {
  return settings.llmProxyUrlEnabled && settings.llmProxyUrl.trim() ? settings.llmProxyUrl.trim() : ''
}
