import { dialog } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  ActressBatchScrapeFilter,
  ActressBatchScrapeRequest,
  ActressScrapeField,
  ActressScrapeResult,
  ActressScrapeUpdateMode,
  BatchProgress,
  BatchScrapeState,
  CompositeScraperInput,
  ScraperPluginDescriptor,
  ScraperPluginKind,
  ScraperPluginUpdateInput,
  VideoBatchScrapeFilter,
  VideoBatchScrapeRequest,
  VideoBatchScrapeStatus,
  VideoScrapeField,
  VideoScrapeOneResult,
  VideoScrapeUpdateMode,
  VideoRematchBatchRequest,
  VideoRematchScope
} from '@shared/types'
import { ALL_VIDEO_SCRAPE_FIELDS, DEFAULT_SETTINGS } from '@shared/types'
import {
  listActressScraperNames,
  listActressScraperPlugins,
  scrapeActress
} from '../scrapers/actressScraperManager'
import { listScraperNames, listScraperPlugins, scrapeVideo } from '../scrapers/scraperManager'
import {
  deleteScraperPlugin,
  createCompositeScraper,
  deleteCompositeScraper,
  exportScraperPluginPackage,
  importScraperPluginPackage,
  pluginPackageDefaultName,
  readScraperPluginPackage,
  updateCompositeScraper,
  updateScraperPluginConfig
} from '../scrapers/scraperPluginService'
import { actressScrapeQueue } from '../services/actressScrapeQueue'
import {
  assertBatchScrapeAvailable,
  getBatchScrapeState
} from '../services/batchScrapeControl'
import { loadBatchScrapeJob, saveBatchScrapeJob } from '../services/batchScrapeJobStore'
import { scrapeRunCoordinator } from '../services/scrapeRunCoordinator'
import { videoBatchScrapeQueue } from '../services/videoBatchScrapeQueue'
import { countActressesForBatchScrape } from '../db/actressRepo'
import { countVideosForBatchScrape, countVideosForRematch } from '../db/videoRepo'
import { getSettings, updateSettings } from '../settings/settingsStore'
import { registerHandler, type IpcContext } from './shared'

