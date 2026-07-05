import type { ScrapeResult } from '@shared/types'
import { ALL_VIDEO_SCRAPE_FIELDS, DEFAULT_SETTINGS, resolveScrapeProxyUrl } from '@shared/types'
import {
  applyScrapeResult,
  getVideoById,
  markScrapeFailed,
  resolveEffectiveScrapeFields
} from '../db/videoRepo'
import { downloadCover, downloadAvatar, downloadSamples } from '../services/assetService'
import { getSettings } from '../settings/settingsStore'
import { scrapeBrowser } from './scrapeBrowser'
import type { VideoScrapeField, VideoScrapeUpdateMode } from '@shared/types'

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
import type { ScraperPluginDescriptor } from '@shared/types'

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
  /** True when scrape succeeded but fillEmpty had no empty fields to write. */
  skipped?: boolean
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
): Promise<ScrapeResult | null> {
  const composite = findCompositeScraper('video', compositeName)
  if (!composite) return null
  const grouped = new Map<string, VideoScrapeField[]>()
  for (const field of effectiveFields) {
    const pluginName = composite.fieldPluginMap[field]
    if (!pluginName) continue
    grouped.set(pluginName, [...(grouped.get(pluginName) ?? []), field])
  }
  let merged: ScrapeResult | null = null
  for (const [pluginName, fields] of grouped) {
    const scraper = getScraper(pluginName)
    const rawResult = delayController
      ? await delayController.run('video', pluginName, () => scraper.parseTask(videoCode, proxy))
      : await scraper.parseTask(videoCode, proxy)
    const result = normalizeVideoScrapeResult(rawResult, videoCode)
    if (!result) continue
    merged = mergeVideoResults(merged, pickVideoFields(result, fieldSet(fields), videoCode))
  }
  return merged
}

function resolveRatingSourceName(
  scraper: { scraperName: string } | null | undefined,
  scraperName: string | undefined,
  defaultScraper: string
): string {
  if (scraper) return scraper.scraperName
  const resolvedName = scraperName || defaultScraper
  const composite = findCompositeScraper('video', resolvedName)
  return composite?.fieldPluginMap.rating ?? resolvedName
}

/**
 * Scrape a single video by id: run the plugin, download assets, persist.
 * Image download failures do not abort text data import.
 */
export async function scrapeVideo(
  videoId: number,
  scraperName?: string,
  options?: ScrapeVideoOptions
): Promise<ScrapeOutcome> {
  const video = getVideoById(videoId)
  if (!video) return { ok: false, error: '视频不存在' }

  const mode = options?.mode ?? 'replace'
  const requested = options?.fields ?? ALL_VIDEO_SCRAPE_FIELDS
  const effective = resolveEffectiveScrapeFields(videoId, requested, mode)
  const selected = new Set(effective)
  const settings = getSettings()
  const proxy = resolveScrapeProxyUrl(settings)
  const scraper = findCompositeScraper('video', scraperName || settings.defaultScraper)
    ? null
    : getScraper(scraperName)

  try {
    const result = scraper
      ? normalizeVideoScrapeResult(
          options?.delayController
            ? await options.delayController.run('video', scraper.scraperName, () =>
                scraper.parseTask(video.code, proxy)
              )
            : await scraper.parseTask(video.code, proxy),
          video.code
        )
      : await scrapeCompositeVideo(
          video.code,
          scraperName || settings.defaultScraper,
          effective,
          proxy,
          options?.delayController
        )
    if (!result) {
      markScrapeFailed(videoId)
      return { ok: false, error: '未找到匹配的元数据' }
    }

    if (effective.length === 0) {
      return { ok: true, result, skipped: true }
    }

    const fetcher = (url: string): Promise<Buffer> => scrapeBrowser.fetchBuffer(url)

    let coverRel: string | null = null
    if (selected.has('cover') && result.coverUrl) {
      coverRel = await downloadCover(result.code || video.code, result.coverUrl, fetcher)
    }

    const avatarMap = new Map<string, string | null>()
    const wantsFemale = selected.has('actressesFemale')
    const wantsMale = selected.has('actressesMale')
    if (wantsFemale || wantsMale) {
      for (const a of result.actresses ?? []) {
        const gender = a.gender ?? 'female'
        if (gender === 'female' && !wantsFemale) continue
        if (gender === 'male' && !wantsMale) continue
        if (a.avatarUrl) {
          const rel = await downloadAvatar(a.name, a.avatarUrl, fetcher)
          avatarMap.set(a.name, rel)
        }
      }
    }

    let sampleRels: Array<string | null> = []
    if (selected.has('samples') && result.sampleImageUrls?.length) {
      sampleRels = await downloadSamples(result.code || video.code, result.sampleImageUrls, fetcher)
    }

    const sourceName = scraper?.scraperName ?? scraperName ?? settings.defaultScraper
    const ratingSourceName = resolveRatingSourceName(
      scraper,
      scraperName,
      settings.defaultScraper
    )

    const applied = applyScrapeResult(
      videoId,
      result,
      coverRel,
      avatarMap,
      sampleRels,
      requested,
      sourceName,
      mode,
      ratingSourceName
    )
    return { ok: true, result, skipped: !applied }
  } catch (err) {
    markScrapeFailed(videoId)
    return { ok: false, error: (err as Error).message }
  } finally {
    if (options?.closeBrowser !== false) {
      scrapeBrowser.close()
    }
  }
}
