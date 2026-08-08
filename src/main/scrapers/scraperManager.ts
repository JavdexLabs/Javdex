import type { ScraperPluginDescriptor } from '@shared/scraperPluginTypes'
import type { ScrapeResult, VideoScrapeField, VideoScrapeUpdateMode } from '@shared/videoScrapeTypes'
import { ALL_VIDEO_SCRAPE_FIELDS } from '@shared/videoScrapeTypes'
import { DEFAULT_SETTINGS, resolveScrapeProxyUrl } from '@shared/settingsTypes'
import {
  applyScrapeResult,
  getVideoById,
  markScrapeFailed
} from '../db/videoRepo'
import { findActressByNameOrAlias } from '../db/actressRepo'
import { adoptDownloadedAvatarIfMissing } from '../services/actressAssetService'
import { mediaAssetStore } from '../services/mediaAssetStore'
import {
  inspectVideoImageAvailability,
  resolveEffectiveVideoScrapeFields
} from '../services/videoImageAvailability'
import { getSettings } from '../settings/settingsStore'
import { scrapeBrowser } from './scrapeBrowser'

/** Registry imports — see file bottom for registration. */
import type { BaseScraper } from './BaseScraper'
import {
  findCompositeScraper,
  listMergedPluginDescriptors,
  listCompositePluginDescriptors,
  loadBundledVideoScrapers,
  loadUserVideoScrapers
} from './scraperPluginService'
import { normalizeVideoScrapeResult } from './scraperResultValidation'

function buildRegistry(): Map<string, BaseScraper> {
  const registry = new Map<string, BaseScraper>()
  for (const scraper of loadUserVideoScrapers()) {
    registry.set(scraper.scraperName, scraper)
  }
  for (const scraper of loadBundledVideoScrapers()) {
    if (!registry.has(scraper.scraperName)) {
      registry.set(scraper.scraperName, scraper)
    }
  }
  return registry
}

export function listScraperNames(): string[] {
  return [...buildRegistry().keys(), ...listCompositePluginDescriptors('video').map((p) => p.name)]
}

export function listScraperPlugins(): ScraperPluginDescriptor[] {
  return listMergedPluginDescriptors('video')
}

export function getScraper(name?: string): BaseScraper {
  const settings = getSettings()
  const key = name || settings.defaultScraper
  const registry = buildRegistry()
  const scraper = registry.get(key) ?? registry.get(DEFAULT_SETTINGS.defaultScraper)
  if (!scraper) throw new Error('No scraper plugin available')
  return scraper
}

export interface ScrapeOutcome {
  ok: boolean
  result?: ScrapeResult
  error?: string
  /** True when the plugin matched but no selected field could be applied. */
  skipped?: boolean
  warnings?: string[]
}

export interface ScrapeVideoOptions {
  closeBrowser?: boolean
  fields?: VideoScrapeField[]
  mode?: VideoScrapeUpdateMode
  delayController?: {
    run<T>(kind: 'video', pluginName: string, task: () => Promise<T>): Promise<T>
  }
}

function fieldSet(fields: VideoScrapeField[]): Set<VideoScrapeField> {
  return new Set(fields)
}

function pickVideoFields(
  result: ScrapeResult,
  fields: Set<VideoScrapeField>,
  fallbackCode: string
): ScrapeResult {
  const out: ScrapeResult = { code: result.code || fallbackCode }
  if (fields.has('title')) out.title = result.title
  if (fields.has('summary')) out.summary = result.summary
  if (fields.has('cover')) out.coverUrl = result.coverUrl
  if (fields.has('releaseDate')) out.releaseDate = result.releaseDate
  if (fields.has('maker')) out.maker = result.maker
  if (fields.has('publisher')) out.publisher = result.publisher
  if (fields.has('series')) out.series = result.series
  if (fields.has('director')) out.director = result.director
  if (fields.has('duration')) out.durationSeconds = result.durationSeconds
  if (fields.has('tags')) out.tags = result.tags
  if (fields.has('source')) out.sourceUrl = result.sourceUrl
  if (fields.has('rating')) {
    out.ratingAverage = result.ratingAverage
    out.ratingCount = result.ratingCount
  }
  if (fields.has('samples')) out.sampleImageUrls = result.sampleImageUrls
  if (fields.has('actressesFemale') || fields.has('actressesMale')) {
    out.actresses = (result.actresses ?? []).filter((actress) => {
      const gender = actress.gender ?? 'female'
      return (
        (gender === 'female' && fields.has('actressesFemale')) ||
        (gender === 'male' && fields.has('actressesMale'))
      )
    })
  }
  return out
}

