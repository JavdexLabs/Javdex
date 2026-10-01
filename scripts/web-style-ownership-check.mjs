// Run after web:build. Actual Web entry, isolated synthetic API; no personal library or clipboard.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { tabTo } from './web-keyboard-journey.mjs'

const root = path.resolve('out/web')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-web-style-'))
const report = []
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
async function snapshot(page, name, locator) {
  await locator.scrollIntoViewIfNeeded()
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(document.getAnimations().filter(animation =>
      animation.effect?.getComputedTiming().iterations !== Infinity
    ).map(animation => animation.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const metrics = await locator.evaluate(root => {
    const base = root.getBoundingClientRect()
    const properties = ['display', 'height', 'width', 'minHeight', 'minWidth', 'padding', 'gap',
      'fontSize', 'color', 'backgroundColor', 'borderTopColor', 'borderRadius', 'boxShadow',
      'outlineStyle', 'overflowWrap', 'whiteSpace', 'opacity', 'objectFit']
    return [root, ...root.querySelectorAll('article, button, a, input, small, img')].map(element => {
      const box = element.getBoundingClientRect()
      const css = getComputedStyle(element)
      return { tag: element.tagName, label: element.getAttribute('aria-label'),
        box: [box.x - base.x, box.y - base.y, box.width, box.height],
        style: Object.fromEntries(properties.map(property => [property, css[property]])) }
    })
  })
  await locator.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' })
  report.push({ name, metrics })
}
try {
  browser = await chromium.launch({ channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome', headless: true })
  const base = `http://127.0.0.1:${server.address().port}`
  for (const [width, height, touch] of [[320, 844, true], [390, 844, true], [844, 390, true], [1280, 800, false]]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: touch, hasTouch: touch,
      reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
      document.execCommand = () => {
        const field = document.querySelector('textarea')
        const css = getComputedStyle(field)
        window.copyProbe = { value: field.value, selected: field.selectionStart === 0 && field.selectionEnd === field.value.length,
          position: css.position, top: css.top, left: css.left, opacity: css.opacity, pointerEvents: css.pointerEvents }
        return true
      }
    })
    const resources = [
      { id: 1, name: '可播放备用资源', kind: 'local', playable: true, isPrimary: false,
        format: 'MP4', sizeBytes: 2147483648, durationSeconds: 7200 },
      { id: 2, name: '长路径'.repeat(12), kind: 'local', playable: false, isPrimary: true,
        libraryName: '媒体库甲', reason: '浏览器不支持此格式', downloadUrl: '/api/download', format: 'MKV' },
      { id: 3, name: '长路径'.repeat(12), kind: 'web', playable: false, isPrimary: false,
        libraryName: '媒体库乙', reason: '请在新窗口打开', link: 'https://example.com/watch?id=17' }
    ]
    const film = { id: 17, title: '样式迁移测试影片', code: 'STYLE-17', cover: '/fixture-cover',
      summary: '合成数据，不访问用户资料。', actresses: [], tags: [], rating: 0,
      images: ['/fixture-landscape', '/fixture-portrait', '/fixture-broken'], resources }
    await page.route('**/fixture-*', route => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname.endsWith('broken')) return route.fulfill({ status: 404, body: '' })
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${pathname.endsWith('portrait') ? 1200 : 450}"><rect width="100%" height="100%" fill="teal"/></svg>` })
    })
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname
      const json = pathname === '/api/session' ? { authenticated: true, username: 'style-test' }
        : pathname === '/api/collections' ? { libraries: [], playlists: [] }
          : pathname === '/api/home' ? { discovery: [], recent: [] }
            : pathname === '/api/videos' ? { items: [film], total: 1, page: 1, pageSize: 36 } : film
      return route.fulfill({ json })
    })
    await page.goto(`${base}/#/browse/video/17`)
    await page.getByRole('heading', { name: film.title, exact: true }).waitFor()
    const cards = page.getByRole('article')
    const list = cards.first().locator('..')
    const linkCard = cards.nth(2)
    const copyButton = linkCard.getByRole('button', { name: '复制链接', exact: true })
    const feedback = page.getByRole('status').filter({ has: page.getByRole('button', { name: '关闭资源提示' }) })
    const dimensions = await cards.evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect()
      return [box.width, box.height]
    }))
    assert.equal(dimensions.length, 3)
    assert.ok(dimensions.every(box => box[1] === 80))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.match(await cards.nth(1).innerText(), /媒体库甲/)
    assert.match(await linkCard.innerText(), /媒体库乙/)
    await snapshot(page, `${width}-resources`, list)
    await tabTo(page, 'article:nth-child(3) button[aria-label="复制链接"]')
    await snapshot(page, `${width}-resource-focus`, list)
    assert.equal(await copyButton.evaluate(element => getComputedStyle(element).boxShadow), 'rgb(143, 210, 179) 0px 0px 0px 1px')
    assert.equal(await copyButton.evaluate(element => getComputedStyle(element).borderTopColor), 'rgb(143, 210, 179)')
    await page.keyboard.press('Enter')
    await page.getByText('链接已复制', { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.copyProbe), {
      value: resources[2].link, selected: true, position: 'fixed', top: '0px', left: '0px', opacity: '0', pointerEvents: 'none'
    })
    assert.equal(await page.locator('textarea').count(), 0)
    assert.equal(await copyButton.evaluate(element => document.activeElement === element), true)
    await page.evaluate(() => { document.execCommand = () => false })
    await copyButton.click()
    const manual = page.getByRole('textbox', { name: '复制失败，请手动复制链接' })
    await manual.waitFor()
    await snapshot(page, `${width}-copy-failed`, feedback)
    await manual.focus()
    assert.equal(await manual.evaluate(element => element.selectionEnd - element.selectionStart === element.value.length), true)
    await feedback.getByRole('button', { name: '关闭资源提示' }).click()
    assert.equal(await copyButton.evaluate(element => document.activeElement === element), true)
    await cards.nth(1).getByRole('button').click()
    await page.getByText('浏览器不支持此格式', { exact: true }).waitFor()
    await snapshot(page, `${width}-resource-reason`, feedback)
    await feedback.getByRole('button', { name: '关闭资源提示' }).click()
    // A newer explanation wins over a late secure-clipboard completion.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: link => {
        window.secureCopyLink = link
        return new Promise(resolve => { window.secureCopyResolve = resolve })
      }
    } }))
    await copyButton.click()
    await page.waitForFunction(() => typeof window.secureCopyResolve === 'function')
    await cards.nth(1).getByRole('button').click()
    await page.evaluate(() => { window.secureCopyResolve() })
    assert.equal(await page.evaluate(() => window.secureCopyLink), resources[2].link)
    assert.match(await feedback.innerText(), /浏览器不支持此格式/)
    assert.equal(await feedback.count(), 1)
    await feedback.getByRole('button', { name: '关闭资源提示' }).click()
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async link => { window.secureCopyLink = link }
    } }))
    await copyButton.click()
    await page.getByText('链接已复制', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.secureCopyLink), resources[2].link)
    await feedback.getByRole('button', { name: '关闭资源提示' }).click()
    assert.deepEqual(await cards.evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect()
      return [box.width, box.height]
    })), dimensions, 'feedback does not resize cards')
    for (const action of await linkCard.getByRole('link').all()) {
      const box = await action.boundingBox()
      assert.ok(box.width >= 48 && box.height >= 48)
    }
    if (!touch) {
      await copyButton.hover()
      assert.equal(await copyButton.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(52, 59, 61)')
      assert.equal(await copyButton.evaluate(element => getComputedStyle(element).color), 'rgb(240, 242, 241)')
      await page.mouse.down()
      assert.equal(await copyButton.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(40, 61, 55)')
      await page.mouse.up()
      await page.getByText('链接已复制', { exact: true }).waitFor()
      await feedback.getByRole('button', { name: '关闭资源提示' }).click()
    }
    // Heading buttons override the base background, but must retain press feedback.
    const heading = cards.nth(1).getByRole('button')
    await heading.hover()
    await page.mouse.down()
    assert.equal(await heading.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(40, 61, 55)')
    await page.mouse.up()
    await page.getByText('浏览器不支持此格式', { exact: true }).waitFor()
    await feedback.getByRole('button', { name: '关闭资源提示' }).click()
    const preview = page.getByRole('dialog', { name: '图片预览', exact: true })
    for (const [ordinal, name] of [[1, 'landscape'], [2, 'portrait'], [3, 'broken']]) {
      const trigger = page.getByRole('button', { name: `预览剧照 ${ordinal}`, exact: true })
      await trigger.click()
      await preview.waitFor()
      if (name === 'broken') await preview.getByRole('alert').waitFor()
      else await page.waitForFunction(() => {
        const image = document.querySelector('.yarl__slide_current img')
        return image?.complete && image.naturalWidth > 0
      })
      await snapshot(page, `${width}-preview-${name}`, preview)
      for (const button of await preview.getByRole('button').all()) {
        const box = await button.boundingBox()
        assert.ok(box.width >= 48 && box.height >= 48)
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height)
      }
      await page.keyboard.press('Tab')
      await page.keyboard.press('/')
      assert.equal(await preview.evaluate(element => element.contains(document.activeElement)), true)
      await page.keyboard.press('Escape')
      await preview.waitFor({ state: 'detached' })
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
      assert.ok(page.url().includes('/browse/video/17'))
    }
    const play = cards.first().getByRole('button', { name: '播放 可播放备用资源' })
    await play.click()
    await page.waitForFunction(() => document.querySelector('article button[aria-pressed="true"]'))
    assert.equal(await cards.first().evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(40, 61, 55)')
    assert.equal(await cards.first().evaluate(element => getComputedStyle(element).borderTopColor), 'rgb(143, 210, 179)')
    await snapshot(page, `${width}-resources-selected`, list)
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`PASS styles ${width}×${height} ${touch ? 'touch' : 'desktop'}`)
  }
  fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Style evidence: ${output}`)
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
