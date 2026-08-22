import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import process from 'node:process'
import { DEFAULT_SETTINGS, normalizeAutoScanIntervalMinutes, normalizeCoverDisplayMode, normalizePluginDevAgentMaxContextTokens, normalizePluginDevAgentMaxTurns, normalizePrivacyModeScopes, normalizeTheme, normalizeMinScanImportDurationMinutes, type AppSettings, type SettingsRecoveryNotice } from '@shared/settingsTypes'
import { expandActressScrapeFields, type CompositeScraperDefinition, type ScraperPluginDelaySettings } from '@shared/scrapeTypes'
import {
  BUILT_IN_LLM_PROVIDER_BY_ID,
  isReservedLlmProviderId,
  isValidCustomLlmProviderId,
  normalizeDefaultLlmSelection,
  type CustomLlmProviderDefinition,
  type LlmCustomModelDefinition,
  type LlmProviderPublicConfig,
  type LlmProviderProtocol,
  type LlmProviderUserConfig
} from '@shared/llmProviders'
import { readTestUserDataPath } from '@shared/appIdentity'
import {
  AVATAR_FACE_SCALE_PRESETS,
  AVATAR_FACE_OVAL_HEIGHT_RATIO,
  normalizeAvatarFaceRatio,
  normalizeAvatarFaceScalePreset
} from '@shared/avatarFaceScale'
import { normalizeAvatarCenteringMode } from '@shared/avatarCentering'
import { normalizeLibraryScanSummary } from '@shared/libraryScanSummary'
import { normalizeScraperServiceConfigs } from '@shared/scraperServiceTypes'
import {
  getLlmApiKey,
  hasLlmApiKey,
  resetLlmSecretStoreForTests,
  saveLlmApiKeys
} from './llmSecretStore'
import { resetScraperServiceSecretStoreForTests } from './scraperServiceSecretStore'

let cache: AppSettings | null = null
let recoveryNotice: SettingsRecoveryNotice | null = null
let recoveryBackupPath: string | null = null
let llmSecretMigrationError: string | undefined
let legacyLlmApiKeys: Record<string, string> = {}

function settingsFilePath(): string {
  const userData = app?.getPath ? app.getPath('userData') : readTestUserDataPath()
  if (!userData) throw new Error('Electron app userData path is unavailable')
  return path.join(userData, 'settings.json')
}

/** Test-only: clear in-memory settings cache between isolated runs. */
export function resetSettingsCacheForTests(): void {
  cache = null
  recoveryNotice = null
  recoveryBackupPath = null
  llmSecretMigrationError = undefined
  legacyLlmApiKeys = {}
  resetLlmSecretStoreForTests()
  resetScraperServiceSecretStoreForTests()
}

export function getSettings(): AppSettings {
  if (cache) return cache
  const file = settingsFilePath()
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = normalizeSettings({})
      return cache
    }
    throw new Error(`读取设置失败：${(error as Error).message}`)
  }

  let parsed: ParsedSettings
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('设置文件根节点必须是对象')
    }
    parsed = value as ParsedSettings
  } catch (error) {
    cache = recoverCorruptSettings(file, error)
    return cache
  }

  legacyLlmApiKeys = extractLegacyLlmApiKeys(parsed.llmProviderConfigs)
  if (Object.keys(legacyLlmApiKeys).length > 0) {
    try {
      saveLlmApiKeys(legacyLlmApiKeys)
      cache = normalizeSettings(parsed)
      writeSettingsFile(cache)
      legacyLlmApiKeys = {}
    } catch (error) {
      llmSecretMigrationError = `旧版 API Key 迁移失败：${(error as Error).message}`
      cache = normalizeSettings(parsed)
    }
  } else {
    cache = normalizeSettings(parsed)
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const next = normalizeSettings({
    ...current,
    ...patch,
    ...(patch.theme !== undefined ? { theme: normalizeTheme(patch.theme) } : {})
  })
  ensureLegacyLlmSecretsMigrated()
  writeSettingsFile(next)
  cache = next
  return next
}

