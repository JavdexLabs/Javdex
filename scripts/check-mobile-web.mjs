import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { keyboardJourney, tabTo } from './web-keyboard-journey.mjs'

// Run after web:build. Safe synthetic catalog; never connects to a personal library.
const root = path.resolve('out/web')
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  const file = path.resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`)
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    response.writeHead(404).end()
    return
  }
  response.setHeader('Content-Type', {
    '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png'
  }[path.extname(file)] ?? 'text/html')
  response.end(fs.readFileSync(file))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
async function checkControlFocus(locator) {
  const before = await locator.boundingBox()
  await locator.focus()
  const style = await locator.evaluate(el => {
    const css = getComputedStyle(el)
    return { outline: css.outlineStyle, border: css.borderTopColor, ring: css.boxShadow,
      accent: css.getPropertyValue('--text-accent').trim() }
  })
  assert.equal(style.outline, 'none')
  assert.equal(style.border, 'rgb(143, 210, 179)')
  assert.equal(style.ring, 'rgb(143, 210, 179) 0px 0px 0px 1px')
  const after = await locator.boundingBox()
  assert.equal(after.width, before.width)
  assert.equal(after.height, before.height)
}
try {
  browser = await chromium.launch({ channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome', headless: true })
  const base = `http://127.0.0.1:${server.address().port}`
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-keyboard-video-'))
  let movie
  try {
    const fixturePath = path.join(fixtureDirectory, 'sample.webm')
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=320x180:r=10', '-t', '3', '-c:v', 'libvpx-vp9', '-an', '-y', fixturePath], { windowsHide: true })
    movie = fs.readFileSync(fixturePath)
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true })
  }
  const items = Array.from({ length: 36 }, (_, i) => ({
    id: i + 1, title: `Sample film ${i + 1}`, code: `DEMO-${i + 1}`,
    cover: null, releaseDate: '2026', duration: 120, rating: 0
  }))
  for (const [width, height, touch] of [[320, 844, true], [390, 844, true], [844, 390, true], [1280, 800, false]]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: touch, hasTouch: touch })
    await page.route('**/preview-fixture-*', route => {
      if (route.request().url().endsWith('broken')) return route.fulfill({ status: 404, body: '' })
      const portrait = route.request().url().endsWith('portrait')
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${portrait ? 1200 : 450}"><rect width="100%" height="100%" fill="teal"/></svg>` })
    })
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname.includes('/media/')) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '')
        const start = range ? Number(range[1]) : 0
        const end = range?.[2] ? Math.min(Number(range[2]), movie.length - 1) : movie.length - 1
        return route.fulfill({ status: range ? 206 : 200, contentType: 'video/webm',
          headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${movie.length}` } : {}) },
          body: movie.subarray(start, end + 1) })
      }
      const json = pathname === '/api/session' ? { authenticated: true, username: 'test' }
        : pathname === '/api/home' ? { discovery: items.slice(0, 12), recent: items.slice(12, 24) }
        : pathname === '/api/collections' ? {
          libraries: [{ id: 1, name: '默认媒体库', count: 36 }],
          playlists: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `清单 ${i + 1}`, count: 3 }))
        } : pathname === '/api/videos' ? { items, total: 12345, page: 1, pageSize: 36 }
          : { ...items[16], summary: 'Sample summary', actresses: [
            { id: 1, name: '示例女演员', gender: 'female', avatar: 'data:image/png;base64,' + fs.readFileSync(path.resolve('build/icon-32.png')).toString('base64') },
            { id: 2, name: '示例男演员', gender: 'male', avatar: null },
            { id: 3, name: '未知演员', gender: null, avatar: 'data:image/png;base64,broken' }
          ], tags: [], cover: '/preview-fixture-cover', images: ['/preview-fixture-landscape', '/preview-fixture-portrait', '/preview-fixture-broken'], resources: [
            { id: 1, name: '主资源', kind: 'local', mime: 'video/mp4', isPrimary: true, playable: true, reason: null },
            { id: 2, name: '其他资源', kind: 'local', mime: null, isPrimary: false, playable: false, reason: '浏览器不支持此格式' }
          ] }
      return route.fulfill({ json })
    })
    await page.goto(`${base}/#/browse`)
    await page.getByRole('heading', { name: '随机发现', exact: true }).waitFor()
    {
      await keyboardJourney(page)
      // Start the independent layout checks from a fresh document.
      await page.reload()
      await page.getByRole('heading', { name: '随机发现', exact: true }).waitFor()
    }
    await page.keyboard.press('ArrowDown')
    assert.equal(await page.locator('.topbar .brand').evaluate(el => document.activeElement === el), true, 'initial directional entry starts at the first control')
    await page.keyboard.press('/')
    await page.keyboard.press('Tab')
    assert.equal(await page.locator('.logout').evaluate(el => document.activeElement === el), true, 'Tab skips search submit')
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.locator('#web-search').evaluate(el => document.activeElement === el), true)
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator('.search-submit').evaluate(el => document.activeElement === el), false)
    if (width > 760) {
      assert.equal(await page.locator('.logout').evaluate(el => document.activeElement === el), true)
      await page.keyboard.press('ArrowLeft')
      assert.equal(await page.locator('#web-search').evaluate(el => document.activeElement === el), true)
      await page.keyboard.press('ArrowLeft')
      assert.equal(await page.locator('.topbar .brand').evaluate(el => document.activeElement === el), true)
      await page.keyboard.press('ArrowRight')
      assert.equal(await page.locator('#web-search').evaluate(el => document.activeElement === el), true)
    }
    await page.keyboard.type('sample')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowLeft')
    assert.equal(await page.locator('#web-search').evaluate(el => document.activeElement === el && el.selectionStart === 0), true)
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator('#web-search').evaluate(el => document.activeElement === el && el.selectionStart === 6), true)
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator('.search-submit').evaluate(el => document.activeElement === el), false)
    if (width <= 760) await page.keyboard.press('Tab')
    assert.equal(await page.locator('.logout').evaluate(el => document.activeElement === el), true, 'logout remains reachable')
    assert.equal(await page.locator('.logout').evaluate(el => el.matches(':focus-visible')), true)
    await checkControlFocus(page.locator('.logout'))
    const homeCards = await page.locator('.home-sections .video-card').evaluateAll(cards => cards.map(card => card.getAttribute('href')))
    await page.locator('.home-sections .video-card').nth(16).scrollIntoViewIfNeeded()
    const homeScroll = await page.evaluate(() => scrollY)
    await page.locator('.home-sections .video-card').nth(16).click()
    await page.locator('.detail h1').waitFor()
    await page.getByRole('button', { name: '返回浏览' }).click()
    await page.getByRole('heading', { name: '随机发现', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => scrollY), homeScroll)
    assert.deepEqual(await page.locator('.home-sections .video-card').evaluateAll(cards => cards.map(card => card.getAttribute('href'))), homeCards)
    await page.getByRole('link', { name: '查看全部', exact: true }).click()
    await page.locator('.video-card:visible').last().waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await checkControlFocus(page.locator('.year-filter input'))
    if (touch) {
      for (const selector of ['.logout', '.year-filter input', '.search-submit']) {
        const box = await page.locator(selector).boundingBox()
        assert.ok(box.width >= 48 && box.height >= 48, `${width}: ${selector}`)
      }
      assert.equal(await page.locator('.search input').evaluate(el => getComputedStyle(el).fontSize), '16px')
    }
    if (width <= 760) {
      assert.equal(await page.locator('.sidebar').isVisible(), false)
      await tabTo(page, '.mobile-collection > button', 'Shift+Tab')
      await checkControlFocus(page.locator('.mobile-collection > button'))
      const scopeUrl = page.url()
      await page.keyboard.press('ArrowDown')
      assert.equal(page.url(), scopeUrl, 'passing browse scope must not change filters')
      assert.equal(await page.locator('.mobile-collection > button').evaluate(el => document.activeElement === el), false)
      await tabTo(page, '.mobile-collection > button', 'Shift+Tab')
      await page.keyboard.press('Enter')
      await page.locator('.collection-dialog[open]').waitFor()
      await page.keyboard.press('ArrowDown')
      assert.equal(page.url(), scopeUrl, 'highlighting an option must not apply it')
      await page.keyboard.press('/')
      assert.equal(await page.locator('.collection-dialog').evaluate(el => el.contains(document.activeElement)), true)
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab')
        assert.equal(await page.locator('.collection-dialog').evaluate(el => el.contains(document.activeElement)), true, 'Tab stays inside scope dialog')
      }
      await page.keyboard.press('Shift+Tab')
      assert.equal(await page.locator('.collection-dialog').evaluate(el => el.contains(document.activeElement)), true)
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('.mobile-collection > button').evaluate(el => document.activeElement === el), true)
      assert.equal(page.url(), scopeUrl)
      await page.keyboard.press('Space')
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
      assert.equal(await page.locator('[data-scope="playlist:3"]').evaluate(el => document.activeElement === el), true)
      await page.keyboard.press('Enter')
      await page.waitForURL('**/*playlist=3')
      await tabTo(page, '.mobile-collection > button', 'Shift+Tab')
      await page.keyboard.press('Enter')
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp')
      await page.keyboard.press('Enter')
      await page.waitForURL('**/#/browse')
      await page.getByRole('link', { name: '查看全部', exact: true }).click()
    } else {
      assert.equal(await page.locator('.sidebar').isVisible(), true)
      for (const key of ['ArrowUp', 'ArrowDown']) {
        // Every card, including left-edge cards and scrolled rows, stays in its column.
        const cards = page.locator('[data-browse-results] .video-card')
        for (let i = 0; i < await cards.count(); i++) {
          await cards.nth(i).focus()
          await page.keyboard.press(key)
          assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.sidebar'))), false)
        }
        await page.locator('.sidebar a').nth(2).focus()
        await page.keyboard.press(key)
        assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.main-content'))), false)
      }
      await page.locator('[data-browse-results] .video-card').first().focus()
      await page.keyboard.press('ArrowLeft')
      assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.sidebar'))), true)
      await page.keyboard.press('ArrowRight')
      assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.main-content'))), true)
    }
    const gridCards = page.locator('[data-browse-results] .video-card')
    const layout = await gridCards.evaluateAll(cards => cards.map((card, index) => {
      const box = card.getBoundingClientRect()
      return { index, top: Math.round(box.top + scrollY), x: box.x + box.width / 2 }
    }))
    const firstRow = layout.filter(card => card.top === layout[0].top)
    const columns = firstRow.length
    await gridCards.nth(columns - 1).focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await gridCards.nth(columns - 1).evaluate(el => document.activeElement === el), true, 'right edge must not wrap')
    for (const index of [0, columns - 1, columns, layout.length - 1]) {
      for (const [key, direction] of [['ArrowDown', 1], ['ArrowUp', -1]]) {
        const source = layout[index]
        const nextRow = [...new Set(layout.map(card => card.top))]
          .filter(top => (top - source.top) * direction > 0)
          .sort((a, b) => (a - b) * direction)[0]
        if (nextRow === undefined) continue
        const expected = layout.filter(card => card.top === nextRow)
          .sort((a, b) => Math.abs(a.x - source.x) - Math.abs(b.x - source.x))[0]
        await gridCards.nth(index).focus()
        await page.keyboard.press(key)
        assert.equal(await gridCards.nth(expected.index).evaluate(el => document.activeElement === el), true, `${width}: ${key} nearest row/column`)
      }
    }
    if (width > 760) {
      await gridCards.nth(columns).focus()
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('ArrowRight')
      assert.equal(await gridCards.nth(columns).evaluate(el => document.activeElement === el), true, 'return to remembered content control')
    }
    const search = page.getByRole('searchbox')
    await search.fill('sample')
    if (touch) {
      const clear = await page.getByRole('button', { name: '清除搜索' }).boundingBox()
      assert.ok(clear.width >= 48 && clear.height >= 48)
    }
    await search.press('Enter')
    await page.waitForURL('**/*q=sample')
    if (touch) assert.equal(await search.evaluate(el => document.activeElement === el), false)
    await page.getByRole('button', { name: '清除搜索' }).click()
    await page.waitForURL('**/*sort=recent')
    for (const back of ['button', 'history']) {
      const card = page.locator('.video-card:visible').nth(16)
      await card.scrollIntoViewIfNeeded()
      const before = await page.evaluate(() => scrollY)
      await card.click()
      await page.locator('.detail h1').waitFor()
      assert.equal(await page.locator('#detail-back').evaluate(el => document.activeElement === el), true)
      const backBox = await page.locator('#detail-back').boundingBox()
      assert.ok(backBox.y >= 0 && backBox.y + backBox.height <= height)
      assert.equal(await page.evaluate(() => scrollY), 0)
      await page.keyboard.press('ArrowDown')
      assert.equal(await page.locator('video').evaluate(el => document.activeElement === el), true, `${width}: back moves down to player`)
      if (back === 'button') {
        assert.equal(await page.locator('.detail-poster, .mobile-cover-preview, .player-fallback').count(), 0, 'playable detail has no separate cover')
        const coverTrigger = '.gallery button:first-child'
        await tabTo(page, coverTrigger)
        const previewScroll = await page.evaluate(() => scrollY)
        const previewUrl = page.url()
        await page.keyboard.press('Enter')
        await page.locator('.image-preview').waitFor()
        await page.getByRole('button', { name: '关闭预览', exact: true }).waitFor()
        await page.keyboard.press('ArrowLeft')
        await page.waitForFunction(() => document.querySelector('.yarl__counter')?.textContent.trim() === '1 / 4')
        for (const label of ['关闭预览', '放大', '下一张']) {
          const box = await page.getByRole('button', { name: label, exact: true }).boundingBox()
          assert.ok(box.width >= 48 && box.height >= 48)
          assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height)
        }
        for (let i = 0; i < 10; i++) {
          await page.keyboard.press('Tab')
          assert.equal(await page.locator('.image-preview').evaluate(el => el.contains(document.activeElement)), true, 'preview traps Tab')
        }
        await page.keyboard.press('ArrowRight')
        await page.waitForFunction(() => document.querySelector('.yarl__counter')?.textContent.trim() === '2 / 4')
        await page.keyboard.press('/')
        assert.equal(await page.locator('.image-preview').evaluate(el => el.contains(document.activeElement)), true)
        await page.waitForFunction(() => {
          const img = document.querySelector('.yarl__slide_current img')
          return img?.complete && img.naturalWidth > 0
        })
        const initialImageWidth = await page.locator('.yarl__slide_current img').evaluate(img => img.getBoundingClientRect().width)
        await page.getByRole('button', { name: '放大', exact: true }).click()
        await page.waitForFunction(before => document.querySelector('.yarl__slide_current img').getBoundingClientRect().width > before * 1.1, initialImageWidth)
        await page.waitForFunction(() => !document.querySelector('button[title="缩小"]')?.disabled)
        await page.getByRole('button', { name: '缩小', exact: true }).click()
        await page.waitForFunction(before => Math.abs(document.querySelector('.yarl__slide_current img').getBoundingClientRect().width - before) < 1, initialImageWidth)
        if (!touch) {
          await page.locator('.yarl__slide_current img').hover()
          await page.mouse.wheel(0, -100)
          await page.waitForFunction(before => document.querySelector('.yarl__slide_current img').getBoundingClientRect().width > before * 1.1, initialImageWidth)
        }
        await page.keyboard.press('Escape')
        await page.locator('.image-preview').waitFor({ state: 'detached' })
        assert.equal(page.url(), previewUrl, 'preview Escape does not leave detail')
        assert.equal(await page.locator(coverTrigger).evaluate(el => document.activeElement === el), true)
        assert.equal(await page.evaluate(() => scrollY), previewScroll)
        await page.keyboard.press('Enter')
        await page.locator('.image-preview').waitFor()
        await page.goBack()
        await page.locator('.image-preview').waitFor({ state: 'detached' })
        assert.equal(page.url(), previewUrl, 'browser Back closes preview before leaving detail')
        assert.equal(await page.locator(coverTrigger).evaluate(el => document.activeElement === el), true)
        assert.equal(await page.evaluate(() => scrollY), previewScroll)
        await page.goForward()
        await page.locator('.image-preview').waitFor()
        await page.getByRole('button', { name: '关闭预览', exact: true }).click()
        await page.locator('.image-preview').waitFor({ state: 'detached' })
        assert.equal(page.url(), previewUrl)
        await tabTo(page, '.gallery button:nth-child(2)')
        await page.keyboard.press('Enter')
        await page.waitForFunction(() => document.querySelector('.yarl__counter')?.textContent.trim() === '3 / 4')
        await page.waitForFunction(() => {
          const img = document.querySelector('.yarl__slide_current img')
          return img?.complete && img.naturalWidth > 0
        })
        const portraitFit = await page.locator('.yarl__slide_current img').evaluate(img => {
          const box = img.getBoundingClientRect()
          return box.width <= innerWidth && box.height <= innerHeight && Math.abs(box.width / box.height - img.naturalWidth / img.naturalHeight) < 0.01
        })
        assert.equal(portraitFit, true, 'portrait fits without cropping or stretching')
        await page.keyboard.press('Escape')
        await page.locator('.image-preview').waitFor({ state: 'detached' })
        await tabTo(page, '.gallery button:last-child')
        await page.keyboard.press('Enter')
        await page.locator('.image-preview [role="alert"]').waitFor()
        await page.keyboard.press('Escape')
        await page.locator('.image-preview').waitFor({ state: 'detached' })
        assert.equal(await page.locator('.gallery button:last-child').evaluate(el => document.activeElement === el), true)
        await page.locator('video').evaluate(video => video.dispatchEvent(new Event('error')))
        await page.locator('.player-fallback-cover').waitFor()
        assert.equal(await page.locator('video').isVisible(), false)
        assert.equal(await page.locator('.player-fallback-cover').evaluate(img => getComputedStyle(img).objectFit), 'contain')
        assert.equal(await page.getByRole('button', { name: '预览影片封面' }).count(), 1)
        await tabTo(page, '.player-fallback .player-error button')
        await page.keyboard.press('Enter')
        await page.locator('video').waitFor({ state: 'visible' })
        assert.equal(await page.locator('.player-fallback').count(), 0)
      }
      await page.locator('video').focus()
      for (const key of ['ArrowUp', 'ArrowDown']) {
        await page.locator('video').focus()
        const volume = await page.locator('video').evaluate(el => el.volume)
        await page.keyboard.press(key)
        assert.equal(await page.locator('video').evaluate(el => document.activeElement === el), false)
        assert.equal(await page.locator('video').evaluate(el => el.volume), volume)
      }
      for (const key of ['ArrowLeft', 'ArrowRight']) {
        await page.locator('video').focus()
        const prevented = await page.locator('video').evaluate((el, key) => {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
          el.dispatchEvent(event)
          return event.defaultPrevented
        }, key)
        assert.equal(prevented, false)
        assert.equal(await page.locator('video').evaluate(el => document.activeElement === el), true)
      }
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('#detail-back').evaluate(el => document.activeElement === el), true)
      assert.equal(await page.locator('video').evaluate(el => el.paused && !el.autoplay), true)
      assert.equal(await page.locator('.cast-member').count(), 3)
      assert.match(await page.locator('.cast-grid').innerText(), /♀ 女/)
      assert.match(await page.locator('.cast-grid').innerText(), /♂ 男/)
      assert.match(await page.locator('.cast-grid').innerText(), /性别未知/)
      assert.equal(await page.locator('.cast-member').first().getAttribute('href'), '#/browse?actress=1&label=%E7%A4%BA%E4%BE%8B%E5%A5%B3%E6%BC%94%E5%91%98')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.equal(await page.getByText('浏览器不支持此格式', { exact: true }).isVisible(), true)
      if (back === 'button') await page.getByRole('button', { name: '返回浏览' }).click()
      else await page.goBack()
      await page.locator('.video-card:visible').first().waitFor({ state: 'visible' })
      assert.equal(await page.evaluate(() => scrollY), before, `${width}: ${back}`)
    }
    await page.getByRole('button', { name: '下一页', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.waitForURL('**/*page=2')
    await page.waitForFunction(() => document.activeElement?.matches('[data-browse-results] .video-card'))
    await page.keyboard.press('Enter')
    await page.locator('.cast-member').first().waitFor()
    await page.locator('.cast-member').first().focus()
    await page.keyboard.press('Enter')
    await page.waitForURL('**/*actress=1*')
    await page.waitForFunction(() => document.activeElement?.matches('[data-browse-results] .video-card'))
    await page.locator('.filter-chips button').first().focus()
    await page.keyboard.press('Enter')
    await page.getByRole('heading', { name: '随机发现', exact: true }).waitFor()
    assert.equal(await page.locator('.home-section-heading button').evaluate(el => document.activeElement === el), true)
    assert.equal(await page.locator('h1[tabindex], main[tabindex], .home-sections[tabindex]').count(), 0, 'plain text and containers are not focus targets')
    await page.route('**/api/videos?**', async route => {
      if (new URL(route.request().url()).searchParams.get('q') === 'empty') {
        await route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 36 } })
      } else await route.fallback()
    })
    await page.keyboard.press('/')
    await page.keyboard.type('empty')
    await page.keyboard.press('Enter')
    await page.getByText('没有匹配的影片，请调整搜索或筛选。', { exact: true }).waitFor()
    await page.waitForFunction(() => document.activeElement?.id === 'web-search')
    let failNext = true
    await page.route('**/api/videos?**', async route => {
      if (failNext) {
        failNext = false
        await route.fulfill({ status: 500, json: { error: '模拟加载失败' } })
      } else await route.fallback()
    })
    await search.fill('failure')
    await search.press('Enter')
    await page.waitForFunction(() => document.activeElement?.matches('[data-browse-results] [role="alert"] button'))
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.activeElement?.matches('[data-browse-results] .video-card'))
    for (const hasCover of [true, false]) {
      await page.route('**/api/videos/17', route => route.fulfill({ json: {
        ...items[16], cover: hasCover ? '/preview-fixture-cover' : null,
        actresses: [], tags: [], images: [], resources: []
      } }))
      await page.goto(`${base}/#/browse/video/17`)
      await page.reload()
      await page.getByText('暂无可在浏览器中播放的资源。', { exact: true }).waitFor()
      assert.equal(await page.locator('video').count(), 0)
      assert.equal(await page.locator('.player-fallback-cover').count(), hasCover ? 1 : 0)
      assert.equal(await page.locator('.detail-poster, .mobile-cover-preview').count(), 0)
      if (hasCover) {
        const cover = await page.locator('.player-fallback-cover').boundingBox()
        assert.ok(cover.width > cover.height, 'fallback cover stays landscape')
        await tabTo(page, '.player-fallback .image-preview-trigger')
        await page.keyboard.press('Enter')
        await page.locator('.image-preview').waitFor()
        await page.keyboard.press('Escape')
        await page.locator('.image-preview').waitFor({ state: 'detached' })
        assert.equal(await page.locator('.player-fallback .image-preview-trigger').evaluate(el => document.activeElement === el), true)
      }
    }
    await page.route('**/api/logout', route => route.fulfill({ json: { ok: true } }))
    await tabTo(page, '.logout')
    const logoutRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/logout' && request.method() === 'POST')
    await page.keyboard.press(width <= 760 ? 'Space' : 'Enter')
    await logoutRequest
    await page.locator('.login-page').waitFor()
    await page.close()
    console.log(`PASS ${width}×${height} ${touch ? 'touch' : 'desktop'}`)
  }
  const login = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await login.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname === '/api/session') return route.fulfill({ status: 401, json: { error: '请登录' } })
    if (pathname === '/api/login') {
      assert.deepEqual(route.request().postDataJSON(), { username: 'viewer', password: 'keyboard-password', remember: true })
      return route.fulfill({ json: { authenticated: true, username: 'viewer' } })
    }
    if (pathname === '/api/collections') return route.fulfill({ json: { libraries: [], playlists: [] } })
    if (pathname === '/api/home') return route.fulfill({ json: { discovery: [], recent: [] } })
    if (pathname === '/api/videos') return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 36 } })
    return route.fulfill({ json: { code: '123456', remainingMs: 60000, state: 'pending' } })
  })
  await login.goto(base)
  await login.locator('.pair-code').waitFor()
  assert.equal(await login.getByRole('status').innerText(), '等待桌面批准')
  assert.equal(await login.locator('[role="status"]').evaluate(el => el.textContent.includes('剩余')), false)
  await login.getByRole('button', { name: '密码登录', exact: true }).click()
  const username = login.locator('input[name="username"]')
  assert.equal(await username.evaluate(el => document.activeElement === el), false)
  for (const name of ['username', 'password']) {
    assert.equal(await login.locator(`input[name="${name}"]`).evaluate(el => getComputedStyle(el).fontSize), '16px')
    await checkControlFocus(login.locator(`input[name="${name}"]`))
  }
  await username.fill('sample')
  await username.evaluate(el => el.setSelectionRange(3, 3))
  await username.press('ArrowLeft')
  assert.equal(await username.evaluate(el => document.activeElement === el && el.selectionStart === 2), true)
  await username.press('ArrowRight')
  assert.equal(await username.evaluate(el => document.activeElement === el && el.selectionStart === 3), true)
  await username.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true, cancelable: true })))
  assert.equal(await username.evaluate(el => document.activeElement === el), true)
  await username.press('ArrowDown')
  assert.equal(await login.locator('input[name="password"]').evaluate(el => document.activeElement === el), true)
  await login.locator('input[name="password"]').press('ArrowUp')
  assert.equal(await username.evaluate(el => document.activeElement === el), true)
  assert.equal(await login.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await login.reload()
  await login.locator('.pair-code').waitFor()
  await tabTo(login, '.login-tabs button:last-child')
  await login.keyboard.press('Enter')
  await tabTo(login, 'input[name="username"]')
  await login.keyboard.type('viewer')
  await login.keyboard.press('Tab')
  await login.keyboard.type('keyboard-password')
  await login.keyboard.press('Tab')
  await login.keyboard.press('Space')
  await login.keyboard.press('Tab')
  await login.keyboard.press('Enter')
  await login.getByRole('heading', { name: '随机发现', exact: true }).waitFor()
  await login.close()
  console.log('PASS mobile login and pairing status')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
