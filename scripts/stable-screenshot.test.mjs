import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installStableScreenshots } from './lib/stable-screenshot.mjs'
import { chromium } from 'playwright-core'

test('stable fixture snapshots wait before capture and preserve options and return value', async () => {
  const calls = [], options = { path: 'fixture.png', fullPage: true }, pixels = Buffer.from('fixture')
  const page = { async evaluate(callback) { calls.push(['wait', typeof callback]) },
    async screenshot(value) { assert.equal(this, page); calls.push(['capture', value]); return pixels } }
  installStableScreenshots(page)
  assert.equal(await page.screenshot(options), pixels)
  assert.deepEqual(calls, [['wait', 'function'], ['capture', options]])
})

test('a failed stability wait is not reported as a successful capture', async () => {
  let captures = 0
  const page = { async evaluate() { throw new Error('wait failed') }, async screenshot() { captures++ } }
  installStableScreenshots(page)
  await assert.rejects(page.screenshot({ path: 'fixture.png' }), /wait failed/)
  assert.equal(captures, 0)
})

test('clipped lazy images do not block a stable screenshot', { timeout: 10000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.route('http://fixture.test/', route => route.fulfill({ contentType: 'text/html', body: `<div style="position:absolute;left:219px;top:55px;width:516px;height:58px;overflow:auto hidden">
      <img loading="lazy" width="70" height="44" style="display:block;margin-left:1209px;margin-top:7px" src="media://fixture-gallery.svg?size=320">
      </div><button>Visible action</button>` }))
    await page.goto('http://fixture.test/')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.locator('img').evaluate(image => image.complete), false)
    installStableScreenshots(page)
    assert.ok((await page.screenshot()).length > 0)
    assert.equal(await page.locator('img').evaluate(image => image.complete), false, 'snapshot must not force-load a clipped image')
  } finally { await browser.close() }
})

test('visible images finish loading before capture rather than skipping all image waits', { timeout: 10000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage()
    let receive
    const requested = new Promise(resolve => { receive = resolve })
    await page.route('http://fixture.test/visible.svg', route => receive(route))
    await page.route('http://fixture.test/', route => route.fulfill({ contentType: 'text/html',
      body: '<img loading="lazy" width="100" height="100" src="/visible.svg"><button>Visible action</button>' }))
    await page.goto('http://fixture.test/')
    const route = await requested
    const nativeScreenshot = page.screenshot.bind(page)
    page.screenshot = async options => {
      assert.equal(await page.locator('img').evaluate(image => image.complete && image.naturalWidth > 0), true)
      return nativeScreenshot(options)
    }
    installStableScreenshots(page)
    const capture = page.screenshot()
    // Observe actual frames while the fixture holds the response, not a timed
    // sleep or an image forced into the viewport by the screenshot helper.
    capture.catch(() => {})
    await page.evaluate(async () => { for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame) })
    await route.fulfill({ contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="teal"/></svg>' })
    assert.ok((await capture).length > 0)
  } finally { await browser.close() }
})
