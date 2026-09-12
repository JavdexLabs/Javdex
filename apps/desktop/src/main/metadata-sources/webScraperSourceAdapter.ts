import type { ScraperPluginDescriptor } from '@shared/scraperPluginTypes'
import type { ScrapeResult, VideoScrapeField } from '@shared/videoScrapeTypes'
import { ALL_VIDEO_SCRAPE_FIELDS } from '@shared/videoScrapeTypes'
import { normalizeVideoCode } from '@shared/videoCode'
import type { BaseScraper } from '../scrapers/BaseScraper'
import { normalizeVideoScrapeCandidates } from '../scrapers/scraperResultValidation'
import { projectVideoScrapeResult } from '../scrapers/videoScrapeFieldProjection'
import type {
  MetadataAssetRef,
  MetadataCandidateBatch,
  VideoMetadataCandidate,
  VideoMetadataSource,
  VideoMetadataSourceDescriptor,
  VideoMetadataSourceRequest
} from './types'

const WEB_SCRAPER_SOURCE_PREFIX = 'web-scraper:'

export function webScraperSourceId(pluginName: string): string {
  return `${WEB_SCRAPER_SOURCE_PREFIX}${encodeURIComponent(pluginName)}`
}

export interface WebScraperSourceAdapterOptions {
  scraper: BaseScraper
  plugin: ScraperPluginDescriptor
  proxyUrl: string
  runWithDelay?: <T>(pluginName: string, task: () => Promise<T>) => Promise<T>
}

function supportedVideoFields(plugin: ScraperPluginDescriptor): VideoScrapeField[] {
  return plugin.supportedFields.filter(
    (field): field is VideoScrapeField =>
      (ALL_VIDEO_SCRAPE_FIELDS as readonly string[]).includes(field)
  )
}

function normalizeCandidateSourceUrl(sourceUrl: string | undefined): string | null {
  if (!sourceUrl) return null
  try {
    const rawUrl = sourceUrl.trim()
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    const rawAuthority = rawUrl.match(/^https?:\/\/[^/?#]*/i)?.[0]
    const hasExplicitPath = rawAuthority
      ? rawUrl.slice(rawAuthority.length).startsWith('/')
      : true
    parsed.hash = ''
    const normalized = parsed.toString()
    if (!hasExplicitPath && parsed.pathname === '/') {
      const normalizedAuthority = normalized.match(/^https?:\/\/[^/?#]*/i)?.[0]
      if (normalizedAuthority) return `${normalizedAuthority}${parsed.search}`
    }
    return normalized
  } catch {
    return null
  }
}

function pickDeclaredRawVideoFields(
  value: unknown,
  supportedFields: ReadonlySet<VideoScrapeField>
): unknown {
  if (Array.isArray(value)) {
    return value.map((candidate) => pickDeclaredRawVideoFields(candidate, supportedFields))
  }
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = { code: source.code }
  const copy = (field: VideoScrapeField, ...keys: string[]): void => {
    if (!supportedFields.has(field)) return
    for (const key of keys) result[key] = source[key]
  }
  copy('title', 'title')
  copy('summary', 'summary')
  copy('cover', 'coverUrl')
  copy('releaseDate', 'releaseDate')
  copy('maker', 'maker')
  copy('publisher', 'publisher')
  copy('series', 'series')
  copy('director', 'director')
  copy('duration', 'durationSeconds')
  if (supportedFields.has('actressesFemale') || supportedFields.has('actressesMale')) {
    result.actresses = source.actresses
  }
  copy('tags', 'tags')
  copy('source', 'sourceUrl')
  copy('rating', 'ratingAverage', 'ratingCount')
  copy('samples', 'sampleImageUrls')
  return result
}

export function createRemoteMetadataAssetRefs(result: ScrapeResult): MetadataAssetRef[] {
  const assets: MetadataAssetRef[] = []
  if (result.coverUrl) {
    assets.push({ kind: 'remote-url', field: 'cover', position: 0, url: result.coverUrl })
  }
  for (const [position, url] of (result.sampleImageUrls ?? []).entries()) {
    assets.push({ kind: 'remote-url', field: 'samples', position, url })
  }
  for (const [position, actress] of (result.actresses ?? []).entries()) {
    if (!actress.avatarUrl) continue
    assets.push({
      kind: 'remote-url',
      field: 'actressAvatar',
      position,
      url: actress.avatarUrl
    })
  }
  return assets
}

export class WebScraperSourceAdapter implements VideoMetadataSource {
  readonly descriptor: VideoMetadataSourceDescriptor
  private readonly supportedFields: Set<VideoScrapeField>

  constructor(private readonly options: WebScraperSourceAdapterOptions) {
    const supportedFields = supportedVideoFields(options.plugin)
    this.supportedFields = new Set(supportedFields)
    this.descriptor = {
      id: webScraperSourceId(options.plugin.name),
      name: options.plugin.name,
      kind: 'web-scraper',
      origin: options.plugin.source,
      version: options.plugin.version,
      supportedFields
    }
  }

  async collect(request: VideoMetadataSourceRequest): Promise<MetadataCandidateBatch> {
    const requestedCode = request.target.code
    const normalizedCode = normalizeVideoCode(requestedCode)
    const task = () => this.options.scraper.parseTask(requestedCode, this.options.proxyUrl)
    const rawResult = this.options.runWithDelay
      ? await this.options.runWithDelay(this.options.plugin.name, task)
      : await task()
    const trustedRawResult = pickDeclaredRawVideoFields(rawResult, this.supportedFields)
    const warnings: string[] = []
    const seenUrls = new Set<string>()
    const candidates: VideoMetadataCandidate[] = []

    for (const candidate of normalizeVideoScrapeCandidates(trustedRawResult, requestedCode)) {
      let candidateCode: string
      try {
        candidateCode = normalizeVideoCode(candidate.code)
      } catch {
        warnings.push('插件返回了无效番号候选，已排除')
        continue
      }
      if (candidateCode !== normalizedCode) {
        warnings.push(
          `插件返回的候选番号 ${candidate.code} 与 ${normalizedCode} 不完全匹配，已排除`
        )
        continue
      }
      const normalizedSourceUrl = normalizeCandidateSourceUrl(candidate.sourceUrl)
      if (normalizedSourceUrl && seenUrls.has(normalizedSourceUrl)) continue
      if (normalizedSourceUrl) seenUrls.add(normalizedSourceUrl)
      const result = projectVideoScrapeResult(
        candidate,
        this.supportedFields,
        normalizedCode
      )
      candidates.push({
        result,
        assets: createRemoteMetadataAssetRefs(result),
        evidence: {
          kind: 'web-scraper',
          sourceId: this.descriptor.id,
          sourceName: this.descriptor.name,
          ...(normalizedSourceUrl ? { sourceUrl: normalizedSourceUrl } : {})
        }
      })
    }

    return { candidates, warnings }
  }
}