function mergeVideoResults(base: ScrapeResult | null, next: ScrapeResult): ScrapeResult {
  return {
    ...(base ?? { code: next.code }),
    ...next,
    actresses: [...(base?.actresses ?? []), ...(next.actresses ?? [])],
    tags: next.tags ?? base?.tags,
    sampleImageUrls: next.sampleImageUrls ?? base?.sampleImageUrls
  }
}

async function scrapeCompositeVideo(
  videoCode: string,
  compositeName: string,
  effectiveFields: VideoScrapeField[],
  proxy: string,
  delayController?: ScrapeVideoOptions['delayController']
): Promise<{ result: ScrapeResult; matchedFields: VideoScrapeField[] } | null> {
  const composite = findCompositeScraper('video', compositeName)
  if (!composite) return null
  const grouped = new Map<string, VideoScrapeField[]>()
  for (const field of effectiveFields) {
    const pluginName = composite.fieldPluginMap[field]
    if (!pluginName) continue
    grouped.set(pluginName, [...(grouped.get(pluginName) ?? []), field])
  }
  let merged: ScrapeResult | null = null
  const matchedFields: VideoScrapeField[] = []
  for (const [pluginName, fields] of grouped) {
    const scraper = getScraper(pluginName)
    const rawResult = delayController
      ? await delayController.run('video', pluginName, () => scraper.parseTask(videoCode, proxy))
      : await scraper.parseTask(videoCode, proxy)
    const result = normalizeVideoScrapeResult(rawResult, videoCode)
    if (!result) continue
    merged = mergeVideoResults(merged, pickVideoFields(result, fieldSet(fields), videoCode))
    matchedFields.push(...fields)
  }
  return merged ? { result: merged, matchedFields } : null
}

function resolveVideoFieldSourceNames(
  scraper: { scraperName: string } | null | undefined,
  scraperName: string | undefined,
  defaultScraper: string
): { sourceName: string; ratingSourceName: string } {
  if (scraper) {
    return { sourceName: scraper.scraperName, ratingSourceName: scraper.scraperName }
  }
  const resolvedName = scraperName || defaultScraper
  const composite = findCompositeScraper('video', resolvedName)
  return {
    sourceName: composite?.fieldPluginMap.source ?? resolvedName,
    ratingSourceName: composite?.fieldPluginMap.rating ?? resolvedName
  }
}

export function resolveVideoScrapeFieldSources(scraperName?: string): {
  sourceName: string
  ratingSourceName: string
} {
  const settings = getSettings()
  const composite = findCompositeScraper('video', scraperName || settings.defaultScraper)
  const scraper = composite ? null : getScraper(scraperName)
  return resolveVideoFieldSourceNames(scraper, scraperName, settings.defaultScraper)
}

/** Apply entry used by scrapeVideo; tests may replace this to force apply-phase failures. */
export const videoScrapeApplyBridge = {
  applyScrapeResult
}

/**
 * Scrape a single video by id: run the plugin, download assets, persist.
 * Downloads and DB apply use separate coordinated changes so a committed video
 * row is never paired with a media-ledger rollback. Apply failure cleans the
 * download set; avatar adopt stays isolated. Partial sample download failure
 * still discards that sample set without aborting text import.
 */
