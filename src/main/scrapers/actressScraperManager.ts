import type { BaseActressScraper } from './BaseActressScraper'
import type {
  ActressScrapeResult,
  ActressScrapeField,
  ActressScrapeUpdateMode
} from '@shared/types'
import { ALL_ACTRESS_SCRAPE_FIELDS, resolveScrapeProxyUrl } from '@shared/types'
import {
  applyActressScrapeResult,
  getActressDetail,
  resolveEffectiveActressScrapeFields,
  touchActressLastScrapedAt
} from '../db/actressRepo'
import { downloadActressGalleryImage, downloadAvatar } from '../services/assetService'
import { getSettings } from '../settings/settingsStore'
import { scrapeBrowser } from './scrapeBrowser'
import {
  findCompositeScraper,
  listMergedPluginDescriptors,
  listCompositePluginDescriptors,
  loadBundledActressScrapers,
  loadUserActressScrapers
} from './scraperPluginService'
import { normalizeActressScrapeResult } from './scraperResultValidation'
import type { ScraperPluginDescriptor } from '@shared/types'

function buildRegistry(): Map<string, BaseActressScraper> {
  const registry = new Map<string, BaseActressScraper>()
  for (const scraper of loadUserActressScrapers()) {
    registry.set(scraper.scraperName, scraper)
  }
  for (const scraper of loadBundledActressScrapers()) {
    if (!registry.has(scraper.scraperName)) {
      registry.set(scraper.scraperName, scraper)
    }
  }
  return registry
}

export function listActressScraperNames(): string[] {
  return [...buildRegistry().keys(), ...listCompositePluginDescriptors('actress').map((p) => p.name)]
}

export function listActressScraperPlugins(): ScraperPluginDescriptor[] {
  return listMergedPluginDescriptors('actress')
}

export function getActressScraper(name?: string): BaseActressScraper {
  const settings = getSettings()
  const key = name || settings.defaultActressScraper
  const registry = buildRegistry()
  const scraper = registry.get(key) ?? registry.get('Xslist')
  if (!scraper) throw new Error('No actress scraper plugin available')
  return scraper
}

export interface ActressScrapeOutcome {
  ok: boolean
  result?: ActressScrapeResult
  error?: string
  skipped?: boolean
  warnings?: string[]
  /** The requested avatar was downloaded, validated, and is ready for smart crop. */
  avatarUpdated?: boolean
}

export interface ScrapeActressOptions {
  closeBrowser?: boolean
  fields?: ActressScrapeField[]
  mode?: ActressScrapeUpdateMode
  /** Name used to query scraper sites; defaults to the actress main name. */
  queryName?: string
  /** When true, scrapers also try stored aliases / zh / en names. Default false. */
  useAliases?: boolean
  delayController?: {
    run<T>(kind: 'actress', pluginName: string, task: () => Promise<T>): Promise<T>
  }
}

function pickActressFields(
  result: ActressScrapeResult,
  fields: Set<ActressScrapeField>
): ActressScrapeResult {
  const out: ActressScrapeResult = {}
  if (fields.has('avatar')) out.avatarUrl = result.avatarUrl
  if (fields.has('gallery')) out.galleryImageUrls = result.galleryImageUrls
  if (fields.has('birthDate')) out.birthDate = result.birthDate
  if (fields.has('nameZh')) out.nameZh = result.nameZh
  if (fields.has('nameEn')) out.nameEn = result.nameEn
  if (fields.has('debutDate')) out.debutDate = result.debutDate
  if (fields.has('heightCm')) out.heightCm = result.heightCm
  if (fields.has('measurements')) {
    out.bustCm = result.bustCm
    out.waistCm = result.waistCm
    out.hipCm = result.hipCm
  }
  if (fields.has('cupSize')) out.cupSize = result.cupSize
  if (fields.has('bloodType')) out.bloodType = result.bloodType
  if (fields.has('zodiac')) out.zodiac = result.zodiac
  if (fields.has('nationality')) out.nationality = result.nationality
  if (fields.has('profileSummary')) out.profileSummary = result.profileSummary
  if (fields.has('aliases')) out.aliases = result.aliases
  return out
}

