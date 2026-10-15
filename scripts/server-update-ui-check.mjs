import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

const repository = process.cwd()
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-upgrade-ui-'))
let server, browser
try {
  server = await createServer({ configFile: false, root: path.join(repository, 'scripts/ui-regression'), cacheDir: path.join(temporary, '.vite'), plugins: [react()],
    resolve: { alias: { '@shared': path.join(repository, 'packages/contracts/src'), react: path.join(repository, 'node_modules/react'), 'react-dom': path.join(repository, 'node_modules/react-dom') } }, server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [repository] } } })
  await server.listen()
  browser = await chromium.launch({ ...(process.env.JAVDEX_BROWSER_EXECUTABLE ? { executablePath: process.env.JAVDEX_BROWSER_EXECUTABLE } : { channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome' }), headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const address = server.httpServer.address()
  const url = `http://127.0.0.1:${address.port}/server-update.html`
  const card = page.getByRole('region', { name: '服务端升级', exact: true })
  await page.goto(`${url}?unpaired=1`)
  await card.getByText('请先在资料库连接中连接此服务端。', { exact: true }).waitFor()
  assert.equal(await card.getByRole('textbox').count(), 0)
  assert.equal(await card.getByRole('button', { name: '在线升级', exact: true }).isDisabled(), true)
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1000, height: 640 }]) {
    await page.setViewportSize(viewport)
    for (const theme of ['light', 'graphite']) {
      for (const offline of [false, true]) {
        await page.goto(`${url}?theme=${theme}`)
        await card.getByRole('button', { name: '在线升级', exact: true }).waitFor()
        assert.equal(await card.getByRole('switch').count(), 0)
        assert.equal(await card.getByText('更新授权', { exact: true }).count(), 0)
        const entry = card.getByRole('button', { name: offline ? '上传离线包升级' : '在线升级', exact: true })
        if (!offline) {
          await page.evaluate(() => { window.failUpdateCheck = true })
          await entry.click()
          await card.getByRole('alert').waitFor()
          await card.getByRole('button', { name: '展开详情', exact: true }).click()
          await card.getByText(/发布签名配置/).last().waitFor()
          await page.evaluate(() => { window.failUpdateCheck = false })
        }
        await entry.click()
        await card.getByText('升级包已就绪', { exact: true }).waitFor()
        await card.getByRole('button', { name: '确认升级', exact: true }).click()
        const confirm = page.getByRole('dialog', { name: '升级服务端至 0.9.0-beta.4', exact: true })
        await confirm.waitFor()
        assert.equal(await page.evaluate(() => window.updateCalls.some(call => call.action === 'install')), false)
        await confirm.getByRole('button', { name: '停服并升级', exact: true }).click()
        const progress = card.getByRole('list', { name: '升级进度' })
        await progress.getByText('验证服务', { exact: true }).waitFor()
        assert.equal(await progress.getByText('备份资料库', { exact: true }).count(), 0)
        const calls = await page.evaluate(() => window.updateCalls.filter(call => call.action !== 'status'))
        assert.ok(calls.every(call => call.targetVersion === '0.9.0-beta.4'))
        assert.ok(calls.every(call => !Object.hasOwn(call, 'backupBeforeUpgrade')))
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        fs.mkdirSync('out/server-update-ui', { recursive: true })
        await page.screenshot({ path: `out/server-update-ui/${theme}-${viewport.width}-${offline ? 'offline' : 'online'}.png`, fullPage: true })
        await page.evaluate(() => { window.failUpdateReconnects = 2; window.finishServerUpdate() })
        await page.waitForFunction(() => window.updateReconnects === 3 && window.updateSession.state === 'available')
        await card.waitFor({ state: 'hidden' })
        await page.waitForTimeout(2100)
        assert.equal(await page.evaluate(() => window.updateReconnects), 3)
      }
    }
  }
  assert.deepEqual(errors, [])
  console.log('Server upgrade UI passed: exact desktop target, both entries, no upgrade backup, confirmation, errors, progress, reconnect retry, 2 sizes and 2 themes (fixture RPC, production components).')
} finally { await browser?.close(); await server?.close(); fs.rmSync(temporary, { recursive: true, force: true }) }