function writeSettingsFile(settings: AppSettings): void {
  const file = settingsFilePath()
  const temporaryFile = `${file}.tmp-${process.pid}`
  const persisted = shouldPersistLegacyLlmMigrationInputs()
    ? settings
    : omitLegacyLlmSettings(settings)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporaryFile, JSON.stringify(persisted, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    fs.renameSync(temporaryFile, file)
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
  } catch (err) {
    try {
      fs.rmSync(temporaryFile, { force: true })
    } catch {
      // Preserve the original persistence error.
    }
    throw new Error(`保存设置失败：${(err as Error).message}`)
  }
}

function shouldPersistLegacyLlmMigrationInputs(): boolean {
  const configFile = path.join(path.dirname(settingsFilePath()), 'ai-configuration.json')
  try {
    const value = JSON.parse(fs.readFileSync(configFile, 'utf8')) as { schemaVersion?: unknown }
    return value.schemaVersion === 2
  } catch (error) {
    // A missing file still needs the migration inputs. Any existing unreadable/unknown document is
    // fail-closed and must not cause retired model settings to be written again.
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function omitLegacyLlmSettings(settings: AppSettings): Omit<
  AppSettings,
  | 'defaultLlmProviderId'
  | 'defaultLlmModelId'
  | 'llmProviderConfigs'
  | 'customLlmProviders'
  | 'llmCustomModels'
  | 'pluginDevAgentMaxTurns'
  | 'pluginDevAgentMaxContextTokens'
> {
  const {
    defaultLlmProviderId: _defaultLlmProviderId,
    defaultLlmModelId: _defaultLlmModelId,
    llmProviderConfigs: _llmProviderConfigs,
    customLlmProviders: _customLlmProviders,
    llmCustomModels: _llmCustomModels,
    pluginDevAgentMaxTurns: _pluginDevAgentMaxTurns,
    pluginDevAgentMaxContextTokens: _pluginDevAgentMaxContextTokens,
    ...persisted
  } = settings
  return persisted
}

function recoverCorruptSettings(file: string, cause: unknown): AppSettings {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = path.join(path.dirname(file), `settings.corrupt-${stamp}.json`)
  try {
    fs.renameSync(file, backup)
    const defaults = normalizeSettings({})
    writeSettingsFile(defaults)
    recoveryBackupPath = backup
    recoveryNotice = {
      backupFileName: path.basename(backup),
      message: `设置文件损坏，已恢复默认设置：${(cause as Error).message}`
    }
    return defaults
  } catch (error) {
    throw new Error(`恢复损坏设置失败：${(error as Error).message}`)
  }
}

function extractLegacyLlmApiKeys(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const entries: Record<string, string> = {}
  for (const [rawProviderId, rawConfig] of Object.entries(value as Record<string, unknown>)) {
    if (!rawConfig || typeof rawConfig !== 'object') continue
    const apiKey = (rawConfig as { apiKey?: unknown }).apiKey
    if (typeof apiKey !== 'string' || !apiKey.trim()) continue
    const providerId = rawProviderId.trim()
    if (providerId) entries[providerId] = apiKey.trim()
  }
  return entries
}

function ensureLegacyLlmSecretsMigrated(): void {
  if (Object.keys(legacyLlmApiKeys).length === 0) return
  try {
    saveLlmApiKeys(legacyLlmApiKeys)
    legacyLlmApiKeys = {}
    llmSecretMigrationError = undefined
  } catch (error) {
    throw new Error(`无法安全迁移旧版 API Key：${(error as Error).message}`)
  }
}

export function getEffectiveLlmApiKey(providerId: string): string {
  const stored = getLlmApiKey(providerId)
  return stored || legacyLlmApiKeys[providerId.trim()] || ''
}

function hasEffectiveLlmApiKey(providerId: string): boolean {
  return hasLlmApiKey(providerId) || Boolean(legacyLlmApiKeys[providerId.trim()])
}

export function getPublicLlmProviderConfigs(
  settings: AppSettings
): Record<string, LlmProviderPublicConfig> {
  return publicLlmProviderConfigs(settings.llmProviderConfigs, settings.customLlmProviders)
}

function publicLlmProviderConfigs(
  configs: Record<string, LlmProviderUserConfig>,
  customProviders: CustomLlmProviderDefinition[]
): Record<string, LlmProviderPublicConfig> {
  const providerIds = new Set([
    ...BUILT_IN_LLM_PROVIDER_BY_ID.keys(),
    ...Object.keys(configs),
    ...customProviders.map((provider) => provider.id),
    ...Object.keys(legacyLlmApiKeys)
  ])
  return Object.fromEntries(
    [...providerIds].map((providerId) => [
      providerId,
      {
        ...configs[providerId],
        hasApiKey: hasEffectiveLlmApiKey(providerId)
      }
    ])
  )
}

export function getSettingsRecoveryNotice(): SettingsRecoveryNotice | null {
  return recoveryNotice
}

export function getSettingsRecoveryBackupPath(): string | null {
  return recoveryBackupPath
}

export function getLlmSecretMigrationError(): string | undefined {
  return llmSecretMigrationError
}

/**
 * Replace settings that still point at the retired bundled JAV8 scraper.
 * Run this after legacy same-name user plugins have been renamed so their
 * references can follow the user plugin instead of being mistaken for the
 * retired bundled scraper.
 */
export function migrateRetiredVideoScraperSettings(): void {
  const retiredName = 'JAV8'
  const settings = getSettings()
  const defaultScraper =
    settings.defaultScraper === retiredName
      ? DEFAULT_SETTINGS.defaultScraper
      : settings.defaultScraper
  const videoDelays = Object.fromEntries(
    Object.entries(settings.scraperPluginDelays.video).filter(([name]) => name !== retiredName)
  )
  const videoComposites = settings.compositeScrapers.video.map((item) => ({
    ...item,
    fieldPluginMap: Object.fromEntries(
      Object.entries(item.fieldPluginMap).map(([field, pluginName]) => [
        field,
        pluginName === retiredName ? DEFAULT_SETTINGS.defaultScraper : pluginName
      ])
    ) as typeof item.fieldPluginMap
  }))
  const hasRetiredReference =
    settings.defaultScraper === retiredName ||
    Object.prototype.hasOwnProperty.call(settings.scraperPluginDelays.video, retiredName) ||
    settings.compositeScrapers.video.some((item) =>
      Object.values(item.fieldPluginMap).includes(retiredName)
    )
  if (!hasRetiredReference) return

  updateSettings({
    defaultScraper,
    scraperPluginDelays: {
      ...settings.scraperPluginDelays,
      video: videoDelays
    },
    compositeScrapers: {
      ...settings.compositeScrapers,
      video: videoComposites
    }
  })
}

type ParsedSettings = Partial<AppSettings> & {
  /** Retired hidden default; it was never a user-configurable turn budget. */
  pluginDevAgentMaxSteps?: unknown
}

function normalizeSettings(parsed: ParsedSettings): AppSettings {
  const { pluginDevAgentMaxSteps: _retiredPluginDevAgentMaxSteps, ...currentSettings } = parsed
  const scraperServiceConfigs = normalizeScraperServiceConfigs(parsed.scraperServiceConfigs)
  const requestedDefaultScraper =
    typeof parsed.defaultScraper === 'string' && parsed.defaultScraper.trim()
      ? parsed.defaultScraper.trim()
      : DEFAULT_SETTINGS.defaultScraper
  const defaultScraper =
    requestedDefaultScraper === 'MetaTube' && !scraperServiceConfigs.metatube.serverUrl
      ? DEFAULT_SETTINGS.defaultScraper
      : requestedDefaultScraper
  const rawDefaultActressScraper =
    typeof parsed.defaultActressScraper === 'string' && parsed.defaultActressScraper.trim()
      ? parsed.defaultActressScraper.trim()
      : DEFAULT_SETTINGS.defaultActressScraper
  // Retired bundled actress scraper; keep existing installs pointed at a valid default.
  const defaultActressScraper =
    rawDefaultActressScraper === '偶像档案库'
      ? DEFAULT_SETTINGS.defaultActressScraper
      : rawDefaultActressScraper
  const legacyAvatarFaceScalePreset = normalizeAvatarFaceScalePreset(
    parsed.avatarFaceScalePreset
  )
  const hasLegacyAvatarFaceScalePreset = AVATAR_FACE_SCALE_PRESETS.includes(
    parsed.avatarFaceScalePreset as (typeof AVATAR_FACE_SCALE_PRESETS)[number]
  )
  const llm = normalizeLlmSettings(parsed)
  return {
    ...DEFAULT_SETTINGS,
    ...currentSettings,
    defaultScraper,
    defaultActressScraper,
    theme: normalizeTheme(parsed.theme),
    privacyModeEnabled: normalizeBooleanSetting(
      parsed.privacyModeEnabled,
      DEFAULT_SETTINGS.privacyModeEnabled
    ),
    privacyModeScopes: normalizePrivacyModeScopes(parsed.privacyModeScopes),
    avatarFaceRatio: normalizeAvatarFaceRatio(
      parsed.avatarFaceRatio,
      hasLegacyAvatarFaceScalePreset
        ? AVATAR_FACE_OVAL_HEIGHT_RATIO[legacyAvatarFaceScalePreset]
        : DEFAULT_SETTINGS.avatarFaceRatio
    ),
    avatarFaceScalePreset: legacyAvatarFaceScalePreset,
    avatarCenteringMode: normalizeAvatarCenteringMode(parsed.avatarCenteringMode),
    avatarPreserveFullHead: normalizeBooleanSetting(
      parsed.avatarPreserveFullHead,
      DEFAULT_SETTINGS.avatarPreserveFullHead
    ),
    videoDetailUseFirstSampleBackground: normalizeBooleanSetting(
      parsed.videoDetailUseFirstSampleBackground,
      DEFAULT_SETTINGS.videoDetailUseFirstSampleBackground
    ),
    actressDetailUseFirstGalleryBackground: normalizeBooleanSetting(
      parsed.actressDetailUseFirstGalleryBackground,
      DEFAULT_SETTINGS.actressDetailUseFirstGalleryBackground
    ),
    showVideoResourceTypeBadges: normalizeBooleanSetting(
      parsed.showVideoResourceTypeBadges,
      DEFAULT_SETTINGS.showVideoResourceTypeBadges
    ),
    coverDisplayMode: normalizeCoverDisplayMode(parsed.coverDisplayMode),
    pendingLibraryPathCleanups: normalizeStringList(parsed.pendingLibraryPathCleanups),
    autoDeleteResourceLessVideos: normalizeBooleanSetting(
      parsed.autoDeleteResourceLessVideos,
      DEFAULT_SETTINGS.autoDeleteResourceLessVideos
    ),
    autoScanEnabled: normalizeBooleanSetting(
      parsed.autoScanEnabled,
      DEFAULT_SETTINGS.autoScanEnabled
    ),
    autoScanIntervalMinutes: normalizeAutoScanIntervalMinutes(
      parsed.autoScanIntervalMinutes
    ),
    lastLibraryScanSummary: normalizeLibraryScanSummary(parsed.lastLibraryScanSummary),
    mediaAssetsPath:
      typeof parsed.mediaAssetsPath === 'string' ? parsed.mediaAssetsPath.trim() : '',
    minScanImportDurationMinutes: normalizeMinScanImportDurationMinutes(
      parsed.minScanImportDurationMinutes
    ),
    autoMergeSameCodeResources: normalizeBooleanSetting(
      parsed.autoMergeSameCodeResources,
      DEFAULT_SETTINGS.autoMergeSameCodeResources
    ),
    proxyUrl: typeof parsed.proxyUrl === 'string' ? parsed.proxyUrl.trim() : '',
    proxyUrlEnabled: normalizeBooleanSetting(
      parsed.proxyUrlEnabled,
      typeof parsed.proxyUrl === 'string' && parsed.proxyUrl.trim()
        ? true
        : DEFAULT_SETTINGS.proxyUrlEnabled
    ),
    llmProxyUrl: typeof parsed.llmProxyUrl === 'string' ? parsed.llmProxyUrl.trim() : '',
    llmProxyUrlEnabled: normalizeBooleanSetting(
      parsed.llmProxyUrlEnabled,
      typeof parsed.llmProxyUrl === 'string' && parsed.llmProxyUrl.trim()
        ? true
        : DEFAULT_SETTINGS.llmProxyUrlEnabled
    ),
    ...llm,
    pluginDevAgentMaxTurns: normalizePluginDevAgentMaxTurns(parsed.pluginDevAgentMaxTurns),
    pluginDevAgentMaxContextTokens: normalizePluginDevAgentMaxContextTokens(
      parsed.pluginDevAgentMaxContextTokens
    ),
    scraperPluginDelays: normalizeDelaySettings(parsed.scraperPluginDelays),
    scraperServiceConfigs,
    compositeScrapers: {
      video: normalizeCompositeScrapers(parsed.compositeScrapers?.video, 'video'),
      actress: normalizeCompositeScrapers(parsed.compositeScrapers?.actress, 'actress')
    }
  }
}

function normalizeBooleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  )
}

