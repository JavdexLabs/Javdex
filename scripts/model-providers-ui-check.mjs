import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

const repo = process.cwd()
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-provider-list-'))
let server, browser
try {
  server = await createServer({ configFile: false, root: path.join(repo, 'scripts/ui-regression'),
    cacheDir: path.join(temporary, '.vite'), plugins: [react()],
    resolve: { alias: { '@shared': path.join(repo, 'packages/contracts/src'), react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') } },
    server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [repo] } } })
  await server.listen()
  browser = await chromium.launch({ ...(process.env.JAVDEX_BROWSER_EXECUTABLE
    ? { executablePath: process.env.JAVDEX_BROWSER_EXECUTABLE } : { channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome' }), headless: true })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 760, height: 640 }]) for (const theme of ['slate', 'light']) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
    page.setDefaultTimeout(3000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/model-providers.html?theme=${theme}`)
    await page.getByRole('searchbox', { name: '搜索提供商', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: /OpenAI，1 个模型，已配置/ }).count(), 1)
    const toggle = page.getByRole('button', { name: /可用供应商/, exact: false })
    assert.equal(await toggle.count(), 0, 'available providers intentionally have no collapse control')
    const gemini = page.getByRole('button', { name: '添加 Gemini', exact: true })
    await gemini.waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('button', { name: '添加 DeepSeek', exact: true }).isVisible(), true)
    await gemini.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Gemini', exact: true })
    await dialog.waitFor()
    await dialog.locator('[data-modal-part="head"]').getByRole('button', { name: '关闭', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await gemini.evaluate(element => element === document.activeElement), true)
    await page.evaluate(() => window.refreshProviderFixture())
    assert.equal(await gemini.isVisible(), true, 'snapshot refresh must keep the provider list visible')
    const search = page.getByRole('searchbox', { name: '搜索提供商', exact: true })
    await search.fill('Gemini')
    await gemini.waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('button', { name: '添加 DeepSeek', exact: true }).count(), 0)
    await search.fill('OpenAI')
    assert.equal(await gemini.count(), 0)
    await search.fill('')
    assert.equal(await toggle.count(), 0)
    assert.equal(await gemini.isVisible(), true)
    assert.equal(await page.getByRole('button', { name: '添加 DeepSeek', exact: true }).isVisible(), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'narrow provider grid must not widen the page')
    assert.equal(await page.evaluate(() => window.fixtureProviderWrites), 0, 'search, snapshot refresh and cancellation cannot persist configuration')
    assert.deepEqual(errors, [])
    console.log(`Visible provider list: ${viewport.width}x${viewport.height}/${theme}, no-collapse/keyboard/search/refresh/modal-focus PASS`)
    await page.close()
  }
} finally {
  await browser?.close()
  await server?.close()
  fs.rmSync(temporary, { recursive: true, force: true })
}