export function registerScrapeHandlers(ctx: IpcContext): void {
  const interrupted = loadBatchScrapeJob()
  if (interrupted?.status === 'running') {
    saveBatchScrapeJob({ ...interrupted, status: 'paused' })
  }

  registerHandler(IPC.SCRAPER_LIST, (): string[] => listScraperNames())

  registerHandler(IPC.SCRAPER_PLUGIN_DETAILS, (): ScraperPluginDescriptor[] =>
    listScraperPlugins()
  )

  registerHandler(IPC.PLUGIN_IMPORT, async (): Promise<ScraperPluginDescriptor | null> =>
    importPluginWithDialog(ctx)
  )

  registerHandler(IPC.SCRAPER_PLUGIN_EXPORT, async (_e, name: string): Promise<string | null> =>
    exportPluginWithDialog(ctx, 'video', name)
  )

  registerHandler(
    IPC.SCRAPER_PLUGIN_PACKAGE,
    (_e, name: string) => readScraperPluginPackage('video', name)
  )

  registerHandler(
    IPC.SCRAPER_PLUGIN_UPDATE,
    (_e, name: string, input: ScraperPluginUpdateInput): ScraperPluginDescriptor =>
      updateScraperPluginConfig('video', name, input)
  )

  registerHandler(IPC.SCRAPER_PLUGIN_DELETE, (_e, name: string): boolean => {
    const ok = deleteScraperPlugin('video', name)
    if (getSettings().defaultScraper === name) {
      updateSettings({ defaultScraper: DEFAULT_SETTINGS.defaultScraper })
    }
    return ok
  })

  registerHandler(
    IPC.SCRAPER_COMPOSITE_CREATE,
    (_e, input: CompositeScraperInput): ScraperPluginDescriptor =>
      createCompositeScraper('video', input)
  )

  registerHandler(
    IPC.SCRAPER_COMPOSITE_UPDATE,
    (_e, name: string, input: CompositeScraperInput): ScraperPluginDescriptor =>
      updateCompositeScraper('video', name, input)
  )

  registerHandler(IPC.SCRAPER_COMPOSITE_DELETE, (_e, name: string): boolean => {
    const ok = deleteCompositeScraper('video', name)
    if (getSettings().defaultScraper === name) {
      updateSettings({ defaultScraper: DEFAULT_SETTINGS.defaultScraper })
    }
    return ok
  })

  registerHandler(
    IPC.SCRAPE_ONE,
    async (
      _e,
      videoId: number,
      scraperName?: string,
      fields?: VideoScrapeField[],
      mode?: VideoScrapeUpdateMode
    ): Promise<VideoScrapeOneResult> => {
      assertBatchScrapeAvailable()
      const outcome = await scrapeRunCoordinator.runExclusive('影片刮削', () =>
        scrapeVideo(videoId, scraperName, { fields, mode })
      )
      if (!outcome.ok || !outcome.result) throw new Error(outcome.error)
      return { result: outcome.result, applied: !outcome.skipped }
    }
  )

  registerHandler(IPC.SCRAPE_BATCH_START, (_e, scraperName?: string): boolean => {
    return startVideoBatch(ctx, IPC.SCRAPE_BATCH_PROGRESS, {
      scraperName,
      status: 0,
      fields: ALL_VIDEO_SCRAPE_FIELDS,
      mode: 'replace'
    })
  })

  registerHandler(IPC.SCRAPE_BATCH_CANCEL, (): boolean => pauseVideoBatch())

  registerHandler(IPC.BATCH_SCRAPE_STATE, (): BatchScrapeState => getBatchScrapeState())

  registerHandler(IPC.BATCH_SCRAPE_PAUSE, (): boolean => pauseActiveBatch())

  registerHandler(IPC.BATCH_SCRAPE_RESUME, (): boolean => resumeActiveBatch(ctx))

  registerHandler(IPC.BATCH_SCRAPE_DISCARD, (): boolean => discardActiveBatch(ctx))

  registerHandler(
    IPC.SCRAPE_VIDEO_BATCH_COUNT,
    (_e, filter: VideoBatchScrapeFilter): number => countVideosForBatchScrape(filter)
  )

  registerHandler(
    IPC.SCRAPE_VIDEO_BATCH_START,
    (_e, request: VideoBatchScrapeRequest): boolean =>
      startVideoBatch(ctx, IPC.SCRAPE_VIDEO_BATCH_PROGRESS, request)
  )

  registerHandler(IPC.SCRAPE_VIDEO_BATCH_CANCEL, (): boolean => pauseVideoBatch())

  registerHandler(IPC.SCRAPE_REMATCH_COUNT, (_e, scope: VideoRematchScope): number =>
    countVideosForRematch(scope)
  )

  registerHandler(IPC.SCRAPE_REMATCH_BATCH_START, (_e, request: VideoRematchBatchRequest): boolean => {
    return startVideoBatch(ctx, IPC.SCRAPE_REMATCH_BATCH_PROGRESS, {
      scraperName: request.scraperName,
      fields: request.fields,
      status: rematchScopeToBatchStatus(request.scope),
      mode: request.mode ?? 'replace'
    })
  })

  registerHandler(IPC.SCRAPE_REMATCH_BATCH_CANCEL, (): boolean => pauseVideoBatch())

  registerHandler(IPC.ACTRESS_SCRAPER_LIST, (): string[] => listActressScraperNames())

  registerHandler(IPC.ACTRESS_SCRAPER_PLUGIN_DETAILS, (): ScraperPluginDescriptor[] =>
    listActressScraperPlugins()
  )

  registerHandler(
    IPC.ACTRESS_SCRAPER_PLUGIN_EXPORT,
    async (_e, name: string): Promise<string | null> => exportPluginWithDialog(ctx, 'actress', name)
  )

  registerHandler(
    IPC.ACTRESS_SCRAPER_PLUGIN_PACKAGE,
    (_e, name: string) => readScraperPluginPackage('actress', name)
  )

  registerHandler(
    IPC.ACTRESS_SCRAPER_PLUGIN_UPDATE,
    (_e, name: string, input: ScraperPluginUpdateInput): ScraperPluginDescriptor =>
      updateScraperPluginConfig('actress', name, input)
  )

  registerHandler(IPC.ACTRESS_SCRAPER_PLUGIN_DELETE, (_e, name: string): boolean => {
    const ok = deleteScraperPlugin('actress', name)
    if (getSettings().defaultActressScraper === name) {
      updateSettings({ defaultActressScraper: 'Xslist' })
    }
    return ok
  })

  registerHandler(
    IPC.ACTRESS_SCRAPER_COMPOSITE_CREATE,
    (_e, input: CompositeScraperInput): ScraperPluginDescriptor =>
      createCompositeScraper('actress', input)
  )

  registerHandler(
    IPC.ACTRESS_SCRAPER_COMPOSITE_UPDATE,
    (_e, name: string, input: CompositeScraperInput): ScraperPluginDescriptor =>
      updateCompositeScraper('actress', name, input)
  )

  registerHandler(IPC.ACTRESS_SCRAPER_COMPOSITE_DELETE, (_e, name: string): boolean => {
    const ok = deleteCompositeScraper('actress', name)
    if (getSettings().defaultActressScraper === name) {
      updateSettings({ defaultActressScraper: 'Xslist' })
    }
    return ok
  })

  registerHandler(
    IPC.ACTRESS_SCRAPE_ONE,
    async (
      _e,
      actressId: number,
      scraperName?: string,
      fields?: ActressScrapeField[],
      mode?: ActressScrapeUpdateMode,
      queryName?: string,
      useAliases?: boolean
    ): Promise<ActressScrapeResult> => {
      assertBatchScrapeAvailable()
      const outcome = await scrapeRunCoordinator.runExclusive('演员刮削', () =>
        scrapeActress(actressId, scraperName, { fields, mode, queryName, useAliases })
      )
      if (!outcome.ok || !outcome.result) throw new Error(outcome.error)
      return outcome.result
    }
  )

  registerHandler(
    IPC.ACTRESS_SCRAPE_BATCH_COUNT,
    (_e, filter: ActressBatchScrapeFilter): number => countActressesForBatchScrape(filter)
  )

  registerHandler(
    IPC.ACTRESS_SCRAPE_BATCH_START,
    (_e, request?: ActressBatchScrapeRequest | string): boolean => startActressBatch(ctx, request)
  )

  registerHandler(IPC.ACTRESS_SCRAPE_BATCH_CANCEL, (): boolean => pauseActressBatch())
}