function mergeActressResults(
  base: ActressScrapeResult | null,
  next: ActressScrapeResult
): ActressScrapeResult {
  return {
    ...(base ?? {}),
    ...next,
    aliases: next.aliases ?? base?.aliases,
    galleryImageUrls: next.galleryImageUrls ?? base?.galleryImageUrls
  }
}

function hasScrapedValueForField(
  result: ActressScrapeResult,
  field: ActressScrapeField
): boolean {
  const selected = pickActressFields(result, new Set([field]))
  return Object.values(selected).some((value) => {
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === 'string') return value.trim().length > 0
    return value !== undefined && value !== null
  })
}

interface CompositeActressScrapeOutcome {
  result: ActressScrapeResult | null
  warnings: string[]
}

async function scrapeCompositeActress(
  compositeName: string,
  fields: ActressScrapeField[],
  queryName: string,
  aliases: string[],
  proxyUrl: string,
  delayController?: ScrapeActressOptions['delayController']
): Promise<CompositeActressScrapeOutcome> {
  const composite = findCompositeScraper('actress', compositeName)
  if (!composite) return { result: null, warnings: [] }
  const grouped = new Map<string, ActressScrapeField[]>()
  for (const field of fields) {
    const pluginName = composite.fieldPluginMap[field]
    if (!pluginName) continue
    grouped.set(pluginName, [...(grouped.get(pluginName) ?? []), field])
  }
  let merged: ActressScrapeResult | null = null
  let failedSources = 0
  const warnings: string[] = []
  for (const [pluginName, pluginFields] of grouped) {
    try {
      const scraper = getActressScraper(pluginName)
      const rawResult = delayController
        ? await delayController.run('actress', pluginName, () =>
            scraper.parseTask(queryName, aliases, proxyUrl)
          )
        : await scraper.parseTask(queryName, aliases, proxyUrl)
      const result = normalizeActressScrapeResult(rawResult)
      if (!result) continue
      merged = mergeActressResults(merged, pickActressFields(result, new Set(pluginFields)))
    } catch (error) {
      failedSources += 1
      warnings.push(`字段源「${pluginName}」失败：${(error as Error).message}`)
    }
  }
  if (grouped.size > 0 && failedSources === grouped.size) {
    throw new Error(warnings.join('；'))
  }
  return { result: merged, warnings }
}

function dedupeActressNameList(names: string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const name of names) {
    const trimmed = name.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(trimmed)
  }
  return deduped
}

function resolveActressScrapeQuery(
  mainName: string,
  aliases: string[],
  queryName?: string,
  supplementalNames: string[] = [],
  useAliases = false
): { queryName: string; aliases: string[] } {
  const trimmed = queryName?.trim() || mainName
  if (!useAliases) {
    return { queryName: trimmed, aliases: [] }
  }
  const knownNames = dedupeActressNameList([...aliases, ...supplementalNames])
  if (trimmed === mainName) {
    return { queryName: mainName, aliases: knownNames }
  }
  const fallback = dedupeActressNameList(
    [mainName, ...knownNames].filter((name) => name !== trimmed)
  )
  return { queryName: trimmed, aliases: fallback }
}

