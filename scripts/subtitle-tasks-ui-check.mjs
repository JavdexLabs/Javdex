import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

const repo = process.cwd(), temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-subtitle-ui-'))
let server, browser
try {
  server = await createServer({ configFile: false, root: path.join(repo, 'scripts/ui-regression'), cacheDir: path.join(temporary, 'vite'),
    plugins: [react()], resolve: { alias: { '@shared': path.join(repo, 'packages/contracts/src'), react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') } },
    server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [repo] } } })
  await server.listen()
  browser = await chromium.launch({ ...(process.env.JAVDEX_BROWSER_EXECUTABLE ? { executablePath: process.env.JAVDEX_BROWSER_EXECUTABLE }
    : { channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome' }), headless: true })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1000, height: 640 }]) for (const theme of ['slate', 'light']) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/subtitle-tasks.html?theme=${theme}`)
    const globalButton = page.getByRole('button', { name: '字幕任务', exact: true })
    await globalButton.click()
    const globalDialog = page.getByRole('dialog', { name: '字幕任务', exact: true })
    await globalDialog.waitFor()
    await page.getByText('暂无字幕任务', { exact: true }).waitFor()
    assert.equal(await globalDialog.evaluate(element => {
      const box = element.getBoundingClientRect()
      // inert suppresses hit testing, but does not prevent an opaque sibling from covering the dialog.
      const inertElements = [...document.querySelectorAll('[inert]')]
      try {
        for (const item of inertElements) item.inert = false
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      } finally {
        for (const item of inertElements) item.inert = true
      }
    }), true, 'sidebar dialog must be painted above the main content')
    const backdrop = await globalDialog.evaluate(element => {
      const box = element.parentElement.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    })
    assert.deepEqual(backdrop, { x: 0, y: 0, ...viewport }, 'backdrop must cover the entire viewport')
    await page.keyboard.press('Escape')
    await globalDialog.waitFor({ state: 'detached' })
    assert.equal(await globalButton.evaluate(element => element === document.activeElement), true)
    assert.equal(await page.getByRole('button', { name: '字幕管理', exact: true }).count(), 0, 'resource row keeps subtitle management inside its menu')
    const resourceMenu = page.locator('[data-resource-row]').getByRole('button', { name: '更多', exact: true })
    await resourceMenu.click()
    await page.getByRole('menuitem', { name: '字幕管理', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '字幕管理', exact: true })
    await page.getByRole('article', { name: 'ABC-123.zh.srt' }).waitFor()
    await page.getByRole('article', { name: 'ABC-123.en.srt' }).getByText('不可用', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.preparations), 0, 'file management must not prepare AI models')
    assert.equal(await page.getByRole('menu').count(), 0, 'resource menu closes without unmounting the subtitle dialog')
    const before = await dialog.boundingBox()
    await page.getByRole('button', { name: '关联字幕文件', exact: true }).click()
    await page.getByRole('article', { name: 'ABC-123.zh-Hans.ass' }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.associations[0]), { libraryId: 1, videoId: 2, resourceId: 3 })
    await page.getByRole('button', { name: '关联字幕文件', exact: true }).click()
    assert.equal(await page.getByRole('article', { name: 'ABC-123.zh-Hans.ass' }).count(), 1)
    await page.evaluate(() => { window.cancelAssociation = true })
    await page.getByRole('button', { name: '关联字幕文件', exact: true }).click()
    assert.equal(await page.getByRole('article').count(), 4, 'cancelling the file picker preserves associations')
    assert.deepEqual(await dialog.boundingBox(), before, 'association changes do not resize the modal')
    if (viewport.width === 1440) await page.screenshot({ path: path.join(repo, `out/subtitle-file-management-${theme}.png`) })
    await page.getByRole('button', { name: 'AI 生成', exact: true }).click()
    await page.getByRole('button', { name: '生成 AI 字幕', exact: true }).click()
    await page.getByText('待保存', { exact: true }).waitFor()
    await page.getByRole('button', { name: '重试保存', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    assert.deepEqual(await dialog.boundingBox(), before, 'task progress must not resize the dialog')
    await page.getByRole('button', { name: /更多操作$/ }).click()
    await page.getByRole('menuitem', { name: '移除任务', exact: true }).click()
    await page.getByText('移除任务及中间结果，已保存的字幕文件保留。', { exact: false }).waitFor()
    await page.getByRole('button', { name: '确认移除', exact: true }).click()
    await page.getByText('暂无字幕任务', { exact: true }).waitFor()
    const commands = await page.evaluate(() => window.subtitleCommands)
    assert.deepEqual(commands.map(command => command.action), ['enqueue', 'retry-save', 'remove'])
    assert.deepEqual(commands[0].target, { libraryId: 1, videoId: 2, resourceId: 3 })
    assert.equal(await page.evaluate(() => window.preparations), 1)
    await page.getByRole('button', { name: '字幕文件', exact: true }).click()
    await page.getByRole('article', { name: 'ABC-123.zh-Hans.ass' }).waitFor()
    await page.evaluate(() => { window.modelUnavailable = true })
    await page.getByRole('button', { name: 'AI 生成', exact: true }).click()
    await page.getByText('AI 模型尚未准备，请先安装模型', { exact: true }).waitFor()
    await page.getByRole('button', { name: '字幕文件', exact: true }).click()
    await page.getByRole('button', { name: '关联字幕文件', exact: true }).click()
    await page.getByRole('article', { name: 'ABC-123.zh-Hans.ass' }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await resourceMenu.evaluate(element => element === document.activeElement), true)
    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log('Subtitle management passed: 2 sizes × 2 themes, menu entry/focus, discovered/linked/missing files, association/cancellation, model-independent management, AI creation/save/removal and stable modal layout (synthetic RPC).')
} finally {
  await browser?.close(); await server?.close()
  if (path.dirname(temporary) !== path.resolve(os.tmpdir())) throw new Error('Unexpected fixture directory')
  await fs.rm(temporary, { recursive: true, force: true })
}
