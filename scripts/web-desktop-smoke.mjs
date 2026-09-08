// Exercises the actual Electron IPC/lifecycle with an isolated userData directory.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { _electron as electron } from 'playwright-core'
import { createPackage } from '@electron/asar'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-web-desktop-'))
const output = process.env.JAVDEX_WEB_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-web-desktop-qa-'))
fs.mkdirSync(output, { recursive: true })
const env = { ...process.env, JAVDEX_TEST_USER_DATA: userData }
delete env.ELECTRON_RUN_AS_NODE
const reservation = net.createServer()
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const archiveSource = path.join(userData, 'archive-source')
fs.mkdirSync(archiveSource)
fs.writeFileSync(path.join(archiveSource, 'index.html'), '<title>Packaged Web</title>')
const archivePath = path.join(userData, 'web-test.asar')
await createPackage(archiveSource, archivePath)
let application
try {
  application = await electron.launch({ args: ['.'], env })
  const archivedPage = await application.evaluate(async (_electron, file) => {
    const fs = process.getBuiltinModule('fs').promises
    const handle = await fs.open(file, 'r')
    try {
      let text = ''
      for await (const chunk of handle.createReadStream({ autoClose: false })) text += chunk.toString()
      return text
    } finally { await handle.close() }
  }, path.join(archivePath, 'index.html'))
  assert.equal(archivedPage, '<title>Packaged Web</title>')
  let page = await application.firstWindow()
  await page.waitForFunction(() => Boolean(window.api?.webAccess))
  assert.equal((await page.evaluate(() => window.api.webAccess.status())).enabled, false)
  await page.evaluate(() => { window.location.hash = '/settings/network/web' })
  await page.getByLabel('访问账号', { exact: true }).waitFor()
  await page.getByLabel('端口', { exact: true }).fill(String(port))
  await page.getByLabel('访问账号', { exact: true }).fill('viewer')
  await page.getByLabel('访问密码', { exact: true }).fill('desktop smoke password')
  await page.getByRole('switch', { name: '启用 Web 服务' }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('服务运行中', { exact: true }).waitFor()
  await page.screenshot({ path: path.join(output, 'desktop-settings.png') })
  const base = `http://127.0.0.1:${port}`
  assert.equal((await fetch(base)).status, 200)
  assert.equal((await fetch(base + '/api/videos')).status, 401)
  const login = async () => fetch(base + '/api/login', { method: 'POST', headers: { Origin: base, 'X-Javdex-Client': 'web', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'viewer', password: 'desktop smoke password' }) })
  const response = await login()
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie').split(';')[0]
  const catalog = await fetch(base + '/api/videos', { headers: { Cookie: cookie } })
  assert.equal(catalog.status, 200)
  assert.equal((await catalog.json()).total, 0)
  const stored = fs.readFileSync(path.join(userData, 'web-access.json'), 'utf8')
  assert.ok(!stored.includes('desktop smoke password'))
  assert.equal((await page.evaluate(() => window.api.webAccess.status())).sessions, 1)
  await application.close()
  application = null
  await assert.rejects(fetch(base))
  application = await electron.launch({ args: ['.'], env })
  page = await application.firstWindow()
  await page.waitForFunction(async () => (await window.api?.webAccess.status())?.running)
  assert.equal((await fetch(base + '/api/videos', { headers: { Cookie: cookie } })).status, 401)
  assert.equal((await login()).status, 200)
  const stopped = await page.evaluate(port => window.api.webAccess.apply({ enabled: false, port, username: 'viewer' }), port)
  assert.equal(stopped.running, false)
  await assert.rejects(fetch(base))
  console.log('Electron settings UI, actual read-only catalog, password persistence, restart/session invalidation and stop PASS')
  console.log(`Screenshot: ${path.join(output, 'desktop-settings.png')}`)
} finally {
  await application?.close()
  fs.rmSync(userData, { recursive: true, force: true })
}
