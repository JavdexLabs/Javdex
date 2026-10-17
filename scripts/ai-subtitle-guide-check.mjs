import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

// Actual production player and guide, synthetic failed RPC; no media or clipboard.
const repo = process.cwd()
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-ai-guide-check-'))
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
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/playback-toast.html?ai-error=1`)
    const toggle = page.getByRole('switch', { name: 'AI 字幕', exact: true })
    await toggle.click()
    const guide = page.getByRole('dialog', { name: 'AI 字幕暂不可用', exact: true })
    await guide.waitFor()
    const description = guide.getByRole('alert')
    assert.equal(await description.evaluate(element => getComputedStyle(element).userSelect), 'text', 'diagnostics must remain selectable')
    assert.equal(await guide.getByText('音频和字幕留在本机', { exact: true }).evaluate(element => getComputedStyle(element).userSelect), 'text')
    const box = await description.boundingBox()
    await page.mouse.move(box.x + 1, box.y + 10)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 1, box.y + 10, { steps: 12 })
    await page.mouse.up()
    assert.ok((await page.evaluate(() => window.getSelection().toString())).length > 0, 'real pointer selection must work without writing the system clipboard')
    assert.equal(await toggle.evaluate(element => getComputedStyle(element).userSelect), 'none', 'the switch remains a nonselectable control')
    await guide.getByRole('button', { name: '关闭 AI 字幕引导', exact: true }).click()
    await guide.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => window.fixtureControls), [], 'selecting and closing diagnostics cannot command playback')
    assert.deepEqual(errors, [])
    console.log(`AI subtitle guide: ${viewport.width}x${viewport.height}, selectable diagnostics and unchanged playback PASS`)
    await page.close()
  }
} finally {
  await browser?.close()
  await server?.close()
  fs.rmSync(temporary, { recursive: true, force: true })
}