function normalizeLlmSettings(parsed: ParsedSettings): Pick<
  AppSettings,
  | 'defaultLlmProviderId'
  | 'defaultLlmModelId'
  | 'llmProviderConfigs'
  | 'customLlmProviders'
  | 'llmCustomModels'
> {
  const llmProviderConfigs = normalizeLlmProviderConfigs(parsed.llmProviderConfigs)
  const customLlmProviders = normalizeCustomLlmProviders(parsed.customLlmProviders)
  const llmCustomModels = normalizeLlmCustomModels(parsed.llmCustomModels, customLlmProviders)

  let defaultLlmProviderId =
    typeof parsed.defaultLlmProviderId === 'string' && parsed.defaultLlmProviderId.trim()
      ? parsed.defaultLlmProviderId.trim()
      : DEFAULT_SETTINGS.defaultLlmProviderId
  let defaultLlmModelId =
    typeof parsed.defaultLlmModelId === 'string' && parsed.defaultLlmModelId.trim()
      ? parsed.defaultLlmModelId.trim()
      : DEFAULT_SETTINGS.defaultLlmModelId

  const normalized = normalizeDefaultLlmSelection({
    defaultLlmProviderId,
    defaultLlmModelId,
    llmProviderConfigs: publicLlmProviderConfigs(llmProviderConfigs, customLlmProviders),
    customLlmProviders,
    llmCustomModels
  })
  defaultLlmProviderId = normalized.providerId
  defaultLlmModelId = normalized.modelId

  return {
    defaultLlmProviderId,
    defaultLlmModelId,
    llmProviderConfigs,
    customLlmProviders,
    llmCustomModels
  }
}

