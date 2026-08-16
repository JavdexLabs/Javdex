import type { ScraperPluginDescriptor } from '@shared/scraperPluginTypes'
import type {
  ScrapeResult,
  VideoClassificationResolutionOutcome,
  VideoDirectorChoiceRequired,
  VideoScrapeField,
  VideoScrapeUpdateMode
} from '@shared/videoScrapeTypes'
import { ALL_VIDEO_SCRAPE_FIELDS } from '@shared/videoScrapeTypes'
import { resolveScrapeProxyUrl } from '@shared/settingsTypes'
import { getVideoById, markScrapeFailed } from '../db/videoRepo'
import {
  type PendingVideoScrapeCandidateInput,
  deletePendingVideoScrape,
  getPendingVideoScrapeForVideo,
  replacePendingVideoScrape
} from '../db/pendingVideoScrapeRepo'
import {
  findVideoBusinessIdentityConflictForScrape,
  resolveEffectiveVideoScrapeFields,
  videoScrapeApplyService
} from '../services/videoScrapeApplyService'
import { getSettings } from '../settings/settingsStore'
import { scrapeBrowser } from './scrapeBrowser'
import { mediaAssetStore } from '../services/mediaAssetStore'
import { normalizeVideoCode } from '@shared/videoCode'

/** Registry imports — see file bottom for registration. */
import type { BaseScraper } from './BaseScraper'
import { buildPluginRegistry } from './compositeScrapeRun'
import {
  findCompositeScraper,
  listMergedPluginDescriptors,
  listCompositePluginDescriptors,
  loadBundledVideoScrapers,
  loadUserVideoScrapers
} from './scraperPluginService'
import { normalizeVideoScrapeCandidates } from './scraperResultValidation'
import {
  mergeVideoScrapeResults,
  projectVideoScrapeResult
} from './videoScrapeFieldProjection'

function buildRegistry(): Map<string, BaseScraper> {
  return buildPluginRegistry(loadUserVideoScrapers, loadBundledVideoScrapers)
}

export function listScraperNames(): string[] {
  const runnable = new Set(
    listMergedPluginDescriptors('video')
      .filter((plugin) => plugin.configured !== false)
      .map((plugin) => plugin.name)
  )
  return [
    ...[...buildRegistry().keys()].filter((name) => runnable.has(name)),
    ...listCompositePluginDescriptors('video')
      .filter((plugin) => plugin.configured !== false)
      .map((plugin) => plugin.name)
  ]
}

export function listScraperPlugins(): ScraperPluginDescriptor[] {
  return listMergedPluginDescriptors('video')
}

function assertVideoScraperRunnable(name: string): ScraperPluginDescriptor {
  const descriptor = listMergedPluginDescriptors('video').find((plugin) => plugin.name === name)
  if (!descriptor) throw new Error(`影片刮削插件「${name}」不存在`)
  if (descriptor.configured === false) {
    throw new Error(descriptor.disabledReason ?? `刮削插件「${name}」尚未配置`)
  }
  return descriptor
}

export function getScraper(name?: string): BaseScraper {
  const settings = getSettings()
  const key = name || settings.defaultScraper
  assertVideoScraperRunnable(key)
  const registry = buildRegistry()
  const scraper = registry.get(key)
  if (!scraper) throw new Error(`影片刮削插件「${key}」不存在`)
  return scraper
}

export interface ScrapeOutcome {
  ok: boolean
  result?: ScrapeResult
  error?: string
  /** True when the plugin matched but no selected field could be applied. */
  skipped?: boolean
  warnings?: string[]
  classifications?: VideoClassificationResolutionOutcome[]
  directorChoice?: VideoDirectorChoiceRequired
  pending?: boolean
  pendingScrapeId?: number
}

