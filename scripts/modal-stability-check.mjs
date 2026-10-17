import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

const repo = process.cwd()
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-modal-stability-'))
let server, browser
try {
  server = await createServer({ configFile: false, root: path.join(repo, 'scripts/ui-regression'),
    cacheDir: path.join(temporary, '.vite'), plugins: [react()],
    resolve: { alias: { '@shared': path.join(repo, 'packages/contracts/src'), react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') } },
    server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [repo] } } })
  await server.listen()
  browser = await chromium.launch({ ...(process.env.JAVDEX_BROWSER_EXECUTABLE
    ? { executablePath: process.env.JAVDEX_BROWSER_EXECUTABLE } : { channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome' }), headless: true })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1000, height: 640 }]) {
    for (const theme of ['slate', 'light']) {
      for (const mode of ['move', 'loading', 'editor', 'compact']) {
      const compact = mode === 'compact'
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      const scrollMutation = process.env.JAVDEX_MODAL_SCROLL_MUTATION === 'clip' ? '&scroll-mutation=clip' : ''
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/modal-stability.html?theme=${theme}${mode === 'editor' ? '' : `&${mode}=1`}${scrollMutation}`)
      const dialog = page.getByRole('dialog', { name: mode === 'move' ? '移动资源到其它媒体库'
        : compact ? '紧凑确认' : mode === 'loading' ? '动态表单' : '编辑导演资料', exact: true })
      await dialog.waitFor()
      if (mode === 'move') await page.waitForFunction(() =>
        !document.querySelector('[data-modal-part="actions"] button:last-child').disabled)
      const frame = () => dialog.evaluate(element => {
        const bounds = target => { const { x, y, width, height } = target.getBoundingClientRect(); return { x, y, width, height } }
        return { outer: bounds(element), head: bounds(element.querySelector('[data-modal-part="head"]')),
          actions: bounds(element.querySelector('[data-modal-part="actions"]')) }
      })
      let before = await frame()
      const body = dialog.locator('[data-modal-part="body"]')
      const stable = async phase => {
        if (compact && phase !== 'busy') return
        const after = await frame()
        for (const part of Object.keys(before)) for (const dimension of Object.keys(before[part])) {
          assert.ok(Math.abs(after[part][dimension] - before[part][dimension]) < 1,
            `${viewport.width}/${theme}/${mode} ${phase}: ${part}.${dimension} ${before[part][dimension]} -> ${after[part][dimension]}`)
        }
      }
      if (compact) assert.ok(before.outer.height < 320, 'a simple confirmation must stay naturally compact')
      if (mode === 'move') {
        await dialog.getByRole('button', { name: '读取影响', exact: true }).click()
        await page.waitForFunction(() => document.querySelector('[role="dialog"]').getAttribute('aria-busy') === 'true')
        await stable('preview busy')
        await page.evaluate(() => window.finishMovePreview())
        await dialog.getByRole('button', { name: '确认移动', exact: true }).waitFor()
        await stable('loaded move preview')
        assert.deepEqual(await page.evaluate(() => window.movePreviewCalls), [[1, 2, 1]])
        assert.deepEqual(errors, [])
        console.log(`Modal layout policy: ${viewport.width}x${viewport.height}/${theme}/${mode}, busy/preview PASS`)
        await page.close()
        continue
      }
      if (mode === 'loading') {
        assert.ok((await body.boundingBox()).height >= 240, 'a dynamic form must reserve usable body space before its fields arrive')
        await page.evaluate(() => window.finishModalLoading())
        await dialog.getByLabel('名称', { exact: true }).waitFor()
        await stable('loaded fields')
        await dialog.getByLabel('备注', { exact: true }).fill('保留草稿')
      }
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('[role="dialog"]').getAttribute('aria-busy') === 'true')
      await stable('busy')
      const draftField = compact ? null : dialog.getByLabel(mode === 'editor' ? '主名' : '备注', { exact: true })
      // A user can return to the draft while the pending save completes; feedback must not steal that focus.
      await draftField?.click()
      await page.evaluate(() => window.rejectModalSave())
      await dialog.getByRole('alert').waitFor()
      await stable('failed')
      if (draftField) assert.equal(await draftField.evaluate(element => document.activeElement === element), true,
        'asynchronous failure must preserve focus in the existing draft field')
      await dialog.getByText('操作未完成，可重试或查看错误详情', { exact: true }).click()
      await stable('expanded error')
      if (mode === 'editor') assert.equal(await dialog.getByLabel('主名', { exact: true }).inputValue(), '合成导演')
      if (mode === 'loading') assert.equal(await dialog.getByLabel('备注', { exact: true }).inputValue(), '保留草稿')
      const details = dialog.locator('[role="alert"] details p')
      await details.scrollIntoViewIfNeeded()
      await details.evaluate(element => {
        element.scrollTop = 0
        if (location.search.includes('scroll-mutation=clip')) element.style.overflowY = 'clip'
      })
      await details.hover()
      await page.mouse.wheel(0, 3000)
      await page.waitForFunction(() => {
        const element = document.querySelector('[role="alert"] details p')
        const text = element.firstChild
        const marker = text.textContent.lastIndexOf('合成错误详情末尾')
        const range = document.createRange()
        range.setStart(text, marker)
        range.setEnd(text, text.textContent.length)
        const lastLine = range.getBoundingClientRect()
        const pane = element.getBoundingClientRect()
        const body = element.closest('[data-modal-part="body"]').getBoundingClientRect()
        return element.scrollTop > 0 && lastLine.top >= Math.max(pane.top, body.top) - 1
          && lastLine.bottom <= Math.min(pane.bottom, body.bottom) + 1
      }, undefined, { timeout: 5000 })
      assert.ok(await details.evaluate(element => element.scrollTop) > 0,
        'a real mouse wheel must scroll the feedback pane until its final line is visible')
      await stable('wheel scrolling')
      await page.evaluate(() => {
        window.fixtureResizeSettled = new Promise(resolve => window.addEventListener('resize',
          () => requestAnimationFrame(() => requestAnimationFrame(resolve)), { once: true }))
      })
      await page.setViewportSize({ width: 900, height: 480 })
      await page.evaluate(() => window.fixtureResizeSettled)
      await page.waitForFunction(() => {
        const box = document.querySelector('[role="dialog"]').getBoundingClientRect()
        return box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
      }, undefined, { timeout: 5000 })
      before = await frame()
      assert.ok(before.outer.x >= 0 && before.outer.y >= 0 && before.outer.x + before.outer.width <= 900 && before.outer.y + before.outer.height <= 480, `resized frame must remain in the viewport: ${JSON.stringify(before.outer)}`)
      await dialog.getByText('操作未完成，可重试或查看错误详情', { exact: true }).click()
      await stable('collapse after resize')
      assert.deepEqual(errors, [])
      console.log(`Modal layout policy: ${viewport.width}x${viewport.height}/${theme}/${mode}, loading/busy/error/details/scroll/focus/resize PASS`)
      await page.close()
      }
    }
  }
} finally {
  await browser?.close()
  await server?.close()
  fs.rmSync(temporary, { recursive: true, force: true })
}
