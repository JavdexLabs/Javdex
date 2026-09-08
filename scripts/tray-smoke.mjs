// Native Electron tray lifecycle, isolated from the user's settings and library.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { _electron as electron } from 'playwright-core'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-tray-'))
const env = { ...process.env, JAVDEX_TEST_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const reservation = net.createServer()
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const base = `http://127.0.0.1:${port}`
let application
try {
  application = await electron.launch({ args: ['.'], env })
  const page = await application.firstWindow()
  await page.waitForFunction(() => Boolean(window.api?.settings))
  assert.equal((await page.evaluate(() => window.api.settings.get())).closeToTray, false)
  await application.evaluate(({ Tray }) => {
    const original = Tray.prototype.setContextMenu
    Tray.prototype.setContextMenu = function (menu) {
      globalThis.trayForTest = this
      globalThis.trayMenuForTest = menu
      return original.call(this, menu)
    }
  })
  await page.evaluate(() => { window.location.hash = '/settings/appearance/theme' })
  const toggle = page.getByRole('switch', { name: '关闭窗口后最小化到系统托盘' })
  await toggle.click()
  await page.waitForFunction(async () => (await window.api.settings.get()).closeToTray)
  const web = await page.evaluate(port => window.api.webAccess.apply({ enabled: true, port, username: 'viewer', password: 'tray smoke password' }), port)
  assert.equal(web.running, true)
  const hidden = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.close()
    return { destroyed: window.isDestroyed(), visible: window.isVisible(), trayAlive: !globalThis.trayForTest.isDestroyed() }
  })
  assert.deepEqual(hidden, { destroyed: false, visible: false, trayAlive: true })
  assert.equal((await fetch(base + '/api/session')).status, 401)
  await application.evaluate(() => globalThis.trayMenuForTest.items.find(item => item.label === '打开主窗口').click())
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true)
  // Disabling a tray while hidden must restore the window before removing its recovery entry.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await page.evaluate(() => window.api.settings.update({ closeToTray: false }))
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true)
  assert.equal(await application.evaluate(() => globalThis.trayForTest.isDestroyed()), true)
  await page.evaluate(() => window.api.settings.update({ closeToTray: true }))
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await application.evaluate(() => globalThis.trayForTest.emit('click'))
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true)
  const exited = application.waitForEvent('close')
  await application.evaluate(() => { globalThis.trayMenuForTest.items.find(item => item.label === '退出 Javdex').click() })
  await exited
  await assert.rejects(fetch(base))
  application = null
  application = await electron.launch({ args: ['.'], env })
  const reopened = await application.firstWindow()
  await reopened.waitForFunction(() => Boolean(window.api?.settings))
  assert.equal((await reopened.evaluate(() => window.api.settings.get())).closeToTray, true)
  const retained = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.close()
    return !window.isDestroyed() && !window.isVisible()
  })
  assert.equal(retained, true)
  console.log('Tray toggle, hide on close, menu restore, click restore, disable recovery, explicit quit and restart persistence PASS')
} finally {
  await application?.close()
  fs.rmSync(userData, { recursive: true, force: true })
}