function pauseVideoBatch(): boolean {
  if (!videoBatchScrapeQueue.isRunning()) return false
  videoBatchScrapeQueue.pause()
  return true
}

function pauseActressBatch(): boolean {
  if (!actressScrapeQueue.isRunning()) return false
  actressScrapeQueue.pause()
  return true
}

function pauseActiveBatch(): boolean {
  if (videoBatchScrapeQueue.isRunning()) return pauseVideoBatch()
  if (actressScrapeQueue.isRunning()) return pauseActressBatch()
  return false
}

function resumeActiveBatch(ctx: IpcContext): boolean {
  assertCanResumeBatch()
  const job = loadBatchScrapeJob()
  if (!job) throw new Error('没有可继续的批量刮削任务')
  const win = ctx.getWindow()
  if (job.kind === 'video') {
    videoBatchScrapeQueue.setListener((progress: BatchProgress) => {
      win?.webContents.send(IPC.SCRAPE_VIDEO_BATCH_PROGRESS, progress)
    })
    void scrapeRunCoordinator
      .runExclusive('影片批量更新', () => videoBatchScrapeQueue.resume())
      .catch((err) => console.error('video batch scrape resume failed:', err))
    return true
  }
  actressScrapeQueue.setListener((progress: BatchProgress) => {
    win?.webContents.send(IPC.ACTRESS_SCRAPE_BATCH_PROGRESS, progress)
  })
  void scrapeRunCoordinator
    .runExclusive('演员批量刮削', () => actressScrapeQueue.resume())
    .catch((err) => console.error('actress batch scrape resume failed:', err))
  return true
}

