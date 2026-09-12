import { destroyAppTray, hasAppTray, initializeAppTray, setCloseToTrayEnabled } from './appTray'
import { webAccess } from './web/webAccess'
import { app, BrowserWindow, powerMonitor, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { APP_DISPLAY_NAME } from '@shared/appIdentity'
import { applyAppIcons, resolveWindowIcon } from './appIcon'
import { configureAppIdentity } from './appPaths'
import { getDb } from '@library/db/database'
import { configureDesktopLibraryRuntime } from './libraryRuntime'
import { catalogReadService } from './services/catalogReadService'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { registerIpcHandlers } from './ipc'
import { scrapeBrowser } from './scrapers/scrapeBrowser'
import { migrateUserPluginsAwayFromBuiltInNames } from './scrapers/scraperPluginService'
import { serveMediaAssetRequest } from './services/mediaProtocol'
import { checkForLatestRelease, shouldRunAutomaticCheck } from './services/appReleaseService'
import { cleanupOrphanedActressScrapeStaging } from './services/actressIdentityConflictWorkflow'
import { cleanupOrphanedVideoScrapeStaging } from './services/videoPendingScrapeService'
import { automaticScanScheduler } from './services/automaticScanScheduler'
import { scanCoordinator } from './scanner/scanCoordinator'
import { recoverPendingLocalFileDeletions } from './services/pendingLocalFileDeletionService'
import { isSameRendererLocation } from './ipc/ipcSecurity'
import { pluginDeveloper } from './services/pluginDevAgent/pluginDeveloper'
import { initializeAgentPlatform } from './agent-platform/composition'
import { agentExecution } from './agent-platform/agentExecution'
import { modelManagement } from './agent-platform/modelManagement'
import { libraryCurator } from './services/libraryCuratorAgent/libraryCurator'
import { agentMetadataCollection } from './services/agentMetadata/agentMetadataCollection'
import { resolveMainWindowAssetPaths } from './mainWindowPaths'
import { bootstrapLegacyMediaLibrary } from './services/legacyMediaLibraryBootstrap'
import { getSettings, updateSettings } from './settings/settingsStore'
import { nfoExportTaskController } from './nfo/export/nfoExportTaskController'
import { bindNfoExportWindowGuard } from './nfo/export/nfoExportWindowGuard'
import { createDesktopRuntime, type DesktopRuntime } from './bootstrap/createDesktopRuntime'
import { actressQueryService } from './services/actressQueryService'
import { mediaLibraryService } from './services/mediaLibraryService'
import { videoMaintenanceService } from './services/videoMaintenanceService'
import { videoLifecycleService } from './services/videoLifecycleService'
import { videoQueryService } from './services/videoQueryService'

let mainWindow: BrowserWindow | null = null
let shutdownInProgress = false
let shutdownReady = false
let desktopRuntime: DesktopRuntime | null = null

// Register the custom asset scheme as privileged BEFORE app is ready so the
// renderer can load downloaded covers/avatars via media://covers/xxx.jpg
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

configureAppIdentity()

function focusMainWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    focusMainWindow()
  })
}

function resolveRendererEntryUrl(): string {
  const { renderer } = resolveMainWindowAssetPaths(app.getAppPath())
  return (
    process.env['ELECTRON_RENDERER_URL'] ??
    pathToFileURL(renderer).toString()
  )
}

function createWindow(rendererEntryUrl = resolveRendererEntryUrl()): void {
  const icon = resolveWindowIcon()
  const assets = resolveMainWindowAssetPaths(app.getAppPath())
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#101014',
    show: false,
    autoHideMenuBar: true,
    title: APP_DISPLAY_NAME,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: assets.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isSameRendererLocation(url, rendererEntryUrl)) event.preventDefault()
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  bindNfoExportWindowGuard(mainWindow, nfoExportTaskController, () => shutdownInProgress)
  const window = mainWindow
  window.on('close', (event) => {
    if (event.defaultPrevented || shutdownInProgress || !getSettings().closeToTray || !hasAppTray()) return
    event.preventDefault()
    window.hide()
  })

  // electron-vite injects this env var in dev for HMR.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(assets.renderer)
  }

  mainWindow.on('closed', () => {
    // macOS keeps the application resident, but the scraper helper must not outlive its main window.
    void scrapeBrowser.closeSession().catch((error) => {
      console.error(`[scraper-helper] 主窗口关闭时清理失败：${(error as Error).message}`)
    })
    mainWindow = null
  })
}

/** Serve files from the media_assets directory through the media:// scheme. */
function registerAssetProtocol(): void {
  protocol.handle('media', (request) => serveMediaAssetRequest(request, mediaAssetStore))
}