export interface ScrapeVideoOptions {
  closeBrowser?: boolean
  fields?: VideoScrapeField[]
  mode?: VideoScrapeUpdateMode
  directorSelectionId?: number
  directorAmbiguity?: 'choice' | 'preserve'
  delayController?: {
    run<T>(kind: 'video', pluginName: string, task: () => Promise<T>): Promise<T>
  }
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

function collectExactVideoCandidates(
  rawResult: unknown,
  videoCode: string,
  supportedFields: Set<VideoScrapeField>
): { candidates: ScrapeResult[]; warnings: string[] } {
  const normalizedCode = normalizeVideoCode(videoCode)
  const warnings: string[] = []
  const seenUrls = new Set<string>()
  const candidates: ScrapeResult[] = []
  const trustedRawResult = pickDeclaredRawVideoFields(rawResult, supportedFields)
  for (const candidate of normalizeVideoScrapeCandidates(trustedRawResult, videoCode)) {
    let candidateCode: string
    try {
      candidateCode = normalizeVideoCode(candidate.code)
    } catch {
      warnings.push('插件返回了无效番号候选，已排除')
      continue
    }
    if (candidateCode !== normalizedCode) {
      warnings.push(`插件返回的候选番号 ${candidate.code} 与 ${normalizedCode} 不完全匹配，已排除`)
      continue
    }
    const normalizedUrl = normalizeCandidateSourceUrl(candidate.sourceUrl)
    if (normalizedUrl && seenUrls.has(normalizedUrl)) continue
    if (normalizedUrl) seenUrls.add(normalizedUrl)
    candidates.push(projectVideoScrapeResult(candidate, supportedFields, normalizedCode))
  }
  return { candidates, warnings }
}

function pickDeclaredRawVideoFields(
  value: unknown,
  supportedFields: Set<VideoScrapeField>
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

async function fetchUsableImage(url: string): Promise<Buffer | null> {
  try {
    const data = await scrapeBrowser.fetchBuffer(url)
    return mediaAssetStore.isUsableImageBuffer(data) ? data : null
  } catch {
    return null
  }
}

async function stageVideoCandidates(
  candidates: ScrapeResult[],
  supportedFields: Set<VideoScrapeField>
): Promise<{ candidates: PendingVideoScrapeCandidateInput[]; warnings: string[] }> {
  const warnings: string[] = []
  const stagedCandidates: PendingVideoScrapeCandidateInput[] = []
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const result = candidates[candidateIndex]
    const resources: Parameters<typeof mediaAssetStore.stageVideoScrapeImages>[0] = []
    if (supportedFields.has('cover') && result.coverUrl) {
      const data = await fetchUsableImage(result.coverUrl)
      if (data) {
        resources.push({ field: 'cover', position: 0, remoteUrl: result.coverUrl, data })
      } else {
        warnings.push(`候选 ${candidateIndex + 1} 的封面暂存失败`)
      }
    }
    if (supportedFields.has('samples') && result.sampleImageUrls?.length) {
      const sampleBuffers = await Promise.all(result.sampleImageUrls.map(fetchUsableImage))
      if (sampleBuffers.every((data): data is Buffer => data !== null)) {
        sampleBuffers.forEach((data, position) => {
          resources.push({
            field: 'samples',
            position,
            remoteUrl: result.sampleImageUrls?.[position] ?? '',
            data
          })
        })
      } else {
        warnings.push(`候选 ${candidateIndex + 1} 的样张暂存不完整，已放弃整组样张`)
      }
    }
    const wantsFemale = supportedFields.has('actressesFemale')
    const wantsMale = supportedFields.has('actressesMale')
    if (wantsFemale || wantsMale) {
      for (let position = 0; position < (result.actresses?.length ?? 0); position++) {
        const actress = result.actresses?.[position]
        if (!actress?.avatarUrl) continue
        const gender = actress.gender ?? 'female'
        if ((gender === 'female' && !wantsFemale) || (gender === 'male' && !wantsMale)) continue
        const data = await fetchUsableImage(actress.avatarUrl)
        if (data) {
          resources.push({
            field: 'actressAvatar',
            position,
            remoteUrl: actress.avatarUrl,
            data
          })
        } else {
          warnings.push(`候选 ${candidateIndex + 1} 的演员「${actress.name}」头像暂存失败`)
        }
      }
    }
    const staged = mediaAssetStore.stageVideoScrapeImages(resources)
    stagedCandidates.push({
      result,
      sourceUrl: result.sourceUrl ?? null,
      normalizedSourceUrl: normalizeCandidateSourceUrl(result.sourceUrl),
      resources: staged.map((resource) => ({
        field: resource.field,
        position: resource.position,
        remoteUrl: resource.remoteUrl,
        stagedPath: resource.stagedPath,
        width: resource.width,
        height: resource.height,
        sizeBytes: resource.sizeBytes
      }))
    })
  }
  return { candidates: stagedCandidates, warnings }
}

interface CompositeVideoCandidateSource {
  pluginName: string
  descriptor: ScraperPluginDescriptor | undefined
  selectedFields: VideoScrapeField[]
  supportedFields: Set<VideoScrapeField>
  candidates: ScrapeResult[]
}

interface CompositeVideoOutcome {
  result: ScrapeResult | null
  matchedFields: VideoScrapeField[]
  sources: CompositeVideoCandidateSource[]
  warnings: string[]
}

async function scrapeCompositeVideo(
  videoCode: string,
  compositeName: string,
  effectiveFields: VideoScrapeField[],
  proxy: string,
  delayController?: ScrapeVideoOptions['delayController']
): Promise<CompositeVideoOutcome | null> {
  const composite = findCompositeScraper('video', compositeName)
  if (!composite) return null
  const grouped = new Map<string, VideoScrapeField[]>()
  for (const field of effectiveFields) {
    const pluginName = composite.fieldPluginMap[field]
    if (!pluginName) continue
    grouped.set(pluginName, [...(grouped.get(pluginName) ?? []), field])
  }
  const descriptors = listMergedPluginDescriptors('video')
  const sources: CompositeVideoCandidateSource[] = []
  const warnings: string[] = []
  let merged: ScrapeResult | null = null
  const matchedFields: VideoScrapeField[] = []
  for (const [pluginName, selectedFields] of grouped) {
    const scraper = getScraper(pluginName)
    const descriptor = descriptors.find((item) => item.name === pluginName)
    const supportedFields = new Set<VideoScrapeField>(
      (descriptor?.supportedFields ?? ALL_VIDEO_SCRAPE_FIELDS).filter(
        (field): field is VideoScrapeField =>
          (ALL_VIDEO_SCRAPE_FIELDS as readonly string[]).includes(field)
      )
    )
    const rawResult = delayController
      ? await delayController.run('video', pluginName, () => scraper.parseTask(videoCode, proxy))
      : await scraper.parseTask(videoCode, proxy)
    const collected = collectExactVideoCandidates(rawResult, videoCode, supportedFields)
    warnings.push(...collected.warnings.map((warning) => `字段源「${pluginName}」：${warning}`))
    if (collected.candidates.length === 0) continue
    sources.push({ pluginName, descriptor, selectedFields, supportedFields, candidates: collected.candidates })
    matchedFields.push(...selectedFields)
    merged = mergeVideoScrapeResults(
      merged,
      projectVideoScrapeResult(collected.candidates[0], new Set(selectedFields), videoCode)
    )
  }
  return { result: merged, matchedFields, sources, warnings }
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
  const resolvedName = scraperName || settings.defaultScraper
  assertVideoScraperRunnable(resolvedName)
  const composite = findCompositeScraper('video', resolvedName)
  const scraper = composite ? null : getScraper(scraperName)
  return resolveVideoFieldSourceNames(scraper, scraperName, settings.defaultScraper)
}

/** Re-export apply bridge for scrape integration tests. */
export { videoScrapeApplyBridge } from '../services/videoScrapeApplyService'

/**
 * Scrape a single video by id: run the plugin, then deliver assets/apply via
 * videoScrapeApplyService (download + DB apply use separate coordinated changes).
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
  const descriptor = assertVideoScraperRunnable(resolvedScraperName)
  const supportedFields = new Set<VideoScrapeField>(
    (descriptor?.supportedFields ?? ALL_VIDEO_SCRAPE_FIELDS).filter(
      (field): field is VideoScrapeField =>
        (ALL_VIDEO_SCRAPE_FIELDS as readonly string[]).includes(field)
    )
  )
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
  const effective = resolveEffectiveVideoScrapeFields(
    videoId,
    requested,
    mode,
    sourceName,
    ratingSourceName
  )

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
    const pluginRawResult = scraper
      ? options?.delayController
        ? await options.delayController.run('video', scraper.scraperName, () =>
            scraper.parseTask(video.code, proxy)
          )
        : await scraper.parseTask(video.code, proxy)
      : null
    const collected = scraper
      ? collectExactVideoCandidates(pluginRawResult, video.code, supportedFields)
      : {
          candidates: compositeOutcome?.result ? [compositeOutcome.result] : [],
          warnings: compositeOutcome?.warnings ?? []
        }
    const result = scraper ? collected.candidates[0] : compositeOutcome?.result
    if (!result) {
      markScrapeFailed(videoId)
      return {
        ok: false,
        error: '未找到匹配的元数据',
        warnings: collected.warnings
      }
    }

    const hasAmbiguousSource = scraper
      ? collected.candidates.length > 1
      : compositeOutcome?.sources.some((source) => source.candidates.length > 1) ?? false
    const fieldsToApply = compositeOutcome?.matchedFields ?? requested
    const identityConflictVideoId =
      !hasAmbiguousSource
        ? findVideoBusinessIdentityConflictForScrape(
            videoId,
            result,
            fieldsToApply,
            mode
          )
        : null
    if (hasAmbiguousSource || identityConflictVideoId != null) {
      const pendingWarnings = identityConflictVideoId == null
        ? collected.warnings
        : [
            ...collected.warnings,
            `候选会与影片 ID ${identityConflictVideoId} 的业务身份冲突，请选择合并或放弃`
          ]
      const persisted = await mediaAssetStore.coordinateDatabaseChange(async () => {
        const stagedSources = scraper
          ? [
              {
                pluginName: resolvedScraperName,
                pluginSource: descriptor?.source ?? ('builtin' as const),
                pluginVersion: descriptor?.version ?? null,
                pluginConfig: { supportedFields: [...supportedFields] },
                sourceName,
                selectedFields: effective,
                staged: await stageVideoCandidates(collected.candidates, supportedFields)
              }
            ]
          : await Promise.all(
              (compositeOutcome?.sources ?? []).map(async (source) => ({
                pluginName: source.pluginName,
                pluginSource: source.descriptor?.source ?? ('builtin' as const),
                pluginVersion: source.descriptor?.version ?? null,
                pluginConfig: { supportedFields: [...source.supportedFields] },
                sourceName: source.pluginName,
                selectedFields: source.selectedFields,
                staged: await stageVideoCandidates(source.candidates, source.supportedFields)
              }))
            )
        return replacePendingVideoScrape({
          videoId,
          selectedFields: requested,
          applicableFields: fieldsToApply,
          updateMode: mode,
          request: {
            scraperName: resolvedScraperName,
            fields: requested,
            mode,
            fieldPluginMap: findCompositeScraper('video', resolvedScraperName)?.fieldPluginMap
          },
          warnings: [
            ...pendingWarnings,
            ...stagedSources.flatMap((source) => source.staged.warnings)
          ],
          sources: stagedSources.map((source) => ({
            pluginName: source.pluginName,
            pluginSource: source.pluginSource,
            pluginVersion: source.pluginVersion,
            pluginConfig: source.pluginConfig,
            sourceName: source.sourceName,
            selectedFields: source.selectedFields,
            candidates: source.staged.candidates
          }))
        })
      })
      mediaAssetStore.cleanupVideoScrapeStagingPaths(persisted.obsoletePaths)
      return {
        ok: true,
        pending: true,
        pendingScrapeId: persisted.pendingScrapeId,
        skipped: true,
        warnings: getPendingVideoScrapeForVideo(videoId)?.warnings ?? collected.warnings,
        classifications: []
      }
    }

    const classificationOptions = {
      directorSelectionId: options?.directorSelectionId,
      directorAmbiguity: options?.directorAmbiguity ?? ('preserve' as const)
    }
    const classificationPreflight = videoScrapeApplyService.preflightClassifications(
      videoId,
      result,
      fieldsToApply,
      mode,
      classificationOptions
    )
    if (classificationPreflight.directorChoice) {
      return {
        ok: true,
        result,
        skipped: true,
        warnings: classificationPreflight.warnings,
        classifications: classificationPreflight.classifications,
        directorChoice: classificationPreflight.directorChoice
      }
    }
    const previousPending = getPendingVideoScrapeForVideo(videoId)
    let replacedPendingStagedPaths: string[] = []
    const delivery = await videoScrapeApplyService.deliverParsedResult({
      videoId,
      code: video.code,
      result,
      selectedFields: effective,
      fieldsToApply,
      mode,
      sourceName,
      ratingSourceName,
      classificationOptions,
      fetcher: (url) => scrapeBrowser.fetchBuffer(url),
      afterSuccessfulApply: previousPending
        ? () => {
            const deleted = deletePendingVideoScrape(previousPending.id)
            if (!deleted) throw new Error('待确认影片刮削结果已发生变化')
            replacedPendingStagedPaths = deleted.stagedPaths
          }
        : undefined
    })
    mediaAssetStore.cleanupVideoScrapeStagingPaths(replacedPendingStagedPaths)

    return {
      ok: true,
      result,
      skipped: !delivery.applied,
      warnings: [...collected.warnings, ...delivery.warnings],
      classifications: delivery.classifications,
      directorChoice: delivery.directorChoice
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
