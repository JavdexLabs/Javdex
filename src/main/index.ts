import { app, BrowserWindow, protocol } from 'electron'
import path from 'node:path'
import { APP_DISPLAY_NAME } from '@shared/appIdentity'
import { applyAppIcons, resolveWindowIcon } from './appIcon'
import { configureAppIdentity } from './appPaths'
import { initDatabase, closeDatabase } from './db/database'
import { ensureAssetDirs, assetsRoot, readAssetForServe } from './services/assetService'
import { registerIpcHandlers } from './ipc'
import { scrapeBrowser } from './scrapers/scrapeBrowser'
import { resolveMediaAssetPath, toStoredAssetPath } from './services/mediaProtocol'
import { checkForLatestRelease, shouldRunAutomaticCheck } from './services/appReleaseService'
import { prepareDemoUserData, seedDemoLibrary } from './demo/demoSeed'

let mainWindow: BrowserWindow | null = null

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

function createWindow(): void {
  const icon = resolveWindowIcon()
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
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // electron-vite injects this env var in dev for HMR.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    // Tear down the verification window alongside the main window.
    scrapeBrowser.close()
    mainWindow = null
  })
}

/** Serve files from the media_assets directory through the media:// scheme. */
function registerAssetProtocol(): void {
  protocol.handle('media', (request) => {
    const root = assetsRoot()
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
      const { body, mime } = readAssetForServe(relPosix)
      return new Response(body, {
        headers: { 'Content-Type': mime, ...corsHeaders }
      })
    } catch {
      return new Response('Not Found', { status: 404, headers: corsHeaders })
    }
  })
}

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    applyAppIcons()
    prepareDemoUserData()
    initDatabase()
    ensureAssetDirs()
    seedDemoLibrary()
    registerAssetProtocol()
    registerIpcHandlers(() => mainWindow)
    createWindow()
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
      closeDatabase()
      app.quit()
    }
  })

  app.on('before-quit', () => {
    scrapeBrowser.close()
    closeDatabase()
  })
}
