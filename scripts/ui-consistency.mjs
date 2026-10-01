import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

const repo = process.cwd()
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-ui-consistency-'))
let server, browser
const results = []
try {
  server = await createServer({ configFile: false, root: path.join(repo, 'scripts/ui-consistency'),
    cacheDir: path.join(output, '.vite'), plugins: [react()],
    resolve: { alias: { '@shared': path.join(repo, 'packages/contracts/src'), react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1000, height: 640 }]) {
    for (const theme of ['graphite', 'light']) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
      await page.getByRole('button', { name: '打开编辑', exact: true }).click()
      await page.getByLabel('主名', { exact: true }).fill('长中文导演名称')
      const translate = page.getByRole('button', { name: 'AI 译中', exact: true })
      const translateBounds = await translate.boundingBox()
      assert.ok(translateBounds.width >= 24 && translateBounds.height >= 24)
      const save = page.getByRole('button', { name: '保存', exact: true })
      const before = await save.boundingBox()
      await save.click()
      await page.waitForFunction(() => typeof window.__release === 'function')
      const during = await save.boundingBox()
      assert.equal(during.width, before.width)
      assert.equal(during.x, before.x)
      assert.equal(await save.isDisabled(), true)
      assert.equal(await save.evaluate(el => getComputedStyle(el, '::before').animationName), 'none')
      await page.keyboard.press('Escape')
      assert.equal(await page.getByRole('dialog').count(), 1)
      await page.evaluate(() => window.__release())
      await page.getByText('操作未完成，可重试或查看错误详情', { exact: true }).click()
      assert.equal(await page.getByLabel('主名', { exact: true }).inputValue(), '长中文导演名称')
      assert.equal(await page.getByRole('alert').count(), 1)
      await save.scrollIntoViewIfNeeded()
      const bounds = await save.boundingBox()
      assert.ok(bounds.y + bounds.height <= viewport.height)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(output, `${viewport.width}-${theme}-error.png`) })
      await save.click()
      await page.waitForFunction(() => window.__calls === 2)
      await page.evaluate(() => window.__release())
      await page.getByRole('dialog').waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), '打开编辑')
      await page.getByRole('button', { name: '显示错误', exact: true }).click()
      await page.screenshot({ path: path.join(output, `${viewport.width}-${theme}-toast-summary.png`) })
      await page.getByRole('button', { name: '查看详情', exact: true }).click()
      const details = page.getByRole('dialog')
      assert.ok((await details.innerText()).includes('请检查服务端连接后重试'))
      await page.getByRole('button', { name: '关闭', exact: true }).focus()
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), '复制')
      await page.screenshot({ path: path.join(output, `${viewport.width}-${theme}-toast.png`) })
      await page.keyboard.press('Escape')
      await details.waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), '查看详情')
      assert.deepEqual(errors, [])
      results.push({ viewport, theme, before, during, errors })
      await page.close()
    }
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ output, passed: results.length }))
} finally {
  await browser?.close()
  await server?.close()
}
