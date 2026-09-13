// Native Electron: close and recreate the main window while a remote scan is stalled.
require('./register-test-paths.cjs')
require('tsx/cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { app, BrowserWindow, ipcMain } = require('electron')
const ipcChannels = require('../packages/contracts/src/ipc-channels.ts')
const IPC = ipcChannels.IPC || ipcChannels.default?.IPC || ipcChannels
const {
  bindMainWindow,
  registerMainWindowBinder
} = require('../apps/desktop/src/main/desktop/mainWindowBindings.ts')
const { createRemoteCatalogBackend } = require('../apps/desktop/src/main/backends/remote/remoteCatalogBackend.ts')
const { waitForCatalogTask, isAbortError } = require('../apps/desktop/src/main/application/catalogTaskProgress.ts')
const { ipcMutation } = require('../apps/desktop/src/main/application/mutationContext.ts')
const { appEventAdapter } = require('../apps/desktop/src/main/ipc/appContractAdapter.ts')

app.setPath('userData', process.env.JAVDEX_TEST_USER_DATA)
app.disableHardwareAcceleration()
app.on('window-all-closed', () => undefined)

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} required`)
  return value
}

function versionsFrom(library) {
  return {
    L: { generation: 1, revision: library.revision },
    C: { generation: 1, revision: library.config.revision },
    G: { generation: 1, revision: 1 },
    V: { generation: 1, revision: 1 },
    R: { generation: 1, revision: 1 }
  }
}

function createHiddenWindow() {
  return new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
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

async function run() {
  const baseUrl = requiredEnv('JAVDEX_TEST_REMOTE_BASE')
  const secret = requiredEnv('JAVDEX_TEST_WRITER_SECRET')
  const catalogId = requiredEnv('JAVDEX_TEST_CATALOG_ID')
  const appVersion = requiredEnv('JAVDEX_TEST_APP_VERSION')
  const operationId = requiredEnv('JAVDEX_TEST_OPERATION_ID')
  const stallPath = requiredEnv('JAVDEX_TEST_STALL_PATH')
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

  await app.whenReady()
  let mainWindow = null
  const getWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)
  ipcMain.handle('javdex-d05-task-window', () => 'ok')

  const boundOwners = new WeakSet()
  const bindCounts = []
  const stopBinder = registerMainWindowBinder((window) => {
    const webContents = window.webContents
    if (!webContents || boundOwners.has(webContents)) return
    boundOwners.add(webContents)
    bindCounts.push(webContents.id)
  })

  const first = createHiddenWindow()
  mainWindow = first
  bindMainWindow(first)
  await first.loadURL('about:blank')
  const firstId = first.webContents.id
  assert.deepEqual(bindCounts, [firstId])

  const library = await backend.libraries.get({ libraryId: 1 })
  const accepted = await backend.libraries.runScan({ libraryId: 1 }, ipcMutation(operationId, versionsFrom(library)))
  assert.equal(typeof accepted.taskId, 'string', JSON.stringify(accepted))
  const abort = new AbortController()
  const waiting = waitForCatalogTask({
    backend,
    taskId: accepted.taskId,
    timeoutMs: 60_000,
    intervalMs: 50,
    signal: abort.signal,
    onApplied: (task) => {
      appEventAdapter.send(getWindow()?.webContents, IPC.SCAN_PROGRESS, {
        libraryId: task.libraryId ?? 1,
        runId: task.taskId,
        progress: {
          scanned: task.counts?.scanned ?? 0,
          imported: task.counts?.imported ?? 0,
          currentFile: task.label ?? ''
        }
      })
    }
  })

  await waitPath(`${stallPath}.ready`, 15_000)
  first.close()
  await waitClosed(first)
  assert.equal(first.isDestroyed(), true)
  mainWindow = null

  const second = createHiddenWindow()
  mainWindow = second
  bindMainWindow(second)
  await second.loadURL('about:blank')
  bindMainWindow(second)
  const secondId = second.webContents.id
  assert.notEqual(secondId, firstId)
  assert.deepEqual(bindCounts, [firstId, secondId])
  assert.equal(await second.webContents.executeJavaScript('1+1'), 2)

  abort.abort()
  await waiting.then(
    () => {
      throw new Error('in-flight scan wait must abort after the window is recreated')
    },
    (error) => {
      assert.equal(isAbortError(error), true, error instanceof Error ? error.message : String(error))
    }
  )

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
  ipcMain.removeHandler('javdex-d05-task-window')
  await backend.dispose()
  console.log(
    `D05_TASK_WINDOW_CLOSE_OK ${JSON.stringify({
      operationId,
      taskId: accepted.taskId,
      receiptStatus: receipt.status,
      taskState: terminal.state,
      scanRunHandles: 1
    })}`
  )
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