function discardActiveBatch(ctx: IpcContext): boolean {
  const job = loadBatchScrapeJob()
  if (!job) return false
  if (job.kind === 'video') {
    videoBatchScrapeQueue.discard()
    if (!videoBatchScrapeQueue.isRunning()) {
      ctx.getWindow()?.webContents.send(IPC.SCRAPE_VIDEO_BATCH_PROGRESS, idleBatchProgress())
    }
    return true
  }
  actressScrapeQueue.discard()
  if (!actressScrapeQueue.isRunning()) {
    ctx.getWindow()?.webContents.send(IPC.ACTRESS_SCRAPE_BATCH_PROGRESS, idleBatchProgress())
  }
  return true
}

function idleBatchProgress(): BatchProgress {
  return {
    total: 0,
    current: 0,
    success: 0,
    failed: 0,
    currentCode: null,
    status: 'idle',
    logs: []
  }
}

function startActressBatch(
  ctx: IpcContext,
  request?: ActressBatchScrapeRequest | string
): boolean {
  assertCanStartNewBatch()
  if (typeof request !== 'string' && request && !request.fields?.length) {
    throw new Error('请至少选择一个要更新的字段')
  }
  const win = ctx.getWindow()
  actressScrapeQueue.setListener((progress: BatchProgress) => {
    win?.webContents.send(IPC.ACTRESS_SCRAPE_BATCH_PROGRESS, progress)
  })
  void scrapeRunCoordinator
    .runExclusive('演员批量刮削', () => actressScrapeQueue.start(request))
    .catch((err) => console.error('actress scrape batch failed:', err))
  return true
}

function rematchScopeToBatchStatus(scope: VideoRematchScope): VideoBatchScrapeStatus {
  if (scope === 'scraped') return 1
  if (scope === 'failed') return 2
  return 'all'
}

function startVideoBatch(
  ctx: IpcContext,
  progressChannel: string,
  request: VideoBatchScrapeRequest
): boolean {
  assertCanStartNewBatch()
  if (!request.fields?.length) throw new Error('请至少选择一个要更新的字段')
  const win = ctx.getWindow()
  videoBatchScrapeQueue.setListener((progress: BatchProgress) => {
    win?.webContents.send(progressChannel, progress)
  })
  void scrapeRunCoordinator
    .runExclusive('影片批量更新', () => videoBatchScrapeQueue.start(request))
    .catch((err) => console.error('video batch scrape failed:', err))
  return true
}

async function importPluginWithDialog(ctx: IpcContext): Promise<ScraperPluginDescriptor | null> {
  const res = await dialog.showOpenDialog(ctx.getWindow()!, {
    properties: ['openFile'],
    filters: [
      { name: 'Scraper Plugin Package', extensions: ['json', 'avscraper'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  })
  if (res.canceled || !res.filePaths[0]) return null
  return importScraperPluginPackage(res.filePaths[0])
}

async function exportPluginWithDialog(
  ctx: IpcContext,
  kind: ScraperPluginKind,
  name: string
): Promise<string | null> {
  const res = await dialog.showSaveDialog(ctx.getWindow()!, {
    defaultPath: pluginPackageDefaultName(kind, name),
    filters: [
      { name: 'Scraper Plugin Package', extensions: ['json', 'avscraper'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  })
  if (res.canceled || !res.filePath) return null
  exportScraperPluginPackage(kind, name, res.filePath)
  return res.filePath
}

function assertCanStartNewBatch(): void {
  assertBatchScrapeAvailable()
  if (videoBatchScrapeQueue.isRunning()) throw new Error('影片批量更新已在进行中')
  if (actressScrapeQueue.isRunning()) throw new Error('演员批量刮削已在进行中')
}

function assertCanResumeBatch(): void {
  if (scrapeRunCoordinator.isRunning()) {
    throw new Error(`${scrapeRunCoordinator.getActiveLabel()}进行中，请稍后再试`)
  }
  if (videoBatchScrapeQueue.isRunning() || actressScrapeQueue.isRunning()) {
    throw new Error('批量刮削已在进行中')
  }
  if (!loadBatchScrapeJob()) {
    throw new Error('没有可继续的批量刮削任务')
  }
}
