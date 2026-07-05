import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import process from 'node:process'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type CompositeScraperDefinition,
  type ScraperPluginDelaySettings,
  expandActressScrapeFields,
  normalizePluginDevAgentMaxContextTokens,
  normalizePluginDevAgentMaxSteps,
  normalizeTheme,
  normalizeMinScanImportDurationMinutes
} from '@shared/types'
import {
  BUILT_IN_LLM_PROVIDER_BY_ID,
  isReservedLlmProviderId,
  isValidCustomLlmProviderId,
  normalizeDefaultLlmSelection,
  type CustomLlmProviderDefinition,
  type LlmCustomModelDefinition,
  type LlmProviderProtocol,
  type LlmProviderUserConfig
} from '@shared/llmProviders'
import { readTestUserDataPath } from '@shared/appIdentity'

let cache: AppSettings | null = null

function settingsFilePath(): string {
  const userData = app?.getPath ? app.getPath('userData') : readTestUserDataPath()
  if (!userData) throw new Error('Electron app userData path is unavailable')
  return path.join(userData, 'settings.json')
}

/** Test-only: clear in-memory settings cache between isolated runs. */
export function resetSettingsCacheForTests(): void {
  cache = null
}

export function getSettings(): AppSettings {
  if (cache) return cache
  const file = settingsFilePath()
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      cache = normalizeSettings(parsed)
    } else {
      cache = { ...DEFAULT_SETTINGS }
    }
  } catch {
    cache = { ...DEFAULT_SETTINGS }
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
  cache = next
  try {
    fs.writeFileSync(settingsFilePath(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    console.error('Failed to persist settings:', err)
  }
  return next
}

type ParsedSettings = Partial<AppSettings>

function normalizeSettings(parsed: ParsedSettings): AppSettings {
  const defaultScraper =
    typeof parsed.defaultScraper === 'string' && parsed.defaultScraper.trim()
      ? parsed.defaultScraper.trim()
      : DEFAULT_SETTINGS.defaultScraper
  const defaultActressScraper =
    typeof parsed.defaultActressScraper === 'string' && parsed.defaultActressScraper.trim()
      ? parsed.defaultActressScraper.trim()
      : DEFAULT_SETTINGS.defaultActressScraper
  const llm = normalizeLlmSettings(parsed)
  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    defaultScraper,
    defaultActressScraper,
    theme: normalizeTheme(parsed.theme),
    videoDetailUseFirstSampleBackground: normalizeBooleanSetting(
      parsed.videoDetailUseFirstSampleBackground,
      DEFAULT_SETTINGS.videoDetailUseFirstSampleBackground
    ),
    actressDetailUseFirstGalleryBackground: normalizeBooleanSetting(
      parsed.actressDetailUseFirstGalleryBackground,
      DEFAULT_SETTINGS.actressDetailUseFirstGalleryBackground
    ),
    mediaAssetsPath:
      typeof parsed.mediaAssetsPath === 'string' ? parsed.mediaAssetsPath.trim() : '',
    minScanImportDurationMinutes: normalizeMinScanImportDurationMinutes(
      parsed.minScanImportDurationMinutes
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
    pluginDevAgentMaxSteps: normalizePluginDevAgentMaxSteps(parsed.pluginDevAgentMaxSteps),
    pluginDevAgentMaxContextTokens: normalizePluginDevAgentMaxContextTokens(
      parsed.pluginDevAgentMaxContextTokens
    ),
    scraperPluginDelays: normalizeDelaySettings(parsed.scraperPluginDelays),
    compositeScrapers: {
      video: normalizeCompositeScrapers(parsed.compositeScrapers?.video, 'video'),
      actress: normalizeCompositeScrapers(parsed.compositeScrapers?.actress, 'actress')
    }
  }
}

function normalizeBooleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
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
    llmProviderConfigs,
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
    const item = config as { apiKey?: unknown; baseUrl?: unknown; protocol?: unknown }
    const apiKey = typeof item.apiKey === 'string' ? item.apiKey.trim() : undefined
    const baseUrl = typeof item.baseUrl === 'string' ? item.baseUrl.trim() : undefined
    const protocol = normalizeLlmProviderProtocol(item.protocol)
    if (!apiKey && !baseUrl && !protocol) continue
    out[providerId.trim()] = {
      ...(apiKey ? { apiKey } : {}),
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
      const mappedFields =
        kind === 'actress' ? expandActressScrapeFields([field]) : [field]
      for (const mappedField of mappedFields) {
        fieldPluginMap[mappedField as keyof typeof fieldPluginMap] = pluginName.trim()
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
