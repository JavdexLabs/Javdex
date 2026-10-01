// Actual Web entry and synthetic media/API only; never reads a personal catalog.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { tabTo } from './web-keyboard-journey.mjs'

const root = path.resolve('out/web')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-web-detail-'))
const report = []
const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-detail-video-'))
let movie
try {
  const file = path.join(fixtureDirectory, 'sample.webm')
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=320x180:r=10',
    '-t', '3', '-c:v', 'libvpx-vp9', '-an', '-y', file], { windowsHide: true })
  movie = fs.readFileSync(file)
} finally {
  fs.rmSync(fixtureDirectory, { recursive: true, force: true })
}
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
  // Trigger genuine lazy images by scrolling, then restore the original viewport.
  const scroll = await page.evaluate(() => scrollY)
  for (const img of await page.locator('main img').all()) {
    if (await img.isVisible()) {
      await img.scrollIntoViewIfNeeded()
      await img.evaluate(element => element.complete || new Promise(resolve => {
        element.addEventListener('load', resolve, { once: true })
        element.addEventListener('error', resolve, { once: true })
      }))
    }
  }
  await page.evaluate(async position => {
    scrollTo(0, position)
    await document.fonts.ready
    await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity)
      .map(a => a.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }, scroll)
  const metrics = await page.locator('body').evaluate(root => {
    const properties = ['display', 'position', 'height', 'width', 'minHeight', 'maxHeight', 'padding', 'margin',
      'gap', 'fontSize', 'fontWeight', 'color', 'backgroundColor', 'borderTopColor', 'borderRadius', 'boxShadow',
      'outlineStyle', 'overflowY', 'scrollbarGutter', 'whiteSpace', 'lineHeight', 'userSelect', 'opacity', 'objectFit', 'aspectRatio']
    return [...root.querySelectorAll('header, main, nav, section, div, a, button, input, h1, h2, p, span, img, video, dl, dt, dd')]
      .filter(element => element.getClientRects().length && !element.closest('[hidden]'))
      .map(element => {
        const box = element.getBoundingClientRect(), css = getComputedStyle(element)
        return { tag: element.tagName, label: element.getAttribute('aria-label'), text: ['IMG', 'VIDEO'].includes(element.tagName) ? '' : element.textContent,
          box: [box.x, box.y + scrollY, box.width, box.height], style: Object.fromEntries(properties.map(key => [key, css[key]])) }
      })
  })
  // Keep the raw page visible. Full-page masks can use viewport coordinates after
  // keyboard scrolling and accidentally cover content below the native player.
  // Native controls may vary; compare their pixels separately from page layout.
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
  report.push({ name, metrics })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
}
try {
  browser = await chromium.launch({ channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome', headless: true })
  const base = `http://127.0.0.1:${server.address().port}`
  for (const [width, height, touch] of [[320, 844, true], [390, 844, true], [844, 390, true],
    [1000, 640, false], [1280, 800, false], [1920, 1080, false]]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: touch, hasTouch: touch, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let mode = 'loading', heldDetail, attempts = 0
    const resource = { id: 1, libraryId: 1, isPrimary: true, name: '很长的主资源名称'.repeat(5), kind: 'local',
      playable: true, reason: null, mime: 'video/webm', format: 'WEBM', durationSeconds: 123, sizeBytes: 456,
      libraryName: '合成媒体库', downloadUrl: null, link: null }
    const film = { id: 17, title: '长中文影片标题与多行文本'.repeat(4), code: 'STYLE-17', cover: '/detail-fixture-cover',
      releaseDate: '2026-09-30', duration: 123, rating: 4.5,
      summary: '第一行合成简介。\n第二行：'.repeat(5), maker: '长制作商'.repeat(8), publisher: '发行商', series: '系列', director: '导演',
      actresses: [
        { id: 1, name: '长演员名称'.repeat(6), gender: 'female', avatar: '/detail-fixture-avatar' },
        { id: 2, name: '男演员', gender: 'male', avatar: null },
        { id: 3, name: '未知演员', gender: null, avatar: '/detail-fixture-broken' }
      ], tags: [{ id: 1, name: '长标签'.repeat(8) }, { id: 2, name: '合成标签' }],
      images: ['/detail-fixture-landscape', '/detail-fixture-portrait', '/detail-fixture-broken'], resources: [resource] }
    await page.route('**/detail-fixture-*', route => {
      const pathname = new URL(route.request().url()).pathname
      return pathname.endsWith('broken') ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${pathname.endsWith('portrait') ? 1200 : 450}"><rect width="100%" height="100%" fill="teal"/></svg>` })
    })
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url()), pathname = url.pathname
      if (pathname.includes('/media/')) {
        if (mode === 'play-error') return route.fulfill({ status: 404, body: '' })
        const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '')
        const start = range ? Number(range[1]) : 0
        const end = range?.[2] ? Math.min(Number(range[2]), movie.length - 1) : movie.length - 1
        return route.fulfill({ status: range ? 206 : 200, contentType: 'video/webm',
          headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${movie.length}` } : {}) }, body: movie.subarray(start, end + 1) })
      }
      if (pathname === '/api/videos/17') {
        if (mode === 'loading') { heldDetail = route; return }
        if (mode === 'read-error' && attempts++ === 0) return route.fulfill({ status: 503, json: { error: '合成详情读取失败' } })
        return route.fulfill({ json: mode === 'empty' ? { ...film, cover: null, releaseDate: null, duration: null, rating: 0,
          summary: null, maker: null, publisher: null, series: null, director: null, actresses: [], tags: [], images: [], resources: [] }
          : mode === 'fallback' ? { ...film, resources: [{ ...resource, playable: false, reason: '浏览器不支持此格式' }] } : film })
      }
      return route.fulfill({ json: pathname === '/api/session' ? { authenticated: true, username: 'style-test' }
        : pathname === '/api/collections' ? { libraries: [], playlists: [] }
          : pathname === '/api/home' ? { discovery: [], recent: [] } : { items: [film], total: 1, page: 1, pageSize: 36 } })
    })
    await page.goto(`${base}/#/browse/video/17`)
    await page.getByText('正在读取影片…', { exact: true }).waitFor()
    await snapshot(page, `${width}-loading`)
    mode = 'rich'
    await heldDetail.fulfill({ json: film })
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1)
    assert.equal(await page.locator('video').evaluate(video => video.paused), true)
    await snapshot(page, `${width}-loaded`)
    const actor = page.locator('a[href^="#/browse?actress="]').first()
    await tabTo(page, 'a[href^="#/browse?actress="]')
    await snapshot(page, `${width}-actor-focus`)
    if (!touch) {
      await actor.hover()
      await page.mouse.down()
      await snapshot(page, `${width}-actor-press`)
      await page.mouse.up()
    }
    for (const state of ['fallback', 'empty', 'play-error', 'read-error']) {
      // Reset the actual document before changing fixture responses. Same-hash SPA
      // navigation can reuse the mounted detail and intentionally not refetch it.
      await page.goto(base)
      await page.reload()
      await page.getByRole('heading', { name: '发现你的收藏', exact: true }).waitFor()
      mode = state
      const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/videos/17')
      await page.goto(`${base}/#/browse/video/17`)
      await loaded
      if (state === 'read-error') {
        await page.getByRole('alert').filter({ hasText: '合成详情读取失败' }).waitFor()
        await snapshot(page, `${width}-read-error`)
        await page.getByRole('button', { name: '重试', exact: true }).click()
        await page.getByRole('heading', { name: film.title, exact: true }).waitFor()
        await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1)
        await snapshot(page, `${width}-retry`)
      } else {
        await page.getByRole('heading', { name: film.title, exact: true }).waitFor()
        if (state === 'play-error') await page.getByRole('button', { name: '重试播放', exact: true }).waitFor()
        if (state === 'empty') {
          await page.getByText('暂无可播放资源。', { exact: true }).waitFor()
          assert.equal(await page.locator('video').count(), 0)
        }
        await snapshot(page, `${width}-${state}`)
      }
    }
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`PASS detail styles ${width}×${height}`)
  }
  fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Detail style evidence: ${output}`)
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
