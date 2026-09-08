// Isolated browser recovery checks; no user library or settings are loaded.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { WebServer } from '../src/main/web/server.ts'
import { WebSessions } from '../src/main/web/auth.ts'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'web-auth-recovery-'))
const sessions = new WebSessions(Date.now, path.join(directory, 'devices.json'))
const server = new WebServer({ sessions, username: 'viewer', passwordHash: '', staticRoot: path.resolve('out/web'), catalog: {
  collections: () => ({ libraries: [], playlists: [] }), browse: () => ({ items: [], total: 0, page: 1, pageSize: 36 }),
  detail: () => { throw new Error() }, image: () => { throw new Error() }, media: () => { throw new Error() }
} })
const port = await server.start(0, '127.0.0.1')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const scenario of ['network', 'refresh', 'clock', 'lost-response']) {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } })
    if (scenario === 'clock') await context.addInitScript(() => { const now = Date.now; Date.now = () => now() + 10 * 60_000 })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${port}`)
    await page.getByRole('button', { name: '获取配对码', exact: true }).waitFor()
    server.pairing.open()
    await page.getByRole('checkbox', { name: '记住此设备', exact: true }).check()
    if (scenario === 'network') await page.route('**/api/pair/poll', route => route.abort('failed'), { times: 1 })
    if (scenario === 'lost-response') await page.route('**/api/pair/poll', async route => {
      // Deliver to server, discard the successful response before browser receives cookies.
      await route.fetch()
      await route.abort('failed')
    }, { times: 1 })
    await page.getByRole('button', { name: '获取配对码', exact: true }).click()
    await page.locator('.pair-code').waitFor()
    const code = (await page.locator('.pair-code').innerText()).replace(/\s/g, '')
    if (scenario === 'refresh') {
      await page.reload()
      await page.locator('.pair-code').waitFor()
      assert.equal((await page.locator('.pair-code').innerText()).replace(/\s/g, ''), code)
    }
    if (scenario === 'network') {
      await page.getByText('连接暂时中断，正在自动重试…', { exact: true }).waitFor({ timeout: 12000 })
      assert.equal(await page.locator('.pair-code').count(), 1)
    }
    const before = sessions.count()
    server.pairing.decide(code, true)
    await page.getByRole('button', { name: /退出登录/ }).waitFor({ timeout: 30000 })
    assert.equal(sessions.count(), before + 1, 'retry must not create duplicate sessions')
    await page.getByRole('button', { name: /退出登录/ }).click()
    await page.getByRole('button', { name: '获取配对码', exact: true }).waitFor()
    assert.equal(sessions.count(), before, 'logout must not restore a cached delivery')
    await page.screenshot({ path: path.join(directory, `${scenario}.png`), fullPage: true })
    console.log(`${scenario}: same pairing recovered, login and logout PASS`)
    await context.close()
  }
  console.log(`Artifacts: ${directory}`)
} finally { await browser.close(); await server.stop() }