function normalizeLlmProviderConfigs(
  value: unknown
): Record<string, LlmProviderUserConfig> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, LlmProviderUserConfig> = {}
  for (const [providerId, config] of Object.entries(value as Record<string, unknown>)) {
    if (!providerId.trim() || !config || typeof config !== 'object') continue
    const item = config as { baseUrl?: unknown; protocol?: unknown }
    const baseUrl = typeof item.baseUrl === 'string' ? item.baseUrl.trim() : undefined
    const protocol = normalizeLlmProviderProtocol(item.protocol)
    if (!baseUrl && !protocol) continue
    out[providerId.trim()] = {
      ...(baseUrl ? { baseUrl } : {}),
      ...(protocol ? { protocol } : {})
    }
  }
  return out
}

function normalizeLlmProviderProtocol(value: unknown): LlmProviderProtocol | undefined {
  if (value === 'openai-chat' || value === 'anthropic-messages') return value
  return undefined
}

function normalizeCustomLlmProviders(value: unknown): CustomLlmProviderDefinition[] {
  if (!Array.isArray(value)) return []
  const out: CustomLlmProviderDefinition[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const input = item as Partial<CustomLlmProviderDefinition>
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
    const protocol = input.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-chat'
    if (!isValidCustomLlmProviderId(id) || isReservedLlmProviderId(id) || seen.has(id)) continue
    if (!name || !baseUrl) continue
    seen.add(id)
    out.push({ id, name, protocol, baseUrl })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

function normalizeLlmCustomModels(
  value: unknown,
  customProviders: CustomLlmProviderDefinition[]
): LlmCustomModelDefinition[] {
  if (!Array.isArray(value)) return []
  const allowed = new Set([
    ...BUILT_IN_LLM_PROVIDER_BY_ID.keys(),
    ...customProviders.map((provider) => provider.id)
  ])
  const out: LlmCustomModelDefinition[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const input = item as Partial<LlmCustomModelDefinition>
    const providerId = typeof input.providerId === 'string' ? input.providerId.trim() : ''
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!providerId || !id || !allowed.has(providerId)) continue
    const key = `${providerId}::${id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ providerId, id, name: name || id })
  }
  return out
}

function normalizeDelaySettings(value: unknown): ScraperPluginDelaySettings {
  const input = value && typeof value === 'object' ? (value as Partial<ScraperPluginDelaySettings>) : {}
  return {
    video: normalizeDelayMap(input.video),
    actress: normalizeDelayMap(input.actress)
  }
}

function normalizeDelayMap(value: unknown): ScraperPluginDelaySettings['video'] {
  if (!value || typeof value !== 'object') return {}
  const out: ScraperPluginDelaySettings['video'] = {}
  for (const [name, delay] of Object.entries(value as Record<string, unknown>)) {
    if (!delay || typeof delay !== 'object') continue
    const item = delay as { minMs?: unknown; maxMs?: unknown }
    const minMs = typeof item.minMs === 'number' && Number.isFinite(item.minMs) ? item.minMs : 3000
    const maxMs = typeof item.maxMs === 'number' && Number.isFinite(item.maxMs) ? item.maxMs : 5000
    out[name] = {
      minMs: Math.max(0, Math.round(minMs)),
      maxMs: Math.max(0, Math.round(Math.max(minMs, maxMs)))
    }
  }
  return out
}

function normalizeCompositeScrapers(
  value: unknown,
  kind: CompositeScraperDefinition['kind']
): CompositeScraperDefinition[] {
  if (!Array.isArray(value)) return []
  const out: CompositeScraperDefinition[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const input = item as Partial<CompositeScraperDefinition>
    const name = input.name?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const rawMap =
      input.fieldPluginMap && typeof input.fieldPluginMap === 'object' ? input.fieldPluginMap : {}
    const fieldPluginMap: CompositeScraperDefinition['fieldPluginMap'] = {}
    for (const [field, pluginName] of Object.entries(rawMap)) {
      if (typeof pluginName !== 'string' || !pluginName.trim()) continue
      const trimmedPluginName = pluginName.trim()
      const resolvedPluginName =
        kind === 'actress' && trimmedPluginName === '偶像档案库'
          ? DEFAULT_SETTINGS.defaultActressScraper
          : trimmedPluginName
      const mappedFields =
        kind === 'actress' ? expandActressScrapeFields([field]) : [field]
      for (const mappedField of mappedFields) {
        fieldPluginMap[mappedField as keyof typeof fieldPluginMap] = resolvedPluginName
      }
    }
    out.push({
      kind,
      name,
      description: input.description?.trim() || undefined,
      fieldPluginMap
    })
  }
  return out
}