/** Scrape a single actress profile and persist avatar / fields / aliases. */
export async function scrapeActress(
  actressId: number,
  scraperName?: string,
  options?: ScrapeActressOptions
): Promise<ActressScrapeOutcome> {
  const detail = getActressDetail(actressId)
  if (!detail) return { ok: false, error: '演员不存在' }

  const fields = options?.fields
  const requested = fields ?? ALL_ACTRESS_SCRAPE_FIELDS
  const mode = options?.mode ?? 'replace'
  const effective = resolveEffectiveActressScrapeFields(actressId, requested, mode)
  const selected = new Set(effective)
  const settings = getSettings()
  const proxyUrl = resolveScrapeProxyUrl(settings)
  const selectedScraperName = scraperName || settings.defaultActressScraper
  const composite = findCompositeScraper('actress', selectedScraperName)
  const scraper = composite ? null : getActressScraper(scraperName)
  const gfriendsSelected =
    scraper?.scraperName === 'Gfriends' ||
    effective.some((field) => composite?.fieldPluginMap[field] === 'Gfriends')

  const { queryName, aliases } = resolveActressScrapeQuery(
    detail.main_name,
    detail.aliases,
    options?.queryName,
    [detail.name_zh, detail.name_en].filter((name): name is string => Boolean(name?.trim())),
    (options?.useAliases ?? false) || gfriendsSelected
  )

  try {
    let rawResult: ActressScrapeResult | null
    let sourceWarnings: string[] = []
    if (scraper) {
      rawResult = options?.delayController
        ? await options.delayController.run('actress', scraper.scraperName, () =>
            scraper.parseTask(queryName, aliases, proxyUrl)
          )
        : await scraper.parseTask(queryName, aliases, proxyUrl)
    } else {
      const compositeOutcome = await scrapeCompositeActress(
        selectedScraperName,
        effective,
        queryName,
        aliases,
        proxyUrl,
        options?.delayController
      )
      rawResult = compositeOutcome.result
      sourceWarnings = compositeOutcome.warnings
    }
    const result = normalizeActressScrapeResult(rawResult)
    if (!result) {
      touchActressLastScrapedAt(actressId)
      return {
        ok: false,
        error: '未找到匹配的演员资料',
        warnings: sourceWarnings.length > 0 ? sourceWarnings : undefined
      }
    }
    if (effective.length === 0) return { ok: true, result, skipped: true }

    const fetcher = (url: string): Promise<Buffer> => scrapeBrowser.fetchBuffer(url)
    let avatarRel: string | null = null
    if (selected.has('avatar') && result.avatarUrl) {
      avatarRel = await downloadAvatar(detail.main_name, result.avatarUrl, fetcher)
      const sourceName = composite?.fieldPluginMap.avatar
      if (!avatarRel && sourceName) {
        sourceWarnings.push(`字段源「${sourceName}」失败：头像下载失败`)
      }
    }

    const galleryUrls = dedupeUrls(result.galleryImageUrls ?? [])
    const galleryAssets: Array<{
      remoteUrl: string
      localPath: string | null
      width: number | null
      height: number | null
    }> = []
    if (selected.has('gallery') && galleryUrls.length) {
      let failedDownloads = 0
      for (let index = 0; index < galleryUrls.length; index++) {
        const downloaded = await downloadActressGalleryImage(
          detail.main_name,
          galleryUrls[index],
          fetcher,
          actressId
        )
        if (!downloaded) failedDownloads += 1
        galleryAssets.push({
          remoteUrl: galleryUrls[index],
          localPath: downloaded?.localPath ?? null,
          width: downloaded?.width ?? null,
          height: downloaded?.height ?? null
        })
      }
      const sourceName = composite?.fieldPluginMap.gallery
      if (failedDownloads > 0 && sourceName) {
        sourceWarnings.push(
          `字段源「${sourceName}」失败：${failedDownloads} 张写真下载失败`
        )
      }
    }

    if (composite && sourceWarnings.length > 0) {
      const hasSuccessfulOutput = effective.some((field) => {
        if (!composite.fieldPluginMap[field]) return false
        if (field === 'avatar') return avatarRel !== null
        if (field === 'gallery') {
          return galleryAssets.some((asset) => asset.localPath !== null)
        }
        return hasScrapedValueForField(result, field)
      })
      if (!hasSuccessfulOutput) {
        throw new Error(sourceWarnings.join('；'))
      }
    }

    const { applied, warnings: applyWarnings, avatarApplied } = applyActressScrapeResult(
      actressId,
      { ...result, galleryImageUrls: galleryUrls },
      avatarRel,
      galleryAssets,
      requested,
      mode
    )
    const warnings = [...sourceWarnings, ...applyWarnings]
    return {
      ok: true,
      result,
      skipped: !applied,
      warnings: warnings.length > 0 ? warnings : undefined,
      avatarUpdated: avatarApplied
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    if (options?.closeBrowser !== false) {
      scrapeBrowser.close()
    }
  }
}

function dedupeUrls(urls: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const url of urls) {
    const trimmed = url.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}
