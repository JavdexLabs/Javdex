import type { ScraperPluginDescriptor } from '@shared/scraperPluginTypes'
import type {
  MetadataAssetRef,
  MetadataCandidateBatch,
  VideoMetadataCandidate,
  VideoMetadataSource
} from '../metadata-sources'
import {
  createDefaultLocalNfoSourceAdapter,
  getDefaultNfoFileStore,
  LOCAL_NFO_SUPPORTED_FIELDS,
  VideoMetadataSourceRegistry,
  WebScraperSourceAdapter
} from '../metadata-sources'
import { createVideoMetadataCandidateStager } from '../metadata-sources/videoMetadataCandidateStager'
import type {
  ScrapeResult,
  VideoClassificationResolutionOutcome,
  VideoDirectorChoiceRequired,
  VideoScrapeField,
  VideoScrapeUpdateMode
} from '@shared/videoScrapeTypes'
import { ALL_VIDEO_SCRAPE_FIELDS } from '@shared/videoScrapeTypes'
import {
  LOCAL_NFO_SOURCE_ID,
  LOCAL_NFO_SOURCE_NAME
} from '@shared/videoMetadataSourceConstants'
import { resolveScrapeProxyUrl } from '@shared/settingsTypes'
import { getVideoById, markScrapeFailed } from '@library/db/videoRepo'
import {
  deletePendingVideoScrape,
  getPendingVideoScrapeForVideo,
  replacePendingVideoScrape
} from '@library/db/pendingVideoScrapeRepo'
import {
  findVideoBusinessIdentityConflictForScrape,
  resolveEffectiveVideoScrapeFields,
  videoScrapeApplyService
} from '../services/videoScrapeApplyService'
import { getSettings } from '../settings/settingsStore'
import { isScrapeBrowserBusyError, scrapeBrowser } from './scrapeBrowser'
import { mediaAssetStore } from '@library/mediaAssetStore'

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
import {
  mergeVideoScrapeResults,
  projectVideoScrapeResult
} from './videoScrapeFieldProjection'

function buildRegistry(): Map<string, BaseScraper> {
  return buildPluginRegistry(loadUserVideoScrapers, loadBundledVideoScrapers)
}

function buildSourceRegistry(
  proxyUrl: string,
  delayController?: ScrapeVideoOptions['delayController']
): VideoMetadataSourceRegistry {
  const scrapers = buildRegistry()
  const descriptors = listMergedPluginDescriptors('video')
  const sources: VideoMetadataSource[] = []
  for (const descriptor of descriptors) {
    if (descriptor.source === 'composite' || descriptor.configured === false) continue
    const scraper = scrapers.get(descriptor.name)
    if (!scraper) continue
    sources.push(
      new WebScraperSourceAdapter({
        scraper,
        plugin: descriptor,
        proxyUrl,
        runWithDelay: delayController
          ? (pluginName, task) => delayController.run('video', pluginName, task)
          : undefined
      })
    )
  }
  sources.push(createDefaultLocalNfoSourceAdapter(getDefaultNfoFileStore()))
  return new VideoMetadataSourceRegistry(sources)
}

function localNfoPluginDescriptor(): ScraperPluginDescriptor {
  return {
    kind: 'video',
    name: LOCAL_NFO_SOURCE_NAME,
    version: '1.0.0',
    description: '读取影片资源旁经过安全校验的本地 NFO；不会持续同步。',
    author: 'Javdex',
    source: 'builtin',
    removable: false,
    exportable: false,
    editable: false,
    debuggable: false,
    configured: true,
    supportedFields: [...LOCAL_NFO_SUPPORTED_FIELDS]
  }
}

function sourceForName(
  registry: VideoMetadataSourceRegistry,
  name: string
): VideoMetadataSource {
  return name === LOCAL_NFO_SOURCE_NAME || name === LOCAL_NFO_SOURCE_ID
    ? registry.require(LOCAL_NFO_SOURCE_ID)
    : registry.requireLegacyPlugin(name)
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
      .map((plugin) => plugin.name),
    LOCAL_NFO_SOURCE_NAME
  ]
}

