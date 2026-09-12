// Browser QA uses synthetic catalog data only; never opens the user's database.
// Run after web:build: node --import tsx scripts/web-smoke.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { WebServer } from '../apps/desktop/src/main/web/server.ts'
import { hashPassword } from '../apps/desktop/src/main/web/auth.ts'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-web-smoke-'))
const movie = path.join(directory, 'native.mp4')
const output = process.env.JAVDEX_WEB_QA_OUTPUT || directory
fs.mkdirSync(output, { recursive: true })
const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x304c42:s=640x360:r=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', movie])
assert.equal(ffmpeg.status, 0, 'Browser playback QA requires ffmpeg on PATH')
const names = ['午后影院', '山间来信', '沿海公路', '雨中的城市', '森林记忆', '蓝色假日']
const artworks = ['cinemaCover', 'forestCover', 'seaCover', 'rainCover', 'cityCover', 'blueCover']
const videos = Array.from({ length: 48 }, (_, i) => ({ id: i + 1, code: `DEMO-${String(i + 1).padStart(3, '0')}`, title: `${names[i % names.length]} · 演示影片 ${i + 1}`, cover: `/api/videos/${i + 1}/images/cover`, releaseDate: '2026-09-01', duration: 5400, rating: 4 }))
const catalog = {
  collections: () => ({ libraries: [{ id: 1, name: '家庭影院', count: 48 }, { id: 2, name: '周末收藏', count: 24 }], playlists: [{ id: 1, name: '想看的影片', count: 12 }] }),
  browse: query => {
    const page = Number(query.get('page') || 1)
    const items = videos.filter(v => v.title.includes(query.get('q') || '') || v.code.includes(query.get('q') || ''))
    return { items: items.slice((page - 1) * 36, page * 36), total: items.length, page, pageSize: 36 }
  },
  detail: id => ({ ...videos[id - 1], summary: '这是一条用于布局与播放验证的演示资料。浏览器直接读取原始视频，所有媒体库管理操作保留在桌面端。', maker: 'Javdex 演示', publisher: null, series: '周末放映', director: null, actresses: [{ id: 1, name: '演示演员' }], tags: [{ id: 1, name: '旅行' }, { id: 2, name: '纪录' }], images: [`/api/videos/${id}/images/1`], resources: [{ id: 1, name: '演示视频 · MP4', kind: 'local', mime: 'video/mp4', playable: true, reason: null }, { id: 2, name: '不支持的资源', kind: 'magnet', mime: null, playable: false, reason: '此资源不支持浏览器原生播放' }] }),
  image: id => ({ body: fs.readFileSync(path.resolve(`website/assets/artwork/${artworks[(id - 1) % artworks.length]}.webp`)), mime: 'image/webp' }),
  media: () => ({ file: movie, stat: fs.statSync(movie), mime: 'video/mp4' })
}
const server = new WebServer({ username: 'viewer', passwordHash: await hashPassword('web smoke password'), staticRoot: path.resolve('out/web'), catalog })
const port = await server.start(0, '127.0.0.1')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const [name, width, height] of [['phone', 360, 800], ['tablet', 768, 1024], ['desktop', 1440, 1000], ['tv', 2560, 1440]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: name === 'phone', hasTouch: name === 'phone' || name === 'tablet' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()) })
    await page.goto(`http://127.0.0.1:${port}`)
    server.pairing.open()
    await page.getByPlaceholder('例如：客厅电视').fill(name)
    await page.getByRole('checkbox', { name: '记住此设备', exact: true }).check()
    await page.getByRole('button', { name: '获取配对码', exact: true }).click()
    await page.locator('.pair-code').waitFor()
    const code = (await page.locator('.pair-code').innerText()).replace(/\s/g, '')
    await page.screenshot({ path: path.join(output, `${name}-pair.png`), fullPage: true })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: pairing horizontal overflow`)
    server.pairing.decide(code, true)
    await page.locator('.video-card').first().waitFor()
    await page.locator('.poster img').evaluateAll(images => images.forEach(image => { image.loading = 'eager' }))
    await page.waitForFunction(() => [...document.querySelectorAll('.poster img')].every(image => image.complete && image.naturalWidth > 0))
    await page.locator('.poster img').evaluateAll(images => Promise.all(images.map(image => image.decode())))
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: path.join(output, `${name}-browse.png`), fullPage: false })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: horizontal overflow`)
    const columns = await page.locator('.video-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    assert.ok(columns >= (name === 'phone' ? 2 : name === 'tablet' ? 3 : 5), `${name}: insufficient responsive columns ${columns}`)
    await page.getByLabel('搜索番号、片名或演员').fill('DEMO-001')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.video-card').length === 1)
    await page.locator('.video-card').first().click()
    await page.getByRole('heading', { name: '选择播放资源' }).waitFor()
    await page.getByRole('button', { name: /演示视频 · MP4/ }).click()
    await page.locator('video').waitFor()
    await page.waitForFunction(() => { const video = document.querySelector('video'); return video && video.readyState >= 2 && video.currentTime > 0 }, { timeout: 15000 })
    assert.ok(await page.locator('video').evaluate(video => video.videoWidth === 640))
    await page.screenshot({ path: path.join(output, `${name}-player.png`), fullPage: true })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: player horizontal overflow`)
    await page.getByRole('button', { name: '返回浏览' }).click()
    assert.equal(await page.locator('.video-card').count(), 1)
    assert.ok(page.url().includes('q=DEMO-001'))
    await page.reload()
    await page.locator('.video-card').first().waitFor()
    await page.getByRole('button', { name: /退出登录/ }).click()
    await page.getByRole('button', { name: '获取配对码', exact: true }).waitFor()
    assert.equal((await context.request.get(`http://127.0.0.1:${port}/api/videos`)).status(), 401)
    await page.getByRole('button', { name: '密码登录', exact: true }).click()
    await page.getByLabel('访问账号', { exact: true }).fill('viewer')
    await page.getByLabel('访问密码', { exact: true }).fill('web smoke password')
    await page.getByRole('button', { name: '进入媒体库' }).click()
    await page.locator('.video-card').first().waitFor()
    assert.deepEqual(errors, [])
    console.log(`${name}: ${width}×${height}, ${columns} columns; pairing/password/search/detail/native playback/return/reload/logout PASS`)
    await context.close()
  }
  console.log(`Screenshots: ${output}`)
} finally {
  await browser.close()
  await server.stop()
  fs.rmSync(movie, { force: true })
}
