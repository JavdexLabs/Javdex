import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { upsertActressFromScrape } from '../db/actressRepo'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { mediaAssetStore } from '../services/mediaAssetStore'
import { resetAssetKeyCacheForTests } from '../services/assetCrypto'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { scrapeBrowser } from './scrapeBrowser'
import { createCompositeScraper, installScraperPluginPackage } from './scraperPluginService'
import { scrapeVideo, videoScrapeApplyBridge } from './scraperManager'

const MINIMAL_JPEG = Buffer.from(
  'ffd8ffe000104a4649460000010101004800480000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191082242b1c11552d1f0243362728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f007b941100ffd9',
  'hex'
)

let tempRoot: string | null = null
let previousUserData: string | undefined

function listRelFiles(subdir: string): string[] {
  assert.ok(tempRoot)
  const dir = path.join(tempRoot, 'media_assets', subdir)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile())
}

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
  resetAssetKeyCacheForTests()
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

  it('discards the whole sample set when any sample download fails but still applies text', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Partial Samples Source',
      version: '1.0.0',
      description: 'Returns text and two sample urls',
      supportedFields: ['title', 'samples'],
      code: `module.exports = { async parseVideo(ctx) {
        return {
          code: ctx.code,
          title: 'With samples',
          sampleImageUrls: [
            'https://sample.example/one.jpg',
            'https://sample.example/two.jpg'
          ]
        };
      } };`
    })
    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    scrapeBrowser.fetchBuffer = async (url) => {
      if (url.endsWith('two.jpg')) return Buffer.from('<html>challenge</html>')
      return MINIMAL_JPEG
    }

    try {
      const outcome = await scrapeVideo(1, 'Partial Samples Source', {
        fields: ['title', 'samples'],
        mode: 'replace',
        closeBrowser: false
      })

      assert.equal(outcome.ok, true)
      assert.equal(outcome.skipped, false)
      assert.equal(
        (getDb().prepare('SELECT title FROM videos WHERE id = 1').get() as { title: string }).title,
        'With samples'
      )
      assert.equal(
        (getDb().prepare('SELECT COUNT(*) AS c FROM video_assets WHERE video_id = 1 AND type = ?')
          .get('sample') as { c: number }).c,
        0
      )
      assert.deepEqual(listRelFiles('samples'), [])
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
    }
  })

  it('compensates downloaded assets when the apply phase throws after downloads commit', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Cover Then Boom Source',
      version: '1.0.0',
      description: 'Returns a cover that downloads before apply fails',
      supportedFields: ['title', 'cover'],
      code: `module.exports = { async parseVideo(ctx) {
        return { code: ctx.code, title: 'Should not stick', coverUrl: 'https://cover.example/ok.jpg' };
      } };`
    })
    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    const originalApply = videoScrapeApplyBridge.applyScrapeResult
    scrapeBrowser.fetchBuffer = async () => MINIMAL_JPEG
    videoScrapeApplyBridge.applyScrapeResult = (() => {
      throw new Error('forced apply failure after download')
    }) as typeof originalApply

    try {
      const outcome = await scrapeVideo(1, 'Cover Then Boom Source', {
        fields: ['title', 'cover'],
        mode: 'replace',
        closeBrowser: false
      })

      assert.equal(outcome.ok, false)
      assert.match(outcome.error ?? '', /forced apply failure after download/)
      assert.deepEqual(
        getDb().prepare('SELECT title, cover_path, scraped_status FROM videos WHERE id = 1').get(),
        { title: null, cover_path: null, scraped_status: 2 }
      )
      assert.deepEqual(listRelFiles('covers'), [])
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
      videoScrapeApplyBridge.applyScrapeResult = originalApply
    }
  })

  it('discards a downloaded cast avatar when the actress already has a usable avatar', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Cast Avatar Source',
      version: '1.0.0',
      description: 'Returns cast with an avatar url',
      supportedFields: ['title', 'actressesFemale'],
      code: `module.exports = { async parseVideo(ctx) {
        return {
          code: ctx.code,
          title: 'Cast title',
          actresses: [{ name: 'Existing Actress', gender: 'female', avatarUrl: 'https://avatar.example/new.jpg' }]
        };
      } };`
    })
    assert.ok(tempRoot)
    const existingAvatar = 'avatars/existing.jpg'
    const existingAbs = path.join(tempRoot, 'media_assets', existingAvatar)
    fs.mkdirSync(path.dirname(existingAbs), { recursive: true })
    fs.writeFileSync(existingAbs, MINIMAL_JPEG)
    const actressId = upsertActressFromScrape('Existing Actress', null, 'female')
    getDb()
      .prepare('UPDATE actresses SET avatar_path = ? WHERE id = ?')
      .run(existingAvatar, actressId)

    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    scrapeBrowser.fetchBuffer = async () => MINIMAL_JPEG

    try {
      const beforeAvatars = new Set(listRelFiles('avatars'))
      const outcome = await scrapeVideo(1, 'Cast Avatar Source', {
        fields: ['title', 'actressesFemale'],
        mode: 'replace',
        closeBrowser: false
      })

      assert.equal(outcome.ok, true)
      assert.equal(
        (getDb().prepare('SELECT title FROM videos WHERE id = 1').get() as { title: string }).title,
        'Cast title'
      )
      assert.equal(
        (
          getDb().prepare('SELECT avatar_path FROM actresses WHERE id = ?').get(actressId) as {
            avatar_path: string
          }
        ).avatar_path,
        existingAvatar
      )
      assert.deepEqual(listRelFiles('avatars').sort(), [...beforeAvatars].sort())
      assert.equal(fs.existsSync(existingAbs), true)
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
    }
  })
})