if (gotSingleInstanceLock) {
  void app.whenReady().then(async () => {
    applyAppIcons()
    configureDesktopLibraryRuntime()
    const runtime = await createDesktopRuntime(app.getPath('userData'), app.getVersion(), {
      local: {
        queries: videoQueryService,
        videos: videoMaintenanceService,
        lifecycle: videoLifecycleService,
        actresses: actressQueryService,
        libraries: mediaLibraryService,
        reads: {
          homeLoad: (input) => catalogReadService.readHome(input),
          homeSearch: (input) => catalogReadService.searchHome(input),
          tagFilterOptions: (query) => catalogReadService.read(query),
          imagePage: (entity, query) => catalogReadService.readImageCandidates(entity, query ?? {})
        }
      }
    })
    desktopRuntime = runtime
    if (runtime.mode === 'local') {
      const libraryBootstrap = bootstrapLegacyMediaLibrary({
        database: getDb(),
        readSettings: getSettings,
        updateSettings
      })
      if (libraryBootstrap.settingsCleanup.status === 'failed') {
        console.error(
          `[media-library-bootstrap] 旧设置清理失败，将在下次启动重试：${libraryBootstrap.settingsCleanup.error}`
        )
      }
      if ((runtime.scanRecovery?.recoveredRunCount ?? 0) > 0) {
        console.warn(
          `[media-library-scan-recovery] 已收敛 ${runtime.scanRecovery?.recoveredRunCount} 个异常中断的扫描任务。`
        )
      }
    }
    try {
      modelManagement.read()
    } catch (error) {
      // Model configuration fails closed without preventing non-AI library features from starting.
      console.error(`[model-management] ${(error as Error).message}`)
    }
    initializeAgentPlatform()
    const recoveryFailures = [
      ...await pluginDeveloper.restoreRecoverableRuns(),
      ...await libraryCurator.restoreRecoverableRuns(),
      ...await agentMetadataCollection.restoreRecoverableRuns()
    ]
    for (const failure of recoveryFailures) {
      console.error(`[agent-recovery:${failure.runId}] ${failure.error}`)
    }
    if (runtime.mode === 'local') {
      recoverPendingLocalFileDeletions()
      mediaAssetStore.ensureReady()
      cleanupOrphanedActressScrapeStaging()
      cleanupOrphanedVideoScrapeStaging()
    }
    migrateUserPluginsAwayFromBuiltInNames()
    registerAssetProtocol()
    const rendererEntryUrl = resolveRendererEntryUrl()
    createWindow(rendererEntryUrl)
    initializeAppTray(() => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow(rendererEntryUrl)
      else focusMainWindow()
    })
    try {
      setCloseToTrayEnabled(getSettings().closeToTray)
    } catch (error) {
      // Leave normal close behavior available when the platform cannot create a tray.
      console.error(`[tray] ${(error as Error).message}`)
    }
    registerIpcHandlers(
      () => mainWindow,
      (url) => isSameRendererLocation(url, rendererEntryUrl),
      {
        backend: runtime.backend,
        videoDesktop:
          runtime.mode === 'local'
            ? { checkLinkResource: (url) => videoMaintenanceService.checkLinkResource(url) }
            : undefined,
        actressDesktop:
          runtime.mode === 'local'
            ? {
                listAvatarCropTargets: () => actressQueryService.listAvatarCropTargets(),
                countAvatarCropTargets: () => actressQueryService.countAvatarCropTargets(),
                listFaceScanManifest: () => actressQueryService.listFaceScanManifest(),
                getTestTarget: (id) => actressQueryService.getTestTarget(id)
              }
            : undefined,
        mediaLibraryDesktop:
          runtime.mode === 'local'
            ? {
                previewRootMigration: (input) => mediaLibraryService.previewRootMigration(input),
                migrateRoot: (input) => mediaLibraryService.migrateRoot(input)
              }
            : undefined
      }
    )
    if (runtime.mode === 'local') {
      await webAccess.initialize()
      automaticScanScheduler.start()
      powerMonitor.on('resume', handleSystemResume)
    }
    setTimeout(() => {
      if (shouldRunAutomaticCheck()) void checkForLatestRelease()
    }, 15_000)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else focusMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', (event) => {
    if (shutdownReady) return
    event.preventDefault()
    if (shutdownInProgress) return
    shutdownInProgress = true
    if (desktopRuntime?.mode === 'local') {
      automaticScanScheduler.stop()
      powerMonitor.off('resume', handleSystemResume)
    }
    let readerTerminationFailed = false
    void Promise.allSettled([
      scanCoordinator.stopAndDrain(),
      catalogReadService.dispose().catch((error: unknown) => {
        readerTerminationFailed = true
        console.error('[catalog-reader] Failed to confirm termination', error)
      }),
      webAccess.stop(),
      pluginDeveloper.dispose(),
      libraryCurator.dispose(),
      agentMetadataCollection.dispose(),
      nfoExportTaskController.dispose()
    ])
      .then(() => Promise.allSettled([
        agentExecution.dispose(),
        scrapeBrowser.dispose(),
        desktopRuntime?.dispose() ?? Promise.resolve()
      ]))
      .finally(() => {
        destroyAppTray()
        if (readerTerminationFailed) {
          // Do not report a clean database shutdown while a native reader may
          // still be alive. Other product cleanup has settled before process exit.
          app.exit(1)
          return
        }
        shutdownReady = true
        app.quit()
      })
  })
}

function handleSystemResume(): void {
  automaticScanScheduler.handleResume()
}
