import { dialog } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { ScraperPluginKind } from '@shared/scraperPluginTypes'
import { createDefaultScrapeJobController } from '../services/scrapeJobController'
import { createDefaultScraperPluginCatalog } from '../services/scraperPluginCatalog'
import { createDefaultScraperServiceConfiguration } from '../services/scraperServiceConfiguration'
import type { IpcContext } from './shared'
import { registerScrapeHandler, sendScrapeEvent } from './scrapeContractAdapter'

export function registerScrapeHandlers(ctx: IpcContext): void {
  const plugins = createDefaultScraperPluginCatalog()
  const serviceConfiguration = createDefaultScraperServiceConfiguration()
  const jobs = createDefaultScrapeJobController({
    rendererAvailable: () => {
      const window = ctx.getWindow()
      return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed())
    },
    emit: (channel, payload) => sendScrapeEvent(ctx.getWindow()?.webContents, channel, payload)
  })
  jobs.initialize()

  const webContents = ctx.getWindow()?.webContents
  webContents?.on('render-process-gone', () => jobs.rendererDisconnected())
  webContents?.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) jobs.rendererDisconnected()
  })

  registerScrapeHandler(IPC.ACTRESS_AVATAR_AUTO_CROP_RESULT, (response) =>
    jobs.completeAvatarAutoCrop(response)
  )

  registerScrapeHandler(IPC.SCRAPER_LIST, () => plugins.listNames('video'))
  registerScrapeHandler(IPC.SCRAPER_PLUGIN_DETAILS, () => plugins.listPlugins('video'))
  registerScrapeHandler(IPC.PLUGIN_IMPORT, () => importPluginWithDialog(ctx, plugins))
  registerScrapeHandler(IPC.SCRAPER_PLUGIN_EXPORT, (name) =>
    exportPluginWithDialog(ctx, plugins, 'video', name)
  )
  registerScrapeHandler(IPC.SCRAPER_PLUGIN_PACKAGE, (name) => plugins.readPackage('video', name))
  registerScrapeHandler(IPC.SCRAPER_PLUGIN_UPDATE, (name, input) =>
    plugins.updatePlugin('video', name, input)
  )
  registerScrapeHandler(IPC.SCRAPER_PLUGIN_DELETE, (name) => plugins.deletePlugin('video', name))
  registerScrapeHandler(IPC.SCRAPER_SERVICE_CONFIG_GET, (serviceId) =>
    serviceConfiguration.get(serviceId)
  )
  registerScrapeHandler(IPC.SCRAPER_SERVICE_CONFIG_SAVE, (serviceId, input) =>
    serviceConfiguration.save(serviceId, input)
  )
  registerScrapeHandler(IPC.SCRAPER_SERVICE_CONFIG_TEST, (serviceId, input) =>
    serviceConfiguration.test(serviceId, input)
  )
  registerScrapeHandler(IPC.SCRAPER_SERVICE_CONFIG_CLEAR, (serviceId) =>
    serviceConfiguration.clear(serviceId)
  )
  registerScrapeHandler(IPC.SCRAPER_COMPOSITE_CREATE, (input) =>
    plugins.createComposite('video', input)
  )
  registerScrapeHandler(IPC.SCRAPER_COMPOSITE_UPDATE, (name, input) =>
    plugins.updateComposite('video', name, input)
  )
  registerScrapeHandler(IPC.SCRAPER_COMPOSITE_DELETE, (name) =>
    plugins.deleteComposite('video', name)
  )

  registerScrapeHandler(IPC.ACTRESS_SCRAPER_LIST, () => plugins.listNames('actress'))
  registerScrapeHandler(IPC.ACTRESS_SCRAPER_PLUGIN_DETAILS, () => plugins.listPlugins('actress'))
  registerScrapeHandler(IPC.ACTRESS_SCRAPER_PLUGIN_EXPORT, (name) =>
    exportPluginWithDialog(ctx, plugins, 'actress', name)
  )
  registerScrapeHandler(IPC.ACTRESS_SCRAPER_PLUGIN_PACKAGE, (name) =>
    plugins.readPackage('actress', name)
  )
  registerScrapeHandler(IPC.ACTRESS_SCRAPER_PLUGIN_UPDATE, (name, input) =>
    plugins.updatePlugin('actress', name, input)
  )
  registerScrapeHandler(IPC.ACTRESS_SCRAPER_PLUGIN_DELETE, (name) =>
    plugins.deletePlugin('actress', name)
  )
  registerScrapeHandler(IPC.ACTRESS_SCRAPER_COMPOSITE_CREATE, (input) =>
    plugins.createComposite('actress', input)
  )
  registerScrapeHandler(IPC.ACTRESS_SCRAPER_COMPOSITE_UPDATE, (name, input) =>
    plugins.updateComposite('actress', name, input)
  )
  registerScrapeHandler(IPC.ACTRESS_SCRAPER_COMPOSITE_DELETE, (name) =>
    plugins.deleteComposite('actress', name)
  )

  registerScrapeHandler(IPC.SCRAPE_ONE, (...args) => jobs.scrapeOneVideo(...args))
  registerScrapeHandler(IPC.PENDING_VIDEO_SCRAPE_LIST, () =>
    jobs.listPendingVideoScrapes()
  )
  registerScrapeHandler(IPC.PENDING_VIDEO_SCRAPE_CONFIRM, (input) =>
    jobs.confirmPendingVideoScrape(input)
  )
  registerScrapeHandler(IPC.PENDING_VIDEO_SCRAPE_DISCARD, (pendingScrapeId) =>
    jobs.discardPendingVideoScrape(pendingScrapeId)
  )
  registerScrapeHandler(IPC.SCRAPE_BATCH_START, (scraperName) =>
    jobs.startLegacyVideoBatch(scraperName)
  )
  registerScrapeHandler(IPC.SCRAPE_BATCH_CANCEL, () => jobs.pauseVideoBatch())
  registerScrapeHandler(IPC.SCRAPE_VIDEO_BATCH_COUNT, (filter) => jobs.countVideoBatch(filter))
  registerScrapeHandler(IPC.SCRAPE_VIDEO_BATCH_START, (request) =>
    jobs.startVideoBatch(IPC.SCRAPE_VIDEO_BATCH_PROGRESS, request)
  )
  registerScrapeHandler(IPC.SCRAPE_VIDEO_BATCH_CANCEL, () => jobs.pauseVideoBatch())
  registerScrapeHandler(IPC.SCRAPE_REMATCH_COUNT, (scope) => jobs.countRematches(scope))
  registerScrapeHandler(IPC.SCRAPE_REMATCH_BATCH_START, (request) =>
    jobs.startRematchBatch(request)
  )
  registerScrapeHandler(IPC.SCRAPE_REMATCH_BATCH_CANCEL, () => jobs.pauseVideoBatch())

  registerScrapeHandler(IPC.ACTRESS_SCRAPE_ONE, (...args) => jobs.scrapeOneActress(...args))
  registerScrapeHandler(IPC.ACTRESS_SCRAPE_BATCH_COUNT, (filter) =>
    jobs.countActressBatch(filter)
  )
  registerScrapeHandler(IPC.ACTRESS_SCRAPE_BATCH_START, (request) =>
    jobs.startActressBatch(request)
  )
  registerScrapeHandler(IPC.ACTRESS_SCRAPE_BATCH_CANCEL, () => jobs.pauseActressBatch())

  registerScrapeHandler(IPC.BATCH_SCRAPE_STATE, () => jobs.getBatchState())
  registerScrapeHandler(IPC.BATCH_SCRAPE_PAUSE, () => jobs.pauseActiveBatch())
  registerScrapeHandler(IPC.BATCH_SCRAPE_RESUME, () => jobs.resumeActiveBatch())
  registerScrapeHandler(IPC.BATCH_SCRAPE_DISCARD, () => jobs.discardActiveBatch())
  registerScrapeHandler(IPC.AVATAR_AUTO_CROP_BATCH_BEGIN, () => jobs.beginAvatarAutoCropBatch())
  registerScrapeHandler(IPC.AVATAR_AUTO_CROP_BATCH_END, (token) =>
    jobs.endAvatarAutoCropBatch(token)
  )
}

async function importPluginWithDialog(
  ctx: IpcContext,
  plugins: ReturnType<typeof createDefaultScraperPluginCatalog>
) {
  const result = await dialog.showOpenDialog(ctx.getWindow()!, {
    properties: ['openFile'],
    filters: [
      { name: 'Scraper Plugin Package', extensions: ['json', 'avscraper'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  })
  if (result.canceled || !result.filePaths[0]) return null
  return plugins.importPackage(result.filePaths[0])
}

async function exportPluginWithDialog(
  ctx: IpcContext,
  plugins: ReturnType<typeof createDefaultScraperPluginCatalog>,
  kind: ScraperPluginKind,
  name: string
): Promise<string | null> {
  const result = await dialog.showSaveDialog(ctx.getWindow()!, {
    defaultPath: plugins.packageDefaultName(kind, name),
    filters: [
      { name: 'Scraper Plugin Package', extensions: ['json', 'avscraper'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  })
  if (result.canceled || !result.filePath) return null
  plugins.exportPackage(kind, name, result.filePath)
  return result.filePath
}