export function listScraperPlugins(): ScraperPluginDescriptor[] {
  return [...listMergedPluginDescriptors('video'), localNfoPluginDescriptor()]
}

/** Main-process source catalog; renderer-facing plugin APIs remain unchanged in milestone 1. */
export function listVideoMetadataSources() {
  const settings = getSettings()
  return buildSourceRegistry(resolveScrapeProxyUrl(settings)).list()
}

function assertVideoScraperRunnable(name: string): ScraperPluginDescriptor {
  if (name === LOCAL_NFO_SOURCE_NAME || name === LOCAL_NFO_SOURCE_ID) {
    return localNfoPluginDescriptor()
  }
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

interface CompositeVideoCandidateSource {
  pluginName: string
  descriptor: ScraperPluginDescriptor | undefined
  selectedFields: VideoScrapeField[]
  supportedFields: Set<VideoScrapeField>
  candidates: VideoMetadataCandidate[]
}

interface CompositeVideoOutcome {
  result: ScrapeResult | null
  assets: MetadataAssetRef[]
  matchedFields: VideoScrapeField[]
  sources: CompositeVideoCandidateSource[]
  warnings: string[]
  quietNoMatch: boolean
}

function projectCompositeCandidateAssets(
  candidate: VideoMetadataCandidate,
  selectedFields: ReadonlySet<VideoScrapeField>,
  actressOffset: number
): MetadataAssetRef[] {
  const actressPositions = new Map<number, number>()
  let projectedPosition = actressOffset
  for (const [position, actress] of (candidate.result.actresses ?? []).entries()) {
    const gender = actress.gender ?? 'female'
    const selected =
      (gender === 'female' && selectedFields.has('actressesFemale')) ||
      (gender === 'male' && selectedFields.has('actressesMale'))
    if (!selected) continue
    actressPositions.set(position, projectedPosition)
    projectedPosition += 1
  }

  return candidate.assets.flatMap((asset): MetadataAssetRef[] => {
    if (asset.field === 'cover') return selectedFields.has('cover') ? [asset] : []
    if (asset.field === 'samples') return selectedFields.has('samples') ? [asset] : []
    const position = actressPositions.get(asset.position)
    return position == null ? [] : [{ ...asset, position }]
  })
}

async function scrapeCompositeVideo(
  videoId: number,
  videoCode: string,
  compositeName: string,
  effectiveFields: VideoScrapeField[],
  sourceRegistry: VideoMetadataSourceRegistry
): Promise<CompositeVideoOutcome | null> {
  const composite = findCompositeScraper('video', compositeName)
  if (!composite) return null
  const grouped = new Map<string, VideoScrapeField[]>()
  for (const field of effectiveFields) {
    const pluginName = composite.fieldPluginMap[field]
    if (!pluginName) continue
    grouped.set(pluginName, [...(grouped.get(pluginName) ?? []), field])
  }
  const descriptors = listScraperPlugins()
  const quietNoMatch =
    grouped.size > 0 &&
    [...grouped.keys()].every(
      (name) => name === LOCAL_NFO_SOURCE_NAME || name === LOCAL_NFO_SOURCE_ID
    )
  const sources: CompositeVideoCandidateSource[] = []
  const warnings: string[] = []
  let merged: ScrapeResult | null = null
  const assets: MetadataAssetRef[] = []
  const matchedFields: VideoScrapeField[] = []
  for (const [pluginName, selectedFields] of grouped) {
    assertVideoScraperRunnable(pluginName)
    const source = sourceForName(sourceRegistry, pluginName)
    const descriptor = descriptors.find((item) => item.name === pluginName)
    const supportedFields = new Set(source.descriptor.supportedFields)
    const collected = await source.collect({
      target: { kind: 'video', videoId, code: videoCode },
      fields: selectedFields
    })
    warnings.push(...collected.warnings.map((warning) => `字段源「${pluginName}」：${warning}`))
    if (collected.candidates.length === 0) continue
    sources.push({ pluginName, descriptor, selectedFields, supportedFields, candidates: collected.candidates })
    const selected = new Set(selectedFields)
    const candidate = collected.candidates[0]
    const projected = projectVideoScrapeResult(candidate.result, selected, videoCode)
    assets.push(
      ...projectCompositeCandidateAssets(
        candidate,
        selected,
        merged?.actresses?.length ?? 0
      )
    )
    matchedFields.push(...selectedFields)
    merged = mergeVideoScrapeResults(merged, projected)
  }
  return { result: merged, assets, matchedFields, sources, warnings, quietNoMatch }
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
  if (resolvedName === LOCAL_NFO_SOURCE_NAME || resolvedName === LOCAL_NFO_SOURCE_ID) {
    return { sourceName: LOCAL_NFO_SOURCE_NAME, ratingSourceName: LOCAL_NFO_SOURCE_NAME }
  }
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
  const sourceRegistry = buildSourceRegistry(proxy, options?.delayController)
  const source = findCompositeScraper('video', scraperName || settings.defaultScraper)
    ? null
    : sourceForName(sourceRegistry, resolvedScraperName)
  const { sourceName, ratingSourceName } = resolveVideoFieldSourceNames(
    source ? { scraperName: source.descriptor.name } : null,
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
    const compositeOutcome = source
      ? null
      : await scrapeCompositeVideo(
          videoId,
          video.code,
          scraperName || settings.defaultScraper,
          effective,
          sourceRegistry
        )
    const collected: MetadataCandidateBatch = source
      ? await source.collect({
          target: { kind: 'video', videoId, code: video.code },
          fields: effective
        })
      : {
          candidates: compositeOutcome?.result
            ? [
                {
                  result: compositeOutcome.result,
                  assets: compositeOutcome.assets,
                  evidence: {
                    kind: 'web-scraper',
                    sourceId: `composite:${encodeURIComponent(resolvedScraperName)}`,
                    sourceName: resolvedScraperName
                  }
                }
              ]
            : [],
          warnings: compositeOutcome?.warnings ?? []
        }
    const candidate = collected.candidates[0]
    const result = candidate?.result
    if (!result) {
      if (
        source?.descriptor.kind === 'local-nfo' ||
        compositeOutcome?.quietNoMatch
      ) {
        return { ok: true, skipped: true, warnings: collected.warnings }
      }
      markScrapeFailed(videoId)
      return {
        ok: false,
        error: '未找到匹配的元数据',
        warnings: collected.warnings
      }
    }

    const hasAmbiguousSource = source
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
        const candidateStager = createVideoMetadataCandidateStager({
          fetchRemote: (url) => scrapeBrowser.fetchBuffer(url),
          readManagedRootFile: async (capability) =>
            getDefaultNfoFileStore().readBytes(capability, 64 * 1024 * 1024)
        })
        const stagedSources = source
          ? [
              {
                pluginName: resolvedScraperName,
                pluginSource: descriptor?.source ?? ('builtin' as const),
                pluginVersion: descriptor?.version ?? null,
                pluginConfig: { supportedFields: [...supportedFields] },
                sourceName,
                selectedFields: effective,
                staged: await candidateStager.stageForPending(collected.candidates)
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
                staged: await candidateStager.stageForPending(source.candidates)
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
    const candidateStager = createVideoMetadataCandidateStager({
      fetchRemote: (url) => scrapeBrowser.fetchBuffer(url),
      readManagedRootFile: async (capability) =>
        getDefaultNfoFileStore().readBytes(capability, 64 * 1024 * 1024)
    })
    const delivery = await videoScrapeApplyService.deliverCandidate({
      videoId,
      code: video.code,
      candidate,
      candidateStager,
      selectedFields: effective,
      fieldsToApply,
      mode,
      sourceName,
      ratingSourceName,
      classificationOptions,
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
    if (!isScrapeBrowserBusyError(err)) markScrapeFailed(videoId)
    return { ok: false, error: (err as Error).message }
  } finally {
    if (options?.closeBrowser !== false) {
      scrapeBrowser.close()
    }
  }
}
