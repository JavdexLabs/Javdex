import { app, BrowserWindow, powerMonitor, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_DISPLAY_NAME } from '@shared/appIdentity'
import { applyAppIcons, resolveWindowIcon } from './appIcon'
import { configureAppIdentity } from './appPaths'
import fs from 'node:fs'
import { initDatabaseAtPath, closeDatabase } from './db/database'
import { mediaAssetStore } from './services/mediaAssetStore'
import { registerIpcHandlers } from './ipc'
import { scrapeBrowser } from './scrapers/scrapeBrowser'
import { migrateUserPluginsAwayFromBuiltInNames } from './scrapers/scraperPluginService'
import { resolveMediaAssetPath, toStoredAssetPath } from './services/mediaProtocol'
import { checkForLatestRelease, shouldRunAutomaticCheck } from './services/appReleaseService'
import { cleanupOrphanedActressScrapeStaging } from './services/actressIdentityConflictWorkflow'
import { cleanupOrphanedVideoScrapeStaging } from './services/videoPendingScrapeService'
import { automaticScanScheduler } from './services/automaticScanScheduler'
import { recoverPendingLocalFileDeletions } from './services/pendingLocalFileDeletionService'
import { isSameRendererLocation } from './ipc/ipcSecurity'
import { pluginDeveloper } from './services/pluginDevAgent/pluginDeveloper'
import { initializeAgentPlatform } from './agent-platform/composition'
import { modelManagement } from './agent-platform/modelManagement'
import { libraryCurator } from './services/libraryCuratorAgent/libraryCurator'
import { resolveMainWindowAssetPaths } from './mainWindowPaths'

let mainWindow: BrowserWindow | null = null
let shutdownInProgress = false
let shutdownReady = false

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
  protocol.handle('media', (request) => {
    const root = mediaAssetStore.rootPath()
    const abs = resolveMediaAssetPath(request.url, root)

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }
    if (!abs) {
      return new Response('Forbidden', { status: 403, headers: corsHeaders })
    }
    try {
      const relPosix = toStoredAssetPath(abs, root)
      const { body, mime } = mediaAssetStore.readForServe(relPosix)
      return new Response(body, {
        headers: { 'Content-Type': mime, ...corsHeaders }
      })
    } catch {
      return new Response('Not Found', { status: 404, headers: corsHeaders })
    }
  })
}

if (gotSingleInstanceLock) {
  void app.whenReady().then(async () => {
    applyAppIcons()
    const databaseDir = path.join(app.getPath('userData'), 'data')
    fs.mkdirSync(databaseDir, { recursive: true })
    initDatabaseAtPath(path.join(databaseDir, 'library.db'))
    try {
      modelManagement.read()
    } catch (error) {
      // Model configuration fails closed without preventing non-AI library features from starting.
      console.error(`[model-management] ${(error as Error).message}`)
    }
    initializeAgentPlatform()
    const recoveryFailures = [
      ...await pluginDeveloper.restoreRecoverableRuns(),
      ...await libraryCurator.restoreRecoverableRuns()
    ]
    for (const failure of recoveryFailures) {
      console.error(`[agent-recovery:${failure.runId}] ${failure.error}`)
    }
    recoverPendingLocalFileDeletions()
    mediaAssetStore.ensureReady()
    cleanupOrphanedActressScrapeStaging()
    cleanupOrphanedVideoScrapeStaging()
    migrateUserPluginsAwayFromBuiltInNames()
    registerAssetProtocol()
    const rendererEntryUrl = resolveRendererEntryUrl()
    createWindow(rendererEntryUrl)
    registerIpcHandlers(
      () => mainWindow,
      (url) => isSameRendererLocation(url, rendererEntryUrl)
    )
    automaticScanScheduler.start()
    powerMonitor.on('resume', handleSystemResume)
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
    automaticScanScheduler.stop()
    powerMonitor.off('resume', handleSystemResume)
    void Promise.allSettled([
      pluginDeveloper.dispose(),
      libraryCurator.dispose(),
      scrapeBrowser.dispose()
    ]).finally(() => {
      closeDatabase()
      shutdownReady = true
      app.quit()
    })
  })
}

function handleSystemResume(): void {
  automaticScanScheduler.handleResume()
}
