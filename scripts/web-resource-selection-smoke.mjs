// Run after web:build. Exercises the actual browser UI with synthetic catalog data.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright-core'

const root = path.resolve('out/web')
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  const file = path.resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`)
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    response.writeHead(404).end()
    return
  }
  response.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] ?? 'text/html')
  response.end(fs.readFileSync(file))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ channel: process.env.JAVDEX_BROWSER_CHANNEL || 'chrome', headless: true })
  const page = await browser.newPage()
  const film = { id: 1, title: 'Resource selection fixture', code: 'TEST-1', cover: null,
    rating: 0, images: [], actresses: [], tags: [] }
  const primaryA = { id: 11, name: 'Library A primary', libraryId: 1, libraryName: 'A', isPrimary: true, kind: 'local', playable: true }
  const primaryB = { id: 22, name: 'Library B primary', libraryId: 2, libraryName: 'B', isPrimary: true, kind: 'local', playable: true }
  let resources = [primaryA, primaryB]
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname
    const json = pathname === '/api/session' ? { authenticated: true, username: 'test' }
      : pathname === '/api/collections' ? { libraries: [{ id: 1, name: 'A', count: 1 }, { id: 2, name: 'B', count: 1 }], playlists: [] }
        : pathname === '/api/videos' ? { items: [film], total: 1, page: 1, pageSize: 36 }
          : pathname === '/api/home' ? { discovery: [film], recent: [] }
            : pathname.includes('/media/') ? {} : { ...film, resources }
    return route.fulfill({ json })
  })
  async function check(query, expected) {
    await page.goto(`http://127.0.0.1:${server.address().port}/#/browse/video/1?${query}`)
    await page.reload()
    await page.getByRole('heading', { name: film.title, exact: true }).waitFor()
    assert.deepEqual(await page.locator('video').evaluateAll(nodes => nodes.map(node => node.getAttribute('src'))),
      expected === null ? [] : [`/api/videos/1/media/${expected}`], query)
  }
  await check('library=2', 22)
  await check('library=1', 11)
  await check('library=999', null)
  resources = [{ ...primaryA, playable: false }, primaryB]
  await check('library=1', null) // Never fall through to another library.
  await check('', null) // Nor skip the first primary in an aggregate view.
  resources = [{ ...primaryA, playable: false }, { ...primaryB, libraryId: 1, isPrimary: false }]
  await check('library=1', null) // A playable backup requires explicit selection.
  await page.getByRole('button', { name: `播放 ${primaryB.name}`, exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.getAttribute('src') === '/api/videos/1/media/22')
  await check('library=1&play=22', 22)
  await check('library=1&play=999', null)
  resources = [{ ...primaryA, isPrimary: false }]
  await check('library=1', null)
  console.log('Resource scope, unavailable primary, explicit backup and invalid selection PASS')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
