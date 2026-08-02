import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { scrapeBrowser } from './scrapeBrowser'
import { createCompositeScraper, installScraperPluginPackage } from './scraperPluginService'
import { scrapeVideo } from './scraperManager'

let tempRoot: string | null = null
let previousUserData: string | undefined

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-video-scraper-manager-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  resetSettingsCacheForTests()
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  insertTestVideoWithFile(getDb(), {
    code: 'TEST-001',
    filePath: 'test.mp4',
    scrapedStatus: 0
  })
})

afterEach(() => {
  scrapeBrowser.close()
  closeDatabase()
  resetSettingsCacheForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  previousUserData = undefined
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('scraperManager.scrapeVideo', () => {
  it('reports a matched result as skipped when no selected value can be applied', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Empty Video Source',
      version: '1.0.0',
      description: 'Matches without returning the selected value',
      supportedFields: ['summary'],
      code: `module.exports = { async parseVideo(ctx) { return { code: ctx.code }; } };`
    })

    const outcome = await scrapeVideo(1, 'Empty Video Source', {
      fields: ['summary'],
      mode: 'replaceIfPresent',
      closeBrowser: false
    })

    assert.equal(outcome.ok, true)
    assert.equal(outcome.skipped, true)
    assert.deepEqual(outcome.warnings, [])
    assert.deepEqual(
      getDb().prepare('SELECT scraped_status, last_scraped_at FROM videos WHERE id = 1').get(),
      { scraped_status: 0, last_scraped_at: null }
    )
  })

  it('stores composite source links and ratings under their actual field plugins', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Link Field Source',
      version: '1.0.0',
      description: 'Returns the source link',
      supportedFields: ['source'],
      code: `module.exports = { async parseVideo(ctx) { return { code: ctx.code, sourceUrl: 'https://link.example/TEST-001' }; } };`
    })
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Rating Field Source',
      version: '1.0.0',
      description: 'Returns the site rating',
      supportedFields: ['rating'],
      code: `module.exports = { async parseVideo(ctx) { return { code: ctx.code, ratingAverage: 4.5, ratingCount: 10 }; } };`
    })
    createCompositeScraper('video', {
      name: 'Metadata Composite',
      fieldPluginMap: {
        source: 'Link Field Source',
        rating: 'Rating Field Source'
      }
    })

    const outcome = await scrapeVideo(1, 'Metadata Composite', {
      fields: ['source', 'rating'],
      mode: 'replace',
      closeBrowser: false
    })

    assert.equal(outcome.ok, true)
    assert.deepEqual(
      getDb().prepare('SELECT source, url FROM video_external_ids WHERE video_id = 1').all(),
      [{ source: 'Link Field Source', url: 'https://link.example/TEST-001' }]
    )
    assert.deepEqual(
      getDb()
        .prepare('SELECT source, rating_average, rating_count FROM video_external_stats WHERE video_id = 1')
        .all(),
      [{ source: 'Rating Field Source', rating_average: 4.5, rating_count: 10 }]
    )
  })

  it('does not clear fields unsupported by the selected plugin', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Title Only Source',
      version: '1.0.0',
      description: 'Returns only a title',
      supportedFields: ['title'],
      code: `module.exports = { async parseVideo(ctx) { return { code: ctx.code, title: 'Supported title' }; } };`
    })
    getDb().prepare("UPDATE videos SET summary = 'Keep summary' WHERE id = 1").run()

    const outcome = await scrapeVideo(1, 'Title Only Source', {
      fields: ['title', 'summary'],
      mode: 'replace',
      closeBrowser: false
    })

    assert.equal(outcome.ok, true)
    assert.deepEqual(
      getDb().prepare('SELECT title, summary FROM videos WHERE id = 1').get(),
      { title: 'Supported title', summary: 'Keep summary' }
    )
  })

  it('preserves a composite field when its source does not match but another source succeeds', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'No Match Link Source',
      version: '1.0.0',
      description: 'Does not match the requested video',
      supportedFields: ['source'],
      code: `module.exports = { async parseVideo() { return null; } };`
    })
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Matched Title Source',
      version: '1.0.0',
      description: 'Returns a title',
      supportedFields: ['title'],
      code: `module.exports = { async parseVideo(ctx) { return { code: ctx.code, title: 'Matched title' }; } };`
    })
    createCompositeScraper('video', {
      name: 'Partial Match Composite',
      fieldPluginMap: {
        source: 'No Match Link Source',
        title: 'Matched Title Source'
      }
    })
    getDb().prepare(
      "INSERT INTO video_external_ids (video_id, source, url, fetched_at) VALUES (1, 'No Match Link Source', 'https://keep.example', '2024-01-01')"
    ).run()

    const outcome = await scrapeVideo(1, 'Partial Match Composite', {
      fields: ['source', 'title'],
      mode: 'replace',
      closeBrowser: false
    })

    assert.equal(outcome.ok, true)
    assert.deepEqual(
      getDb().prepare('SELECT source, url FROM video_external_ids WHERE video_id = 1').all(),
      [{ source: 'No Match Link Source', url: 'https://keep.example' }]
    )
    assert.equal(
      (getDb().prepare('SELECT title FROM videos WHERE id = 1').get() as { title: string }).title,
      'Matched title'
    )
  })

  it('applies text data but preserves an old cover when the returned image is unusable', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Broken Cover Source',
      version: '1.0.0',
      description: 'Returns text and an unusable cover',
      supportedFields: ['title', 'cover'],
      code: `module.exports = { async parseVideo(ctx) { return { code: ctx.code, title: 'Updated', coverUrl: 'https://cover.example/broken.jpg' }; } };`
    })
    assert.ok(tempRoot)
    const oldCover = 'covers/old.jpg'
    const oldCoverAbs = path.join(tempRoot, 'media_assets', oldCover)
    fs.mkdirSync(path.dirname(oldCoverAbs), { recursive: true })
    fs.writeFileSync(oldCoverAbs, Buffer.from('ffd8ffe000104a464946', 'hex'))
    getDb().prepare('UPDATE videos SET cover_path = ? WHERE id = 1').run(oldCover)
    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    scrapeBrowser.fetchBuffer = async () => Buffer.from('<html>challenge</html>')

    try {
      const outcome = await scrapeVideo(1, 'Broken Cover Source', {
        fields: ['title', 'cover'],
        mode: 'replace',
        closeBrowser: false
      })

      assert.equal(outcome.ok, true)
      assert.equal(outcome.skipped, false)
      assert.deepEqual(outcome.warnings, ['封面下载失败，已保留原封面'])
      assert.deepEqual(
        getDb().prepare('SELECT title, cover_path FROM videos WHERE id = 1').get(),
        { title: 'Updated', cover_path: oldCover }
      )
      assert.equal(fs.existsSync(oldCoverAbs), true)
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
    }
  })
})