export async function scrapeVideo(
  videoId: number,
  scraperName?: string,
  options?: ScrapeVideoOptions
): Promise<ScrapeOutcome> {
  const video = getVideoById(videoId)
  if (!video) return { ok: false, error: '视频不存在' }

  const mode = options?.mode ?? 'replace'
  const settings = getSettings()
  const resolvedScraperName = scraperName || settings.defaultScraper
  const descriptor = listMergedPluginDescriptors('video').find(
    (plugin) => plugin.name === resolvedScraperName
  )
  const supportedFields = new Set(descriptor?.supportedFields ?? ALL_VIDEO_SCRAPE_FIELDS)
  const requested = (options?.fields ?? ALL_VIDEO_SCRAPE_FIELDS).filter((field) =>
    supportedFields.has(field)
  )
  const proxy = resolveScrapeProxyUrl(settings)
  const scraper = findCompositeScraper('video', scraperName || settings.defaultScraper)
    ? null
    : getScraper(scraperName)
  const { sourceName, ratingSourceName } = resolveVideoFieldSourceNames(
    scraper,
    scraperName,
    settings.defaultScraper
  )
  const imageFacts = inspectVideoImageAvailability(videoId)
  const effective = resolveEffectiveVideoScrapeFields(
    videoId,
    requested,
    mode,
    sourceName,
    ratingSourceName
  )
  const selected = new Set(effective)

  if (effective.length === 0) {
    return { ok: true, result: { code: video.code }, skipped: true, warnings: [] }
  }

  try {
    const compositeOutcome = scraper
      ? null
      : await scrapeCompositeVideo(
          video.code,
          scraperName || settings.defaultScraper,
          effective,
          proxy,
          options?.delayController
        )
    const result = scraper
      ? normalizeVideoScrapeResult(
          options?.delayController
            ? await options.delayController.run('video', scraper.scraperName, () =>
                scraper.parseTask(video.code, proxy)
              )
            : await scraper.parseTask(video.code, proxy),
          video.code
        )
      : compositeOutcome?.result ?? null
    if (!result) {
      markScrapeFailed(videoId)
      return { ok: false, error: '未找到匹配的元数据' }
    }

    const fetcher = (url: string): Promise<Buffer> => scrapeBrowser.fetchBuffer(url)
    const fieldsToApply = compositeOutcome?.matchedFields ?? requested

    const downloads = await mediaAssetStore.coordinateDatabaseChange(async () => {
      let coverRel: string | null = null
      let sampleRels: Array<string | null> = []
      const avatarMap = new Map<string, string | null>()

      if (selected.has('cover') && result.coverUrl) {
        coverRel = await mediaAssetStore.downloadCover(
          result.code || video.code,
          result.coverUrl,
          fetcher
        )
      }

      const wantsFemale = selected.has('actressesFemale')
      const wantsMale = selected.has('actressesMale')
      if (wantsFemale || wantsMale) {
        for (const a of result.actresses ?? []) {
          const gender = a.gender ?? 'female'
          if (gender === 'female' && !wantsFemale) continue
          if (gender === 'male' && !wantsMale) continue
          if (a.avatarUrl) {
            const rel = await mediaAssetStore.downloadAvatar(a.name, a.avatarUrl, fetcher)
            avatarMap.set(a.name, rel)
          }
        }
      }

      if (selected.has('samples') && result.sampleImageUrls?.length) {
        sampleRels = await mediaAssetStore.downloadSamples(
          result.code || video.code,
          result.sampleImageUrls,
          fetcher
        )
        if (sampleRels.some((assetPath) => !assetPath)) {
          for (const assetPath of sampleRels) mediaAssetStore.deleteBestEffort(assetPath)
          sampleRels = result.sampleImageUrls.map(() => null)
        }
      }

      return { coverRel, sampleRels, avatarMap }
    })

    const downloadedPaths = [
      downloads.coverRel,
      ...downloads.sampleRels,
      ...downloads.avatarMap.values()
    ].filter((assetPath): assetPath is string => Boolean(assetPath))

    let application
    try {
      application = mediaAssetStore.coordinateDatabaseChange(() => {
        const applied = videoScrapeApplyBridge.applyScrapeResult(
          videoId,
          result,
          downloads.coverRel,
          downloads.avatarMap,
          downloads.sampleRels,
          fieldsToApply,
          sourceName,
          mode,
          ratingSourceName,
          imageFacts
        )
        for (const assetPath of applied.obsoleteAssetPaths) {
          mediaAssetStore.deleteBestEffort(assetPath)
        }
        return applied
      })
    } catch (applyError) {
      for (const assetPath of downloadedPaths) mediaAssetStore.deleteBestEffort(assetPath)
      throw applyError
    }

    if (!application.applied) {
      for (const assetPath of downloadedPaths) mediaAssetStore.deleteBestEffort(assetPath)
    } else {
      for (const [name, avatarPath] of downloads.avatarMap) {
        if (!avatarPath) continue
        const actressId = findActressByNameOrAlias(name)
        if (actressId == null) {
          mediaAssetStore.deleteBestEffort(avatarPath)
          continue
        }
        try {
          adoptDownloadedAvatarIfMissing(actressId, avatarPath)
        } catch (error) {
          mediaAssetStore.deleteBestEffort(avatarPath)
          application.warnings.push(`演员「${name}」头像未应用：${(error as Error).message}`)
        }
      }
    }

    return {
      ok: true,
      result,
      skipped: !application.applied,
      warnings: application.warnings
    }
  } catch (err) {
    markScrapeFailed(videoId)
    return { ok: false, error: (err as Error).message }
  } finally {
    if (options?.closeBrowser !== false) {
      scrapeBrowser.close()
    }
  }
}
