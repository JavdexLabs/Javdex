// Native Electron: click the React scan button, then close/recreate the window
// while a remote scan is stalled. Do not import scanHandlers (better-sqlite3).
require('./register-test-paths.cjs')
require('tsx/cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const esbuild = require('esbuild')
const { app, BrowserWindow, ipcMain } = require('electron')
const ipcChannels = require('../packages/contracts/src/ipc-channels.ts')
const IPC = ipcChannels.IPC || ipcChannels.default?.IPC || ipcChannels
const {
  bindMainWindow,
  registerMainWindowBinder
} = require('../apps/desktop/src/main/desktop/mainWindowBindings.ts')
const { createRemoteCatalogBackend } = require('../apps/desktop/src/main/backends/remote/remoteCatalogBackend.ts')
const { waitForCatalogTask } = require('../apps/desktop/src/main/application/catalogTaskProgress.ts')
const { ipcMutation } = require('../apps/desktop/src/main/application/mutationContext.ts')
const { appCommandAdapter, appEventAdapter } = require('../apps/desktop/src/main/ipc/appContractAdapter.ts')
const {
  runRemoteScanThroughBackend,
  abortRemoteCatalogScanWait
} = require('../apps/desktop/src/main/ipc/scanRemoteRun.ts')
const { configureIpcSecurity } = require('../apps/desktop/src/main/ipc/ipcSecurity.ts')

app.setPath('userData', process.env.JAVDEX_TEST_USER_DATA)
app.disableHardwareAcceleration()
app.on('window-all-closed', () => undefined)

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} required`)
  return value
}

async function waitClosed(window) {
  if (window.isDestroyed()) return
  await new Promise((resolve) => window.once('closed', resolve))
}

async function waitPath(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`missing ${filePath}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function bundleRenderer(outDir) {
  const outfile = path.join(outDir, 'd05-scan-console.js')
  const htmlPath = path.join(outDir, 'd05-scan-console.html')
  await esbuild.build({
    absWorkingDir: process.cwd(),
    entryPoints: [path.resolve('scripts/d05-scan-console-renderer.tsx')],
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    logLevel: 'silent',
    alias: {
      '@shared': path.resolve('packages/contracts/src')
    },
    loader: {
      '.module.css': 'local-css',
      '.css': 'css'
    }
  })
  fs.writeFileSync(
    htmlPath,
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>扫描导入</title>
    <style>
      :root {
        --surface-elevated: #1c1c22;
        --surface-control-hover: #26262e;
        --text-primary: #f4f4f5;
        --border-subtle: #3f3f46;
        --border-strong: #71717a;
        --control-h-md: 36px;
        --radius-md: 8px;
        --motion-fast: 120ms;
      }
      body {
        margin: 0;
        padding: 24px;
        background: #101014;
        color: var(--text-primary);
        font-family: system-ui, sans-serif;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script src="./d05-scan-console.js"></script>
  </body>
</html>
`
  )
  return htmlPath
}

async function waitForScanButton(window) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const label = await window.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('[data-ui="button"]')
        return button && !button.disabled ? button.textContent : ''
      })()`
    )
    if (typeof label === 'string' && label.includes('扫描并导入')) return label
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('scan button was not ready')
}

async function run() {
  const baseUrl = requiredEnv('JAVDEX_TEST_REMOTE_BASE')
  const secret = requiredEnv('JAVDEX_TEST_WRITER_SECRET')
  const catalogId = requiredEnv('JAVDEX_TEST_CATALOG_ID')
  const appVersion = requiredEnv('JAVDEX_TEST_APP_VERSION')
  const stallPath = requiredEnv('JAVDEX_TEST_STALL_PATH')
  const userData = requiredEnv('JAVDEX_TEST_USER_DATA')
  const acceptedPath = path.join(userData, 'd05-scan-accepted.json')
  const secrets = new Map([[catalogId, secret]])
  const backend = createRemoteCatalogBackend({
    baseUrl,
    appVersion,
    credentials: {
      async isAvailable() {
        return true
      },
      async readWriterSecret(id) {
        return secrets.get(id) ?? null
      },
      async writeWriterSecret(id, value) {
        secrets.set(id, value)
      },
      async deleteWriterSecret(id) {
        secrets.delete(id)
      }
    }
  })
  const innerRunScan = backend.libraries.runScan.bind(backend.libraries)
  backend.libraries.runScan = async (input, ctx) => {
    const accepted = await innerRunScan(input, ctx)
    fs.writeFileSync(acceptedPath, JSON.stringify(accepted))
    return accepted
  }

  await app.whenReady()
  const htmlPath = await bundleRenderer(userData)
  const rendererUrl = pathToFileURL(htmlPath).href
  let mainWindow = null
  const getWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)
  configureIpcSecurity({
    getWindow,
    isTrustedUrl(url) {
      try {
        return new URL(url).pathname === new URL(rendererUrl).pathname
      } catch {
        return false
      }
    }
  })
  ipcMain.handle('javdex-d05-scan-console-window', () => 'ok')

  appCommandAdapter.register(IPC.SCAN_RUN, async (libraryId) =>
    runRemoteScanThroughBackend(backend, libraryId, (task) => {
      appEventAdapter.send(getWindow()?.webContents, IPC.SCAN_PROGRESS, {
        libraryId: task.libraryId ?? libraryId,
        runId: task.taskId,
        progress: {
          scanned: task.counts?.scanned ?? 0,
          imported: task.counts?.imported ?? 0,
          currentFile: task.label ?? ''
        }
      })
    })
  )
  appCommandAdapter.register(IPC.SCAN_CANCEL, async (runId) => {
    await backend.tasks.cancel({ taskId: runId }, ipcMutation())
    return true
  })
  appCommandAdapter.register(IPC.SCAN_AUDIT_HEADER, (libraryId) => backend.libraries.auditHeader({ libraryId }))

  const boundOwners = new WeakSet()
  const bindCounts = []
  const stopBinder = registerMainWindowBinder((window) => {
    const webContents = window.webContents
    if (!webContents || boundOwners.has(webContents)) return
    boundOwners.add(webContents)
    bindCounts.push(webContents.id)
  })

  function createWindow() {
    return new BrowserWindow({
      show: true,
      width: 640,
      height: 480,
      backgroundColor: '#101014',
      webPreferences: {
        preload: path.resolve('scripts/test-d05-scan-console-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
  }

  const first = createWindow()
  mainWindow = first
  bindMainWindow(first)
  await first.loadURL(rendererUrl)
  const firstId = first.webContents.id
  assert.deepEqual(bindCounts, [firstId])
  const buttonLabel = await waitForScanButton(first)
  const clicked = await first.webContents.executeJavaScript(
    `(() => {
      const button = document.querySelector('[data-ui="button"]')
      if (!button || button.disabled) return false
      button.click()
      return true
    })()`
  )
  assert.equal(clicked, true, 'renderer scan button click')

  await waitPath(acceptedPath, 15_000)
  await waitPath(`${stallPath}.ready`, 15_000)
  const accepted = JSON.parse(fs.readFileSync(acceptedPath, 'utf8'))
  assert.equal(typeof accepted.taskId, 'string', JSON.stringify(accepted))
  const operationId = accepted.receipt?.operationId
  assert.equal(typeof operationId, 'string', JSON.stringify(accepted))

  first.close()
  await waitClosed(first)
  assert.equal(first.isDestroyed(), true)
  mainWindow = null

  const second = createWindow()
  mainWindow = second
  bindMainWindow(second)
  await second.loadURL(rendererUrl)
  bindMainWindow(second)
  const secondId = second.webContents.id
  assert.notEqual(secondId, firstId)
  assert.deepEqual(bindCounts, [firstId, secondId])
  const secondLabel = await waitForScanButton(second)
  assert.equal(secondLabel.includes('扫描并导入'), true)
  assert.equal(await second.webContents.executeJavaScript('1+1'), 2)

  assert.equal(abortRemoteCatalogScanWait(accepted.taskId), true)

  const receipt = await backend.tasks.getOperation({ operationId })
  assert.equal(receipt.operationId, operationId, JSON.stringify(receipt))
  assert.equal(['acceptedTask', 'applied'].includes(receipt.status), true, JSON.stringify(receipt))

  fs.writeFileSync(`${stallPath}.done`, 'afterEnumerate')
  const terminal = await waitForCatalogTask({
    backend,
    taskId: accepted.taskId,
    timeoutMs: 60_000,
    intervalMs: 50
  })
  assert.equal(['succeeded', 'needsInspection'].includes(terminal.state), true, JSON.stringify(terminal))

  second.close()
  await waitClosed(second)
  stopBinder()
  ipcMain.removeHandler('javdex-d05-scan-console-window')
  await backend.dispose()
  console.log(
    `D05_SCAN_CONSOLE_WINDOW_CLOSE_OK ${JSON.stringify({
      operationId,
      taskId: accepted.taskId,
      receiptStatus: receipt.status,
      taskState: terminal.state,
      buttonLabel,
      rendererClicked: true,
      ipcRegisteredOnce: true
    })}`
  )
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
