// Actual Web build, synthetic catalog only. Never reads a personal library.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve('out/web')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-web-browse-'))
const report = []
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
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity)
      .map(a => a.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await waitVisibleImages(page)
  const metrics = await page.locator('body').evaluate(root => {
    const properties = ['display', 'position', 'height', 'width', 'minHeight', 'minWidth', 'padding', 'gap',
      'fontSize', 'fontWeight', 'color', 'backgroundColor', 'borderTopColor', 'borderRadius', 'boxShadow',
      'outlineStyle', 'overflowY', 'scrollbarGutter', 'userSelect', 'opacity', 'objectFit', 'aspectRatio', 'transform']
    return [...root.querySelectorAll('header, main, nav, dialog, form, [data-navigation-group], a, button, input, h1, h2, p, small, img, span')]
      .filter(element => element.getClientRects().length && !element.closest('[hidden]'))
      .map(element => {
        const box = element.getBoundingClientRect(), css = getComputedStyle(element)
        return { tag: element.tagName, label: element.getAttribute('aria-label'), text: element.tagName === 'IMG' ? '' : element.textContent,
          box: [box.x, box.y, box.width, box.height], style: Object.fromEntries(properties.map(key => [key, css[key]])) }
      })
  })
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' })
  report.push({ name, metrics })
}
async function waitVisibleImages(page) {
  await page.waitForFunction(() => [...document.images].filter(img => {
    const box = img.getBoundingClientRect()
    return box.width && box.height && box.bottom > 0 && box.top < innerHeight
  }).every(img => img.complete))
}
try {
  browser = await chromium.launch({ channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome', headless: true })
  const base = `http://127.0.0.1:${server.address().port}`
  for (const [width, height, touch] of [[320, 844, true], [390, 844, true], [844, 390, true],
    [1000, 640, false], [1280, 800, false], [1920, 1080, false]]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const items = Array.from({ length: 18 }, (_, i) => ({ id: i + 1,
      title: i === 1 ? '长中文标题与很长的影片名称'.repeat(5) : `合成影片 ${i + 1}`, code: `STYLE-${i + 1}`,
      cover: i === 2 ? null : i === 3 ? '/fixture-broken' : '/fixture-cover',
      releaseDate: i === 2 ? null : '2026-09-30', duration: i === 2 ? null : 123, rating: i === 2 ? 0 : 4.5 }))
    const collections = { libraries: Array.from({ length: 20 }, (_, i) => ({ id: i + 1,
      name: i === 1 ? '长名称媒体库'.repeat(5) : `媒体库 ${i + 1}`, count: 54 })),
      playlists: [{ id: 1, name: '长名称清单'.repeat(5), count: 18 }] }
    let failed = false
    await page.route('**/fixture-*', route => new URL(route.request().url()).pathname.endsWith('broken')
      ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="1000"><rect width="100%" height="100%" fill="teal"/></svg>' }))
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/session') return route.fulfill({ json: { authenticated: true, username: 'style-test' } })
      if (url.pathname === '/api/collections') return route.fulfill({ json: collections })
      if (url.pathname === '/api/home') return route.fulfill({ json: { discovery: items.slice(0, 8), recent: items.slice(8, 16) } })
      if (url.searchParams.get('q') === 'failure' && !failed) {
        failed = true
        return route.fulfill({ status: 503, json: { error: '合成读取错误：请稍后重试。' } })
      }
      return route.fulfill({ json: { items: url.searchParams.get('q') === 'empty' ? [] : items,
        total: url.searchParams.get('q') === 'empty' ? 0 : 54, page: Number(url.searchParams.get('page') || 1), pageSize: 18 } })
    })
    await page.goto(base)
    await page.getByRole('heading', { name: '近期添加', exact: true }).waitFor()
    await waitVisibleImages(page)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const grids = page.locator('[aria-label="影片列表"]')
    for (const grid of await grids.all()) assert.equal(await grid.locator('a[tabindex="0"]').count(), 1)
    await snapshot(page, `${width}-home`)
    const search = page.getByRole('searchbox')
    await search.fill('very-long-search-长中文'.repeat(6))
    await search.focus()
    await snapshot(page, `${width}-search-focus`)
    assert.equal(await search.evaluate(el => getComputedStyle(el).boxShadow), 'none')
    await page.getByRole('button', { name: '清除搜索', exact: true }).click()
    await page.getByRole('link', { name: '查看全部', exact: true }).click()
    const results = page.locator('[data-browse-results]')
    await results.locator('a[data-navigation-item]').first().waitFor()
    await waitVisibleImages(page)
    await snapshot(page, `${width}-browse`)
    const firstCard = results.locator('a[data-navigation-item]').first()
    await firstCard.focus()
    await snapshot(page, `${width}-card-focus`)
    await page.keyboard.press('ArrowRight')
    assert.equal(await results.locator('a[data-navigation-item]').nth(1).evaluate(el => el === document.activeElement), true)
    assert.equal(await results.locator('a[tabindex="0"]').count(), 1)
    if (!touch) {
      await firstCard.hover()
      await snapshot(page, `${width}-card-hover`)
      await page.mouse.down()
      await snapshot(page, `${width}-card-press`)
      await page.mouse.move(width - 1, height - 1)
      await page.mouse.up()
    }
    if (width <= 760) {
      const trigger = page.getByRole('button', { name: '选择媒体库或清单', exact: true })
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: '浏览范围', exact: true })
      await snapshot(page, `${width}-scope-dialog`)
      await page.keyboard.press('Escape')
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
      await trigger.click()
      await dialog.locator('[data-scope="library:2"]').click()
      await page.getByRole('heading', { name: collections.libraries[1].name, exact: true }).waitFor()
    } else {
      const navigation = page.getByRole('navigation', { name: '浏览导航', exact: true })
      await navigation.getByRole('link').last().focus()
      const footer = page.getByText('管理请使用桌面端', { exact: true })
      const box = await footer.boundingBox()
      assert.ok(box.y >= 0 && box.y + box.height <= height)
      await snapshot(page, `${width}-sidebar-scroll`)
      await navigation.getByRole('link').nth(2).click()
      await page.getByRole('heading', { name: collections.libraries[1].name, exact: true }).waitFor()
    }
    await results.locator('a[data-navigation-item]').first().waitFor()
    await snapshot(page, `${width}-scope-selected`)
    await search.fill('empty')
    await search.press('Enter')
    await page.getByText('没有匹配的影片，请调整搜索或筛选。', { exact: true }).waitFor()
    await snapshot(page, `${width}-empty`)
    await search.fill('failure')
    await search.press('Enter')
    await page.getByText('合成读取错误：请稍后重试。', { exact: true }).waitFor()
    await snapshot(page, `${width}-error`)
    await results.getByRole('button', { name: '重试', exact: true }).click()
    await results.locator('a[data-navigation-item]').first().waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`PASS browse styles ${width}×${height}`)
  }
  fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Browse style evidence: ${output}`)
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
