// Run in Electron (not ELECTRON_RUN_AS_NODE) to close and recreate a real BrowserWindow.
require('./register-test-paths.cjs')
require('tsx/cjs')
const assert = require('node:assert/strict')
const { app, BrowserWindow, ipcMain } = require('electron')
const {
  bindMainWindow,
  registerMainWindowBinder
} = require('../apps/desktop/src/main/desktop/mainWindowBindings.ts')

app.setPath('userData', process.env.JAVDEX_TEST_USER_DATA)
app.disableHardwareAcceleration()
app.on('window-all-closed', () => undefined)

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

async function run() {
  await app.whenReady()
  const boundOwners = new WeakSet()
  const bindCounts = []
  const stop = registerMainWindowBinder((window) => {
    const webContents = window.webContents
    if (!webContents || boundOwners.has(webContents)) return
    boundOwners.add(webContents)
    bindCounts.push(webContents.id)
    webContents.on('destroyed', () => undefined)
  })
  ipcMain.handle('javdex-d05-rebind', () => 'ok')
  const handleCountAfterRegister = ipcMain.listenerCount('javdex-d05-rebind')
  try {
    const first = createHiddenWindow()
    bindMainWindow(first)
    await first.loadURL('about:blank')
    const firstId = first.webContents.id
    assert.deepEqual(bindCounts, [firstId])

    first.close()
    await waitClosed(first)
    assert.equal(first.isDestroyed(), true)

    const second = createHiddenWindow()
    bindMainWindow(second)
    await second.loadURL('about:blank')
    bindMainWindow(second)
    const secondId = second.webContents.id
    assert.notEqual(secondId, firstId)
    assert.deepEqual(bindCounts, [firstId, secondId])
    assert.equal(ipcMain.listenerCount('javdex-d05-rebind'), handleCountAfterRegister)
    assert.equal(await second.webContents.executeJavaScript('1+1'), 2)
    second.close()
    await waitClosed(second)
  } finally {
    stop()
    ipcMain.removeHandler('javdex-d05-rebind')
  }
  console.log('D05_NATIVE_WINDOW_REBIND_OK')
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
