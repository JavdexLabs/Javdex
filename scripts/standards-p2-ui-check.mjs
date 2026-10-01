import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'
import { installStableScreenshots } from './lib/stable-screenshot.mjs'

const repo = process.cwd()
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-standards-p2-'))
const scenarios = process.argv[2] ? [process.argv[2]] : ['posterRemoval', 'classificationImage']
assert.ok(scenarios.every(name => ['posterRemoval', 'classificationImage'].includes(name)), 'Unknown Standards P2 scenario')
const results = []
let server, browser
try {
  server = await createServer({ configFile: false, root: path.join(repo, 'scripts/css-module-migration'),
    cacheDir: path.join(output, '.vite'), plugins: [react()],
    resolve: { alias: { '@shared': path.join(repo, 'packages/contracts/src'), react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
  await server.listen()
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1000, height: 640 }, { width: 480, height: 640 }]) {
    for (const theme of ['graphite', 'light']) for (const scenario of scenarios) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
      installStableScreenshots(page)
      page.setDefaultTimeout(3000)
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/standards-p2.html?scenario=${scenario}`)
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
      if (scenario === 'classificationImage') {
        const dialog = page.getByRole('dialog', { name: '管理导演主图', exact: true })
        const chooser = page.waitForEvent('filechooser')
        await dialog.getByRole('button', { name: '选择图片', exact: true }).click()
        await (await chooser).setFiles({ name: 'selected.png', mimeType: 'image/png',
          buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF0sAAAAASUVORK5CYII=', 'base64') })
        await dialog.getByText('待保存主图', { exact: true }).waitFor()
        assert.equal(await dialog.locator('[data-classification-image-preview] img').evaluate(async image => {
          await image.decode()
          return image.naturalWidth > 0
        }), true, 'Selected image must be a usable preview')
        const save = dialog.getByRole('button', { name: '保存主图', exact: true })
        await save.click()
        const summary = dialog.locator('summary')
        await summary.waitFor()
        await summary.focus()
        await page.keyboard.press('Enter')
        assert.equal(await summary.evaluate(el => el.parentElement.open), true)
        const error = dialog.getByRole('alert').locator('p')
        const metrics = await error.evaluate(el => {
          const rect = el.getBoundingClientRect()
          const clips = []
          for (let parent = el.parentElement; parent; parent = parent.parentElement) {
            if (!['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(parent).overflowY)) continue
            const box = parent.getBoundingClientRect()
            clips.push({ top: box.top, bottom: box.bottom })
          }
          return { top: rect.top, bottom: rect.bottom, height: rect.height, scrollHeight: el.scrollHeight, clips }
        })
        assert.ok(metrics.scrollHeight > metrics.height, 'Fixture must need error-detail scrolling')
        // Bring the details into view using native scrolling, not DOM scrollTop assignments.
        const bodyBounds = await dialog.locator('[data-modal-part="body"]').boundingBox()
        await page.mouse.move(bodyBounds.x + 8, bodyBounds.y + 8)
        await page.mouse.wheel(0, 10000)
        const bounds = await error.boundingBox()
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + Math.min(bounds.height / 2, 30))
        await page.mouse.wheel(0, 10000)
        await page.waitForFunction(() => {
          const paragraph = document.querySelector('[role="alert"] p')
          return paragraph.scrollTop + paragraph.clientHeight >= paragraph.scrollHeight - 1
        })
        const end = await error.evaluate(el => {
          const text = el.firstChild
          const range = document.createRange()
          range.setStart(text, text.textContent.lastIndexOf('错误详情末尾'))
          range.setEnd(text, text.textContent.length)
          const rect = range.getBoundingClientRect()
          let visible = rect.top >= 0 && rect.bottom <= innerHeight
          for (let parent = el; parent; parent = parent.parentElement) {
            if (!['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(parent).overflowY)) continue
            const box = parent.getBoundingClientRect()
            visible &&= rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1
          }
          return { top: rect.top, bottom: rect.bottom, visible }
        })
        await page.screenshot({ path: path.join(output, `${viewport.width}-${theme}-classification-error-end.png`) })
        assert.equal(end.visible, true, `Error end must be visible through every scroll/clip ancestor: ${JSON.stringify({ metrics, end })}`)
        assert.equal(await error.evaluate(el => getComputedStyle(el).userSelect), 'text')
        await dialog.getByText('待保存主图', { exact: true }).waitFor()
        await save.click()
        await dialog.waitFor({ state: 'detached' })
        await page.getByRole('status').getByText('主图保存完成', { exact: true }).waitFor()
        assert.deepEqual(errors, [])
        results.push({ name: scenario, viewport, theme, metrics, end })
        await page.close()
        continue
      }
      const card = page.locator('[data-video-card]')
      const remove = card.getByRole('button', { name: '从清单移出 P2-001', exact: true })
      await card.hover()
      await page.screenshot({ path: path.join(output, `${viewport.width}-${theme}-poster-hover.png`) })
      const hover = await remove.evaluate(el => ({ opacity: getComputedStyle(el).opacity, pointerEvents: getComputedStyle(el).pointerEvents }))
      assert.equal(hover.opacity, '1', 'Hovered playlist removal must be visible')
      assert.equal(hover.pointerEvents, 'auto', 'Hovered playlist removal must accept pointer input')
      // No force or DOM click: Playwright must hit the actual visible control.
      await remove.click()
      assert.equal(await page.getByRole('status', { name: '移出反馈', exact: true }).innerText(), '已请求从清单移出')
      assert.equal(await page.getByLabel('当前路由').innerText(), '/playlists/1', 'Removal must not open video details')
      await page.mouse.move(viewport.width - 4, viewport.height - 4)
      await page.waitForFunction(() => getComputedStyle(document.querySelector('button[aria-label="从清单移出 P2-001"]')).opacity === '0')
      assert.equal(await remove.evaluate(el => getComputedStyle(el).opacity), '0', 'Idle removal must remain unobtrusive')
      await card.focus()
      await page.keyboard.press('Tab')
      await page.waitForFunction(() => getComputedStyle(document.activeElement).opacity === '1')
      assert.equal(await remove.evaluate(el => el === document.activeElement && getComputedStyle(el).opacity === '1'), true,
        'Keyboard entry must reveal and focus the removal control')
      assert.deepEqual(errors, [])
      results.push({ name: 'posterRemoval', viewport, theme, hover })
      await page.close()
    }
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ output, passed: results.length }))
} catch (error) {
  console.error(JSON.stringify({ output, passed: results.length }))
  throw error
} finally {
  await browser?.close()
  await server?.close()
}
