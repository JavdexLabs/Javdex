// Actual Web build with a synthetic login API. No personal accounts or devices.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve('out/web')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-web-login-'))
const metrics = []
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  const file = path.resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`)
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return response.writeHead(404).end()
  response.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(file)] ?? 'text/html')
  response.end(fs.readFileSync(file))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
async function snapshot(page, name) {
  const touch = await page.evaluate(() => navigator.maxTouchPoints)
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
  const values = await page.locator('main').evaluate(root => {
    const keys = ['fontSize', 'fontWeight', 'display', 'minHeight', 'minWidth', 'padding', 'gap', 'color',
      'backgroundColor', 'borderTopColor', 'borderRadius', 'boxShadow', 'opacity', 'letterSpacing']
    return [root, ...root.querySelectorAll('section, label, input, button, strong, p, h1, img')].map(element => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element)
      return { tag: element.tagName, text: element instanceof HTMLInputElement ? '' : element.textContent.replace(/剩余 \d+ 秒/g, '剩余 [计时] 秒'),
        box: [box.x, box.y, box.width, box.height], style: Object.fromEntries(keys.map(key => [key, style[key]])) }
    })
  })
  // Full-page viewport expansion in landscape can reset Chrome touch emulation.
  // Keep viewport screenshots and verify the device state survives each capture.
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled',
    mask: [page.getByText(/^剩余 \d+ 秒$/)] })
  metrics.push({ name, values })
  assert.equal(await page.evaluate(() => navigator.maxTouchPoints), touch, `${name}: screenshots must preserve touch emulation`)
}
try {
  browser = await chromium.launch({ channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome', headless: true })
  for (const [width, height, touch] of [[320, 844, true], [390, 844, true], [844, 390, true], [1280, 800, false]]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' })
    let pair = null, authenticated = false, loginPending = null, loginReceived
    await page.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname === '/api/session') return authenticated
        ? route.fulfill({ json: { authenticated, username: 'viewer' } })
        : route.fulfill({ status: 401, json: { error: '请登录' } })
      if (pathname === '/api/pair/status' || pathname === '/api/pair/poll') return pair
        ? route.fulfill({ json: pair }) : route.fulfill({ status: 410, json: { error: '配对已结束' } })
      if (pathname === '/api/pair/start') {
        assert.deepEqual(route.request().postDataJSON(), { name: '客厅电视', remember: true })
        pair = { code: '123456', remainingMs: 60000, state: 'pending' }
        return route.fulfill({ json: pair })
      }
      if (pathname === '/api/pair/cancel') { pair = null; return route.fulfill({ json: {} }) }
      if (pathname === '/api/login') { loginPending = route; loginReceived?.(); return }
      if (pathname === '/api/collections') return route.fulfill({ json: { libraries: [], playlists: [] } })
      if (pathname === '/api/videos') return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 36 } })
      return route.fulfill({ json: { discovery: [], recent: [] } })
    })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    const start = page.getByRole('button', { name: '获取配对码', exact: true })
    await start.waitFor()
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), touch)
    if (touch) assert.ok(await page.getByRole('textbox', { name: '设备名称', exact: true })
      .evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 16)
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true, 'login does not steal focus')
    await snapshot(page, `${width}-pair-ready`)
    await page.getByRole('textbox', { name: '设备名称', exact: true }).fill('客厅电视')
    await page.getByRole('checkbox', { name: '记住此设备', exact: true }).check()
    await start.click()
    await page.getByText('123 456', { exact: true }).waitFor()
    assert.equal(await page.getByRole('status').innerText(), '等待桌面批准')
    assert.equal(await page.getByRole('status').evaluate(element => element.textContent.includes('剩余')), false)
    await snapshot(page, `${width}-pair-pending`)
    await page.getByRole('button', { name: '取消配对', exact: true }).click()
    await start.waitFor()
    await page.getByRole('button', { name: '密码登录', exact: true }).click()
    const account = page.getByRole('textbox', { name: '访问账号', exact: true })
    await snapshot(page, `${width}-password-ready`)
    await account.focus()
    await snapshot(page, `${width}-password-focus`)
    await account.fill('viewer')
    await page.getByLabel('访问密码', { exact: true }).fill('fixture-password')
    await page.getByRole('checkbox', { name: '记住此设备（长期有效）', exact: true }).check()
    const firstLogin = new Promise(resolve => { loginReceived = resolve })
    await page.getByRole('button', { name: '进入媒体库', exact: true }).click()
    await firstLogin
    await page.getByRole('button', { name: '正在登录…', exact: true }).waitFor()
    await snapshot(page, `${width}-password-busy`)
    assert.deepEqual(loginPending.request().postDataJSON(), { username: 'viewer', password: 'fixture-password', remember: true })
    await loginPending.fulfill({ status: 401, json: { error: '账号或密码错误，请核对后重试。' } })
    await page.getByRole('alert').waitFor()
    await snapshot(page, `${width}-password-error`)
    assert.equal(await account.inputValue(), 'viewer')
    assert.equal(await page.getByLabel('访问密码', { exact: true }).inputValue(), 'fixture-password')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    if (touch) {
      const input = await account.evaluate(element => ({ fontSize: getComputedStyle(element).fontSize,
        coarse: matchMedia('(pointer: coarse)').matches, anyCoarse: matchMedia('(any-pointer: coarse)').matches }))
      assert.ok(parseFloat(input.fontSize) >= 16, `touch login inputs stay at least 16px in landscape too: ${JSON.stringify(input)}`)
    }
    const secondLogin = new Promise(resolve => { loginReceived = resolve })
    await page.getByRole('button', { name: '进入媒体库', exact: true }).click()
    await secondLogin
    await page.getByRole('button', { name: '正在登录…', exact: true }).waitFor()
    authenticated = true
    await loginPending.fulfill({ json: { authenticated, username: 'viewer' } })
    await page.getByRole('heading', { name: '随机发现', exact: true }).waitFor()
    await page.close()
    console.log(`PASS login styles ${width}×${height}`)
  }
  fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n')
  console.log(`Login style evidence: ${output}`)
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
