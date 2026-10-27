import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

// Real production panel and browser mouse events; frame binding and playback RPC
// are synthetic. This checks gesture arbitration, not native decoding or pixels.
const repo = process.cwd()
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-playback-pointer-'))
let server, browser
const results = []
try {
  server = await createServer({ configFile: false, root: path.join(repo, 'scripts/ui-regression'),
    cacheDir: path.join(temporary, '.vite'), plugins: [react()],
    resolve: { alias: { '@shared': path.join(repo, 'packages/contracts/src'), react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') } },
    server: { host: '127.0.0.1', port: 0, watch: null, fs: { allow: [repo] } } })
  await server.listen()
  browser = await chromium.launch({ ...(process.env.JAVDEX_BROWSER_EXECUTABLE
    ? { executablePath: process.env.JAVDEX_BROWSER_EXECUTABLE } : { channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome' }), headless: true })
  for (const surface of ['gpu', 'cpu']) for (const paused of [true, false]) for (const fullscreen of [false, true]) {
    console.log(`Checking ${surface}, ${paused ? 'paused' : 'playing'}, ${fullscreen ? 'fullscreen' : 'expanded'}`)
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const query = new URLSearchParams({ surface, ...(paused ? {} : { playing: '1' }), ...(fullscreen ? { fullscreen: '1' } : {}) })
    const url = `http://127.0.0.1:${server.httpServer.address().port}/playback-settings.html?${query}`
    const reset = async () => {
      await page.goto(url)
      await page.locator('video[data-playback-surface]').waitFor()
    }
    const video = page.getByRole('button', { name: '视频画面，单击播放或暂停，双击全屏', exact: true })
    const center = async () => {
      const rect = await video.boundingBox()
      assert.ok(rect?.width && rect.height)
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    const clickControl = async name => {
      const target = page.getByRole('button', { name, exact: true, includeHidden: true })
      const rect = await target.boundingBox()
      assert.ok(rect?.width && rect.height)
      // Reveal fullscreen chrome with actual pointer movement before clicking.
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
      await page.getByRole('button', { name, exact: true }).click()
    }
    for (const [gap, hold] of [[100, 0], [350, 0], [450, 0], [450, 800]]) {
      await reset()
      const { x, y } = await center()
      await page.mouse.click(x, y, { clickCount: 1 })
      await page.waitForTimeout(gap)
      assert.deepEqual(await page.evaluate(() => window.fixtureCommands), [], 'no single-click command within the double-click window')
      await page.mouse.down({ clickCount: 2 })
      if (hold) {
        await page.waitForTimeout(hold)
        assert.deepEqual(await page.evaluate(() => window.fixtureCommands), [], 'holding a second press must cancel the pending single click')
      }
      await page.mouse.up({ clickCount: 2 })
      await page.waitForTimeout(650)
      assert.deepEqual(await page.evaluate(() => window.fixtureCommands), [{ kind: 'presentation', value: fullscreen ? 'expanded' : 'fullscreen' }],
        'double click only changes presentation, without a transient pause, resume or restart')
      results.push({ surface, paused, fullscreen, gap, hold })
    }
    await reset()
    const single = await center()
    await page.mouse.click(single.x, single.y)
    await page.waitForTimeout(650)
    assert.deepEqual(await page.evaluate(() => window.fixtureCommands), [{ kind: 'pause', paused: !paused }], 'isolated pointer click toggles exactly once')
    await reset()
    const separate = await center()
    await page.mouse.click(separate.x, separate.y, { clickCount: 1 })
    await page.waitForTimeout(525)
    await page.mouse.click(separate.x, separate.y, { clickCount: 1 })
    await page.waitForTimeout(650)
    assert.deepEqual(await page.evaluate(() => window.fixtureCommands), [{ kind: 'pause', paused: !paused }, { kind: 'pause', paused }], 'two independent clicks around the double-click boundary both take effect')
    await reset()
    await video.focus()
    await page.keyboard.press('Space')
    assert.deepEqual(await page.evaluate(() => window.fixtureCommands), [{ kind: 'pause', paused: !paused }], 'keyboard activation stays immediate')
    await reset()
    const explicit = await center()
    await page.mouse.click(explicit.x, explicit.y)
    await clickControl(paused ? '播放' : '暂停')
    await page.waitForTimeout(650)
    assert.deepEqual(await page.evaluate(() => window.fixtureCommands), [{ kind: 'pause', paused: !paused }], 'explicit control supersedes a pending video click')
    for (const [label, command] of [['静音', { kind: 'mute', muted: true }], ['前进 5 秒', { kind: 'seek', relative: true, seconds: 5 }]]) {
      await reset()
      const point = await center()
      await page.mouse.click(point.x, point.y)
      await page.waitForTimeout(100)
      await clickControl(label)
      await page.waitForTimeout(650)
      assert.deepEqual(await page.evaluate(() => window.fixtureCommands), [command, { kind: 'pause', paused: !paused }], `${label} must not discard the earlier independent pause/play intent`)
    }
    assert.deepEqual(errors, [])
    await page.close()
  }
  // These are injected timing contracts, not a claim of native macOS coverage.
  for (const doubleClickMs of [800, 1500]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/playback-settings.html?surface=cpu&doubleClickMs=${doubleClickMs}`)
    const video = page.getByRole('button', { name: '视频画面，单击播放或暂停，双击全屏', exact: true })
    await video.click({ clickCount: 1 })
    await page.waitForTimeout(doubleClickMs - 100)
    assert.deepEqual(await page.evaluate(() => window.fixtureCommands), [])
    await page.mouse.down({ clickCount: 2 })
    await page.waitForTimeout(800)
    await page.mouse.up({ clickCount: 2 })
    await page.waitForTimeout(doubleClickMs + 100)
    assert.deepEqual(await page.evaluate(() => window.fixtureCommands), [{ kind: 'presentation', value: 'fullscreen' }])
    await page.close()
  }
  fs.writeFileSync(path.join(temporary, 'report.json'), JSON.stringify({ results, crossControlCases: 16, customTimingCases: 2, passed: true }, null, 2))
  console.log(`Playback pointer UI: ${results.length} double-click, 16 cross-control and 2 custom-timing cases plus single/independent clicks, keyboard and explicit-control checks PASS`)
  console.log(`Evidence: ${temporary}`)
} finally { await browser?.close(); await server?.close() }
