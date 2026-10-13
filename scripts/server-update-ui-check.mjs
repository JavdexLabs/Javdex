import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

const repository = process.cwd()
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-update-ui-'))
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
  await page.goto(`http://127.0.0.1:${address.port}/server-update.html?unpaired=1`)
  const pairing = page.getByRole('region', { name: '服务端更新', exact: true })
  await pairing.getByText('未配对', { exact: true }).waitFor()
  await pairing.getByRole('textbox', { name: '容器生成的配对信息', exact: true }).fill('{"fixture":"pairing"}')
  await pairing.getByRole('button', { name: '配对更新管理器', exact: true }).click()
  await pairing.getByText('已配对', { exact: true }).waitFor()
  assert.equal(await pairing.getByRole('textbox').count(), 0, 'pairing input is cleared and removed after success')
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1000, height: 640 }]) {
    await page.setViewportSize(viewport)
    for (const theme of ['light', 'graphite']) {
      await page.goto(`http://127.0.0.1:${address.port}/server-update.html`)
      const card = page.getByRole('region', { name: '服务端更新', exact: true })
      await card.getByText('已配对', { exact: true }).waitFor()
      await page.evaluate(theme => window.setUpdateTheme(theme), theme)
      const check = card.getByRole('button', { name: '检查更新', exact: true })
      const before = await check.boundingBox()
      const cardBefore = await card.boundingBox()
      await page.evaluate(() => { window.failUpdateCheck = true })
      await check.click()
      await card.getByRole('alert').waitFor()
      assert.deepEqual(await check.boundingBox(), before, 'failure preserves button geometry')
      assert.deepEqual(await card.boundingBox(), cardBefore, 'failure uses the same feedback line')
      await card.getByRole('button', { name: '查看详情', exact: true }).click()
      const detail = page.getByRole('dialog', { name: '操作详情', exact: true })
      await detail.waitFor()
      assert.match(await detail.innerText(), /发布签名配置/)
      await detail.getByRole('button', { name: '关闭', exact: true }).last().click()
      await page.evaluate(() => { window.failUpdateCheck = false })
      await check.click()
      await card.getByRole('button', { name: '准备在线更新', exact: true }).click()
      await card.getByText('更新包已就绪', { exact: true }).waitFor()
      await card.getByRole('button', { name: '安装更新', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: '更新服务端至 0.8.1', exact: true })
      await confirm.waitFor()
      assert.equal(await page.evaluate(() => window.updateCalls.includes('install')), false, 'opening confirmation does not stop the server')
      await confirm.getByRole('button', { name: '停服并更新', exact: true }).click()
      await card.getByText('验证服务', { exact: true }).waitFor()
      assert.equal(await card.getByRole('button', { name: '安装更新', exact: true }).isDisabled(), true)
      await page.evaluate(() => window.finishServerUpdate())
      await card.getByText('更新完成', { exact: true }).waitFor()
      assert.equal(await card.getByRole('button', { name: '准备在线更新', exact: true }).isDisabled(), true)
      await page.waitForFunction(() => window.updateReconnects === 1)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      fs.mkdirSync('out/server-update-ui', { recursive: true })
      await page.screenshot({ path: `out/server-update-ui/${theme}-${viewport.width}.png`, fullPage: true })
    }
  }
  await page.goto(`http://127.0.0.1:${address.port}/server-update.html`)
  const retryCard = page.getByRole('region', { name: '服务端更新', exact: true })
  await retryCard.getByText('已配对', { exact: true }).waitFor()
  await retryCard.getByRole('button', { name: '检查更新', exact: true }).click()
  await retryCard.getByRole('button', { name: '准备在线更新', exact: true }).click()
  await retryCard.getByRole('button', { name: '安装更新', exact: true }).click()
  await page.getByRole('button', { name: '停服并更新', exact: true }).click()
  await page.evaluate(() => { window.failUpdateReconnects = 2; window.finishServerUpdate() })
  await page.waitForFunction(() => window.updateReconnects === 3 && window.updateSession.state === 'available')
  await page.waitForTimeout(2500)
  assert.equal(await page.evaluate(() => window.updateReconnects), 3, 'healthy session stops reconnect retries')
  assert.deepEqual(errors, [])
  console.log('Server update UI passed: mismatch access, confirmation, persistent error details, progress, reconnect retry, 2 sizes and 2 themes (fixture RPC, production components).')
} finally { await browser?.close(); await server?.close(); fs.rmSync(temporary, { recursive: true, force: true }) }
