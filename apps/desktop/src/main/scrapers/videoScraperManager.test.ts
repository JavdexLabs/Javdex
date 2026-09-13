import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findActressByNameOrAlias,
  getActressDetail,
  upsertActressFromScrape
} from '@library/db/actressRepo'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { createMediaLibrary } from '@library/db/mediaLibraryRepo'
import { getPendingVideoScrapeForVideo } from '@library/db/pendingVideoScrapeRepo'
import { classificationMaintenanceService } from '../services/classificationMaintenanceService'
import { resetAssetKeyCacheForTests } from '@library/assetCrypto'
import { resetSettingsCacheForTests, updateSettings } from '../settings/settingsStore'
import { LOCAL_NFO_SOURCE_NAME } from '@shared/videoMetadataSourceConstants'
import {
  cleanupOrphanedVideoScrapeStaging,
  videoPendingScrapeService
} from '../services/videoPendingScrapeService'
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
  it('uses the built-in local NFO source for manual, composite, and default runs without network fallback', async () => {
    assert.ok(tempRoot)
    const mediaDirectory = path.join(tempRoot, 'nfo-media')
    fs.mkdirSync(mediaDirectory)
    const library = createMediaLibrary({
      name: 'Local NFO',
      roots: [{ path: mediaDirectory }]
    })
    const videoPath = path.join(mediaDirectory, 'LOCAL-001.mp4')
    fs.writeFileSync(videoPath, 'video')
    fs.writeFileSync(
      path.join(mediaDirectory, 'LOCAL-001.nfo'),
      '<movie><num>LOCAL-001</num><title>Local title</title></movie>'
    )
    fs.writeFileSync(path.join(mediaDirectory, 'LOCAL-001-poster.jpg'), MINIMAL_JPEG)
    const { videoId } = insertTestVideoWithFile(getDb(), {
      code: 'LOCAL-001',
      filePath: videoPath,
      libraryId: library.id,
      rootId: library.roots[0].id,
      scrapedStatus: 0
    })

    const manual = await scrapeVideo(videoId, LOCAL_NFO_SOURCE_NAME, {
      fields: ['title', 'cover'],
      mode: 'replace',
      closeBrowser: false
    })
    assert.equal(manual.ok, true)
    assert.equal(manual.skipped, false)
    const afterManual = getDb()
      .prepare('SELECT title, cover_path, scraped_status FROM videos WHERE id = ?')
      .get(videoId) as { title: string; cover_path: string; scraped_status: number }
    assert.equal(afterManual.title, 'Local title')
    assert.equal(afterManual.scraped_status, 1)
    assert.ok(afterManual.cover_path)
    assert.equal(fs.existsSync(path.join(tempRoot, 'media_assets', afterManual.cover_path)), true)

    createCompositeScraper('video', {
      name: 'Local NFO composite',
      fieldPluginMap: { title: LOCAL_NFO_SOURCE_NAME }
    })
    getDb().prepare('UPDATE videos SET title = NULL, scraped_status = 0 WHERE id = ?').run(videoId)
    const composite = await scrapeVideo(videoId, 'Local NFO composite', {
      fields: ['title'],
      mode: 'fillEmpty',
      closeBrowser: false
    })
    assert.equal(composite.ok, true)
    assert.equal(
      (getDb().prepare('SELECT title FROM videos WHERE id = ?').get(videoId) as { title: string })
        .title,
      'Local title'
    )

    updateSettings({ defaultScraper: LOCAL_NFO_SOURCE_NAME })
    getDb().prepare('UPDATE videos SET title = NULL, scraped_status = 0 WHERE id = ?').run(videoId)
    const defaultRun = await scrapeVideo(videoId, undefined, {
      fields: ['title'],
      mode: 'fillEmpty',
      closeBrowser: false
    })
    assert.equal(defaultRun.ok, true)
    assert.equal(defaultRun.result?.title, 'Local title')
  })

  it('treats a missing local NFO as a normal no-match without marking scrape failure', async () => {
    const outcome = await scrapeVideo(1, LOCAL_NFO_SOURCE_NAME, {
      fields: ['title'],
      mode: 'replace',
      closeBrowser: false
    })

    assert.deepEqual(outcome, { ok: true, skipped: true, warnings: [] })
    assert.deepEqual(
      getDb().prepare('SELECT scraped_status, last_scraped_at FROM videos WHERE id = 1').get(),
      { scraped_status: 0, last_scraped_at: null }
    )
  })

  it('uses only the effective composite field sources to classify a quiet local NFO no-match', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Unused Web Source',
      version: '1.0.0',
      description: 'Must not run when its field was not requested',
      supportedFields: ['summary'],
      code: `module.exports = { async parseVideo() { throw new Error('unexpected web call') } };`
    })
    createCompositeScraper('video', {
      name: 'Effective local-only composite',
      fieldPluginMap: {
        title: LOCAL_NFO_SOURCE_NAME,
        summary: 'Unused Web Source'
      }
    })

    const outcome = await scrapeVideo(1, 'Effective local-only composite', {
      fields: ['title'],
      mode: 'replace',
      closeBrowser: false
    })

    assert.deepEqual(outcome, { ok: true, skipped: true, warnings: [] })
    assert.deepEqual(
      getDb().prepare('SELECT scraped_status, last_scraped_at FROM videos WHERE id = 1').get(),
      { scraped_status: 0, last_scraped_at: null }
    )
  })

  it('delivers actress avatars to the merged cast positions across local and web composite sources', async () => {
    assert.ok(tempRoot)
    const mediaDirectory = path.join(tempRoot, 'composite-cast-media')
    fs.mkdirSync(mediaDirectory)
    const library = createMediaLibrary({
      name: 'Composite cast',
      roots: [{ path: mediaDirectory }]
    })
    const videoPath = path.join(mediaDirectory, 'CAST-001.mp4')
    fs.writeFileSync(videoPath, 'video')
    fs.writeFileSync(
      path.join(mediaDirectory, 'CAST-001.nfo'),
      `<movie><num>CAST-001</num><actor><name>Local Actress</name><gender>female</gender>
       <thumb>.actors/Local Actress.jpg</thumb></actor></movie>`
    )
    fs.mkdirSync(path.join(mediaDirectory, '.actors'))
    fs.writeFileSync(path.join(mediaDirectory, '.actors', 'Local Actress.jpg'), MINIMAL_JPEG)
    const { videoId } = insertTestVideoWithFile(getDb(), {
      code: 'CAST-001',
      filePath: videoPath,
      libraryId: library.id,
      rootId: library.roots[0].id,
      scrapedStatus: 0
    })
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Male Cast Source',
      version: '1.0.0',
      supportedFields: ['actressesMale'],
      code: `module.exports = { async parseVideo(ctx) { return {
        code: ctx.code,
        actresses: [{ name: 'Web Actor', gender: 'male', avatarUrl: 'https://avatar.example/male.jpg' }]
      }; } };`
    })
    createCompositeScraper('video', {
      name: 'Local and web cast composite',
      fieldPluginMap: {
        actressesFemale: LOCAL_NFO_SOURCE_NAME,
        actressesMale: 'Male Cast Source'
      }
    })
    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    scrapeBrowser.fetchBuffer = async () => MINIMAL_JPEG

    try {
      const outcome = await scrapeVideo(videoId, 'Local and web cast composite', {
        fields: ['actressesFemale', 'actressesMale'],
        mode: 'replace',
        closeBrowser: false
      })

      assert.equal(outcome.ok, true)
      const localActressId = findActressByNameOrAlias('Local Actress')
      const webActorId = findActressByNameOrAlias('Web Actor')
      assert.ok(localActressId)
      assert.ok(webActorId)
      assert.equal(getActressDetail(localActressId)?.gender, 'female')
      assert.equal(getActressDetail(webActorId)?.gender, 'male')
      assert.ok(getActressDetail(localActressId)?.avatar_path)
      assert.ok(getActressDetail(webActorId)?.avatar_path)
      assert.notEqual(
        getActressDetail(localActressId)?.avatar_path,
        getActressDetail(webActorId)?.avatar_path
      )
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
    }
  })

  it('persists exact multi-candidate results without selecting or applying one by default', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Multi Candidate Source',
      version: '1.0.0',
      description: 'Returns two exact candidates',
      supportedFields: ['title', 'summary', 'source'],
      code: `module.exports = { async parseVideo(ctx) {
        return [
          { code: ctx.code, title: 'Candidate A', summary: 'A', sourceUrl: 'https://one.example/item' },
          { code: ctx.code, title: 'Candidate B', summary: 'B', sourceUrl: 'https://two.example/item' }
        ];
      } };`
    })

    const outcome = await scrapeVideo(1, 'Multi Candidate Source', {
      fields: ['title', 'summary', 'source'],
      mode: 'replace',
      closeBrowser: false
    })

    assert.equal(outcome.ok, true)
    assert.equal(outcome.pending, true)
    assert.equal(outcome.skipped, true)
    assert.deepEqual(
      getDb().prepare('SELECT title, summary, scraped_status FROM videos WHERE id = 1').get(),
      { title: null, summary: null, scraped_status: 0 }
    )
    const pending = getPendingVideoScrapeForVideo(1)
    assert.equal(pending?.sources.length, 1)
    assert.equal(pending?.sources[0].selectedCandidateId, null)
    assert.deepEqual(
      pending?.sources[0].candidates.map((candidate) => candidate.result.title),
      ['Candidate A', 'Candidate B']
    )
  })

  it('stages every declared candidate image even when the field was not selected', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Candidate Image Source',
      version: '1.0.0',
      description: 'Returns candidate images outside the selected fields',
      supportedFields: ['title', 'cover', 'samples', 'actressesFemale'],
      code: `module.exports = { async parseVideo(ctx) {
        return [1, 2].map((n) => ({
          code: ctx.code,
          title: 'Image candidate ' + n,
          coverUrl: 'https://image.example/cover-' + n + '.jpg',
          sampleImageUrls: ['https://image.example/sample-' + n + '.jpg'],
          actresses: [{ name: 'Actress ' + n, avatarUrl: 'https://image.example/avatar-' + n + '.jpg' }]
        }));
      } };`
    })
    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    scrapeBrowser.fetchBuffer = async () => MINIMAL_JPEG
    try {
      const outcome = await scrapeVideo(1, 'Candidate Image Source', {
        fields: ['title'],
        closeBrowser: false
      })

      assert.equal(outcome.pending, true)
      const pending = getPendingVideoScrapeForVideo(1)
      assert.ok((pending?.stagedBytes ?? 0) > 0)
      for (const candidate of pending?.sources[0].candidates ?? []) {
        assert.ok(candidate.stagedCoverPath)
        assert.equal(candidate.stagedSamplePaths.length, 1)
        assert.equal(candidate.stagedActressAvatarPaths.length, 1)
        for (const stagedPath of [
          candidate.stagedCoverPath,
          ...candidate.stagedSamplePaths,
          ...candidate.stagedActressAvatarPaths
        ]) {
          assert.ok(stagedPath)
          assert.equal(fs.existsSync(path.join(tempRoot!, 'media_assets', stagedPath)), true)
        }
      }
      assert.deepEqual(
        getDb().prepare('SELECT title, cover_path FROM videos WHERE id = 1').get(),
        { title: null, cover_path: null }
      )
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
    }
  })

  it('confirms a candidate from the local snapshot without visiting the remote site again', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Offline Confirm Source',
      version: '1.0.0',
      description: 'Stages candidates for an offline confirmation',
      supportedFields: ['title', 'cover'],
      code: `module.exports = { async parseVideo(ctx) {
        return [
          { code: ctx.code, title: 'First offline', coverUrl: 'https://image.example/first.jpg' },
          { code: ctx.code, title: 'Chosen offline', coverUrl: 'https://image.example/chosen.jpg' }
        ];
      } };`
    })
    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    scrapeBrowser.fetchBuffer = async () => MINIMAL_JPEG
    try {
      await scrapeVideo(1, 'Offline Confirm Source', {
        fields: ['title', 'cover'],
        closeBrowser: false
      })
      const pending = getPendingVideoScrapeForVideo(1)
      assert.ok(pending)
      const stagedPaths = pending.sources[0].candidates.flatMap((candidate) => [
        candidate.stagedCoverPath,
        ...candidate.stagedSamplePaths,
        ...candidate.stagedActressAvatarPaths
      ]).filter((value): value is string => Boolean(value))
      scrapeBrowser.fetchBuffer = async () => {
        throw new Error('confirmation must not use the network')
      }

      const confirmed = videoPendingScrapeService.confirm({
        pendingScrapeId: pending.id,
        selections: [{
          sourceId: pending.sources[0].id,
          candidateId: pending.sources[0].candidates[1].id
        }]
      })

      assert.equal(confirmed.status, 'applied')
      assert.equal(getPendingVideoScrapeForVideo(1), null)
      const video = getDb()
        .prepare('SELECT title, cover_path, scraped_status FROM videos WHERE id = 1')
        .get() as { title: string; cover_path: string; scraped_status: number }
      assert.equal(video.title, 'Chosen offline')
      assert.ok(video.cover_path)
      assert.equal(video.scraped_status, 1)
      assert.equal(fs.existsSync(path.join(tempRoot!, 'media_assets', video.cover_path)), true)
      for (const stagedPath of stagedPaths) {
        assert.equal(fs.existsSync(path.join(tempRoot!, 'media_assets', stagedPath)), false)
      }
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
    }
  })

  it('discards pending candidates, cleans staging, and preserves cumulative success', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Discard Pending Source',
      version: '1.0.0',
      description: 'Creates disposable candidates',
      supportedFields: ['title', 'cover'],
      code: `module.exports = { async parseVideo(ctx) {
        return [
          { code: ctx.code, title: 'Discard A', coverUrl: 'https://image.example/a.jpg' },
          { code: ctx.code, title: 'Discard B', coverUrl: 'https://image.example/b.jpg' }
        ];
      } };`
    })
    getDb().prepare("UPDATE videos SET scraped_status = 1, last_scraped_at = '2025-01-01' WHERE id = 1").run()
    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    scrapeBrowser.fetchBuffer = async () => MINIMAL_JPEG
    try {
      await scrapeVideo(1, 'Discard Pending Source', { fields: ['title'], closeBrowser: false })
      const pending = getPendingVideoScrapeForVideo(1)
      assert.ok(pending?.sources[0].candidates[0].stagedCoverPath)
      const stagedPath = pending.sources[0].candidates[0].stagedCoverPath!

      assert.equal(videoPendingScrapeService.discard(pending.id), true)

      assert.equal(getPendingVideoScrapeForVideo(1), null)
      assert.deepEqual(
        getDb().prepare('SELECT scraped_status, last_scraped_at FROM videos WHERE id = 1').get(),
        { scraped_status: 1, last_scraped_at: '2025-01-01' }
      )
      assert.equal(fs.existsSync(path.join(tempRoot!, 'media_assets', stagedPath)), false)
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
    }
  })

  it('replaces pending staging and removes the replacement after a later unique success', async () => {
    for (const [name, label] of [
      ['First Replaceable Pending Source', 'First'],
      ['Second Replaceable Pending Source', 'Second']
    ] as const) {
      await installScraperPluginPackage({
        schemaVersion: 1,
        kind: 'video',
        name,
        version: '1.0.0',
        description: `Creates the ${label.toLowerCase()} pending snapshot`,
        supportedFields: ['title', 'cover'],
        code: `module.exports = { async parseVideo(ctx) {
          return [1, 2].map((n) => ({
            code: ctx.code,
            title: '${label} ' + n,
            coverUrl: 'https://image.example/${label.toLowerCase()}-' + n + '.jpg'
          }));
        } };`
      })
    }
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Unique Replacement Source',
      version: '1.0.0',
      description: 'Supersedes a pending decision with a unique success',
      supportedFields: ['title'],
      code: `module.exports = { async parseVideo(ctx) {
        return { code: ctx.code, title: 'Final unique title' };
      } };`
    })
    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    scrapeBrowser.fetchBuffer = async () => MINIMAL_JPEG
    try {
      await scrapeVideo(1, 'First Replaceable Pending Source', {
        fields: ['title'],
        closeBrowser: false
      })
      const firstPending = getPendingVideoScrapeForVideo(1)
      assert.ok(firstPending)
      const firstPaths = firstPending.sources[0].candidates
        .map((candidate) => candidate.stagedCoverPath)
        .filter((value): value is string => Boolean(value))

      await scrapeVideo(1, 'Second Replaceable Pending Source', {
        fields: ['title'],
        closeBrowser: false
      })
      const secondPending = getPendingVideoScrapeForVideo(1)
      assert.ok(secondPending)
      const secondPaths = secondPending.sources[0].candidates
        .map((candidate) => candidate.stagedCoverPath)
        .filter((value): value is string => Boolean(value))
      assert.ok(firstPaths.every((storedPath) => !fs.existsSync(path.join(tempRoot!, 'media_assets', storedPath))))
      assert.ok(secondPaths.every((storedPath) => fs.existsSync(path.join(tempRoot!, 'media_assets', storedPath))))

      const unique = await scrapeVideo(1, 'Unique Replacement Source', {
        fields: ['title'],
        closeBrowser: false
      })

      assert.equal(unique.ok, true)
      assert.equal(unique.pending, undefined)
      assert.equal(getPendingVideoScrapeForVideo(1), null)
      assert.ok(secondPaths.every((storedPath) => !fs.existsSync(path.join(tempRoot!, 'media_assets', storedPath))))
      assert.equal(
        (getDb().prepare('SELECT title FROM videos WHERE id = 1').get() as { title: string }).title,
        'Final unique title'
      )
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
    }
  })

  it('startup cleanup removes only old unreferenced video staging directories', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Referenced Video Staging Source',
      version: '1.0.0',
      description: 'Creates a referenced staged cover',
      supportedFields: ['title', 'cover'],
      code: `module.exports = { async parseVideo(ctx) {
        return [
          { code: ctx.code, title: 'A', coverUrl: 'https://image.example/a.jpg' },
          { code: ctx.code, title: 'B', coverUrl: 'https://image.example/b.jpg' }
        ];
      } };`
    })
    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    scrapeBrowser.fetchBuffer = async () => MINIMAL_JPEG
    try {
      await scrapeVideo(1, 'Referenced Video Staging Source', {
        fields: ['title'],
        closeBrowser: false
      })
      const stagedPath = getPendingVideoScrapeForVideo(1)?.sources[0].candidates[0]
        .stagedCoverPath
      assert.ok(stagedPath)
      const referencedDirectory = path.dirname(
        path.join(tempRoot!, 'media_assets', stagedPath)
      )
      const stagingRoot = path.join(tempRoot!, 'media_assets', '.video_scrape_staging')
      const oldOrphan = path.join(stagingRoot, 'old-orphan')
      const recentOrphan = path.join(stagingRoot, 'recent-orphan')
      fs.mkdirSync(oldOrphan, { recursive: true })
      fs.mkdirSync(recentOrphan, { recursive: true })
      fs.writeFileSync(path.join(oldOrphan, 'cover-0.jpg'), MINIMAL_JPEG)
      fs.writeFileSync(path.join(recentOrphan, 'cover-0.jpg'), MINIMAL_JPEG)
      const now = Date.parse('2026-01-02T00:00:00.000Z')
      fs.utimesSync(
        oldOrphan,
        new Date(now - 48 * 60 * 60 * 1000),
        new Date(now - 48 * 60 * 60 * 1000)
      )
      fs.utimesSync(
        recentOrphan,
        new Date(now - 60 * 1000),
        new Date(now - 60 * 1000)
      )

      const removed = cleanupOrphanedVideoScrapeStaging({
        now,
        olderThanMs: 24 * 60 * 60 * 1000
      })

      assert.equal(removed, 1)
      assert.equal(fs.existsSync(oldOrphan), false)
      assert.equal(fs.existsSync(recentOrphan), true)
      assert.equal(fs.existsSync(referencedDirectory), true)
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
    }
  })

  it('filters exact-code mismatches and conservatively deduplicates normalized source urls', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Candidate Filter Source',
      version: '1.0.0',
      description: 'Returns mismatches and source duplicates',
      supportedFields: ['title', 'source'],
      code: `module.exports = { async parseVideo(ctx) {
        return [
          { code: 'OTHER-001', title: 'Mismatch', sourceUrl: 'https://bad.example/item' },
          { code: ctx.code, title: 'First', sourceUrl: 'HTTPS://EXAMPLE.COM:443/item#fragment' },
          { code: ctx.code, title: 'Duplicate', sourceUrl: 'https://example.com/item' },
          { code: ctx.code, title: 'Root without slash', sourceUrl: 'https://root.example' },
          { code: ctx.code, title: 'Root with slash', sourceUrl: 'https://root.example/' },
          { code: ctx.code, title: 'No URL A' },
          { code: ctx.code, title: 'No URL B' }
        ];
      } };`
    })

    const outcome = await scrapeVideo(1, 'Candidate Filter Source', {
      fields: ['title', 'source'],
      mode: 'replace',
      closeBrowser: false
    })

    assert.equal(outcome.pending, true)
    assert.match(outcome.warnings?.[0] ?? '', /OTHER-001/)
    assert.deepEqual(
      getPendingVideoScrapeForVideo(1)?.sources[0].candidates.map(
        (candidate) => candidate.result.title
      ),
      ['First', 'Root without slash', 'Root with slash', 'No URL A', 'No URL B']
    )
  })

  it('rejects an invalid candidate array atomically and preserves an older pending decision', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Initial Pending Source',
      version: '1.0.0',
      description: 'Creates the initial pending result',
      supportedFields: ['title'],
      code: `module.exports = { async parseVideo(ctx) {
        return [{ code: ctx.code, title: 'Old A' }, { code: ctx.code, title: 'Old B' }];
      } };`
    })
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Invalid Candidate Source',
      version: '1.0.0',
      description: 'Returns one structurally invalid candidate',
      supportedFields: ['title'],
      code: `module.exports = { async parseVideo(ctx) {
        return [{ code: ctx.code, title: 'New' }, 42];
      } };`
    })

    const first = await scrapeVideo(1, 'Initial Pending Source', {
      fields: ['title'],
      closeBrowser: false
    })
    const oldPending = getPendingVideoScrapeForVideo(1)
    const failed = await scrapeVideo(1, 'Invalid Candidate Source', {
      fields: ['title'],
      closeBrowser: false
    })

    assert.equal(first.pending, true)
    assert.equal(failed.ok, false)
    assert.match(failed.error ?? '', /candidate entries must be objects/)
    assert.equal(getPendingVideoScrapeForVideo(1)?.revision, oldPending?.revision)
    assert.deepEqual(
      getPendingVideoScrapeForVideo(1)?.sources[0].candidates.map(
        (candidate) => candidate.result.title
      ),
      ['Old A', 'Old B']
    )
  })

  it('keeps the old pending snapshot and staging when a valid replacement fails mid-transaction', async () => {
    for (const [name, label] of [
      ['Atomic Old Pending Source', 'Old'],
      ['Atomic New Pending Source', 'New']
    ] as const) {
      await installScraperPluginPackage({
        schemaVersion: 1,
        kind: 'video',
        name,
        version: '1.0.0',
        description: `${label} pending snapshot`,
        supportedFields: ['title', 'cover'],
        code: `module.exports = { async parseVideo(ctx) {
          return [1, 2].map((n) => ({
            code: ctx.code,
            title: '${label} ' + n,
            coverUrl: 'https://image.example/${label.toLowerCase()}-' + n + '.jpg'
          }));
        } };`
      })
    }
    const originalFetchBuffer = scrapeBrowser.fetchBuffer
    scrapeBrowser.fetchBuffer = async () => MINIMAL_JPEG
    try {
      await scrapeVideo(1, 'Atomic Old Pending Source', {
        fields: ['title'],
        closeBrowser: false
      })
      const oldPending = getPendingVideoScrapeForVideo(1)
      assert.ok(oldPending)
      const oldPaths = oldPending.sources[0].candidates
        .map((candidate) => candidate.stagedCoverPath)
        .filter((value): value is string => Boolean(value))
      getDb().exec(`
        CREATE TRIGGER fail_pending_replacement
        BEFORE DELETE ON pending_video_scrapes
        BEGIN
          SELECT RAISE(ABORT, 'forced pending replacement failure');
        END;
      `)

      const outcome = await scrapeVideo(1, 'Atomic New Pending Source', {
        fields: ['title'],
        closeBrowser: false
      })

      assert.equal(outcome.ok, false)
      assert.match(outcome.error ?? '', /forced pending replacement failure/)
      const preserved = getPendingVideoScrapeForVideo(1)
      assert.equal(preserved?.id, oldPending.id)
      assert.equal(preserved?.revision, oldPending.revision)
      assert.deepEqual(
        preserved?.sources[0].candidates.map((candidate) => candidate.result.title),
        ['Old 1', 'Old 2']
      )
      assert.ok(
        oldPaths.every((storedPath) =>
          fs.existsSync(path.join(tempRoot!, 'media_assets', storedPath))
        )
      )
      assert.throws(
        () => videoPendingScrapeService.discard(oldPending.id),
        /forced pending replacement failure/
      )
      assert.equal(getPendingVideoScrapeForVideo(1)?.id, oldPending.id)
      assert.ok(
        oldPaths.every((storedPath) =>
          fs.existsSync(path.join(tempRoot!, 'media_assets', storedPath))
        )
      )
    } finally {
      scrapeBrowser.fetchBuffer = originalFetchBuffer
    }
  })

  it('returns every exact-code exclusion warning when no candidate remains', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'All Mismatched Candidate Source',
      version: '1.0.0',
      description: 'Returns only candidates for other videos',
      supportedFields: ['title'],
      code: `module.exports = { async parseVideo() {
        return [
          { code: 'OTHER-001', title: 'Wrong one' },
          { code: 'OTHER-002', title: 'Wrong two' }
        ];
      } };`
    })

    const outcome = await scrapeVideo(1, 'All Mismatched Candidate Source', {
      fields: ['title'],
      closeBrowser: false
    })

    assert.equal(outcome.ok, false)
    assert.equal(outcome.error, '未找到匹配的元数据')
    assert.equal(outcome.warnings?.length, 2)
    assert.match(outcome.warnings?.[0] ?? '', /OTHER-001/)
    assert.match(outcome.warnings?.[1] ?? '', /OTHER-002/)
    assert.equal(getPendingVideoScrapeForVideo(1), null)
    assert.equal(
      (getDb().prepare('SELECT scraped_status FROM videos WHERE id = 1').get() as {
        scraped_status: number
      }).scraped_status,
      2
    )
  })

  it('applies the only exact candidate after exclusions without creating pending state', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'One Exact Candidate Source',
      version: '1.0.0',
      description: 'Leaves one exact candidate after filtering',
      supportedFields: ['title'],
      code: `module.exports = { async parseVideo(ctx) {
        return [
          { code: 'TEST-001-EXTRA', title: 'Wrong' },
          { code: ctx.code, title: 'Exact' }
        ];
      } };`
    })

    const outcome = await scrapeVideo(1, 'One Exact Candidate Source', {
      fields: ['title'],
      mode: 'replaceIfPresent',
      closeBrowser: false
    })

    assert.equal(outcome.ok, true)
    assert.equal(outcome.pending, undefined)
    assert.equal(getPendingVideoScrapeForVideo(1), null)
    assert.equal(
      (getDb().prepare('SELECT title FROM videos WHERE id = 1').get() as { title: string }).title,
      'Exact'
    )
    assert.match(outcome.warnings?.[0] ?? '', /TEST-001-EXTRA/)
  })

  it('normalizes a year-month release date to the first day of that month', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Month Precision Source',
      version: '1.0.0',
      description: 'Returns the existing year-month date shape',
      supportedFields: ['releaseDate'],
      code: `module.exports = { async parseVideo(ctx) {
        return { code: ctx.code, releaseDate: '2026-05' };
      } };`
    })

    const outcome = await scrapeVideo(1, 'Month Precision Source', {
      fields: ['releaseDate'],
      closeBrowser: false
    })

    assert.equal(outcome.ok, true, outcome.error)
    assert.equal(
      (getDb().prepare('SELECT release_date FROM videos WHERE id = 1').get() as {
        release_date: string
      }).release_date,
      '2026-05-01'
    )
  })

  it('keeps a unique candidate pending when applying it would duplicate a business identity', async () => {
    insertTestVideoWithFile(getDb(), {
      code: 'TEST-001',
      filePath: 'conflicting.mp4',
      publisher: 'Conflict Publisher',
      releaseDate: '2026-02-03'
    })
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Identity Conflict Source',
      version: '1.0.0',
      description: 'Returns one candidate with an existing business identity',
      supportedFields: ['title', 'publisher', 'releaseDate'],
      code: `module.exports = { async parseVideo(ctx) {
        return {
          code: ctx.code,
          title: 'Conflicting candidate',
          publisher: 'Conflict Publisher',
          releaseDate: '2026-02-03'
        };
      } };`
    })

    const outcome = await scrapeVideo(1, 'Identity Conflict Source', {
      fields: ['title', 'publisher', 'releaseDate'],
      mode: 'replaceIfPresent',
      closeBrowser: false
    })

    assert.equal(outcome.pending, true)
    assert.match(outcome.warnings?.join('；') ?? '', /影片 ID 2/)
    assert.equal(getPendingVideoScrapeForVideo(1)?.sources[0].candidates.length, 1)
    assert.deepEqual(
      getDb().prepare('SELECT title, publisher_organization_id, release_date FROM videos WHERE id = 1').get(),
      { title: null, publisher_organization_id: null, release_date: null }
    )
    const pending = getPendingVideoScrapeForVideo(1)!
    const resolution = videoPendingScrapeService.confirm({
      pendingScrapeId: pending.id,
      selections: [{ sourceId: pending.sources[0].id, candidateId: pending.sources[0].candidates[0].id }]
    })
    assert.deepEqual(
      { status: resolution.status, conflictVideoId: resolution.conflictVideoId },
      { status: 'merge-required', conflictVideoId: 2 }
    )
    assert.ok(getPendingVideoScrapeForVideo(1))

    const merged = videoPendingScrapeService.confirm({
      pendingScrapeId: pending.id,
      selections: [{ sourceId: pending.sources[0].id, candidateId: pending.sources[0].candidates[0].id }],
      mergeRetainedVideoId: 1
    })
    assert.equal(merged.status, 'applied')
    assert.equal(getPendingVideoScrapeForVideo(1), null)
    assert.equal(getDb().prepare('SELECT 1 FROM videos WHERE id = 2').get(), undefined)
    assert.deepEqual(
      getDb().prepare(
        'SELECT title, publisher_organization_id, release_date, scraped_status FROM videos WHERE id = 1'
      ).get(),
      { title: 'Conflicting candidate', publisher_organization_id: 1, release_date: '2026-02-03', scraped_status: 1 }
    )
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS c FROM video_resources WHERE video_id = 1').get() as { c: number }).c,
      2
    )
  })

  it('rolls back a conflict merge and candidate apply when pending deletion fails', async () => {
    insertTestVideoWithFile(getDb(), {
      code: 'TEST-001',
      filePath: 'rollback-conflict.mp4',
      publisher: 'Rollback Publisher',
      releaseDate: '2026-03-04'
    })
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Rollback Identity Conflict Source',
      version: '1.0.0',
      description: 'Creates a merge-required pending result',
      supportedFields: ['title', 'publisher', 'releaseDate'],
      code: `module.exports = { async parseVideo(ctx) {
        return {
          code: ctx.code,
          title: 'Must roll back',
          publisher: 'Rollback Publisher',
          releaseDate: '2026-03-04'
        };
      } };`
    })

    const outcome = await scrapeVideo(1, 'Rollback Identity Conflict Source', {
      fields: ['title', 'publisher', 'releaseDate'],
      mode: 'replaceIfPresent',
      closeBrowser: false
    })
    assert.equal(outcome.pending, true)
    const pending = getPendingVideoScrapeForVideo(1)
    assert.ok(pending)
    getDb().exec(`
      CREATE TRIGGER fail_pending_video_scrape_delete
      BEFORE DELETE ON pending_video_scrapes
      BEGIN
        SELECT RAISE(ABORT, 'forced pending delete failure');
      END;
    `)

    assert.throws(
      () =>
        videoPendingScrapeService.confirm({
          pendingScrapeId: pending.id,
          selections: [
            {
              sourceId: pending.sources[0].id,
              candidateId: pending.sources[0].candidates[0].id
            }
          ],
          mergeRetainedVideoId: 1
        }),
      /forced pending delete failure/
    )

    assert.deepEqual(
      getDb()
        .prepare(
          'SELECT title, publisher_organization_id, release_date, scraped_status FROM videos WHERE id = 1'
        )
        .get(),
      { title: null, publisher_organization_id: null, release_date: null, scraped_status: 0 }
    )
    assert.ok(getDb().prepare('SELECT 1 FROM videos WHERE id = 2').get())
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS c FROM video_resources WHERE video_id = 1').get() as {
        c: number
      }).c,
      1
    )
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS c FROM video_resources WHERE video_id = 2').get() as {
        c: number
      }).c,
      1
    )
    assert.equal(getPendingVideoScrapeForVideo(1)?.id, pending.id)
  })

  it('returns director candidates before writes and applies an explicit choice on retry', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Ambiguous Director Source',
      version: '1.0.0',
      description: 'Returns a title and an ambiguous director',
      supportedFields: ['title', 'director'],
      code: `module.exports = { async parseVideo(ctx) {
        return { code: ctx.code, title: 'Chosen title', director: 'Duplicate Director' };
      } };`
    })
    const firstId = classificationMaintenanceService.createDirector({
      mainName: 'Duplicate Director',
      countryRegion: 'JP'
    })
    const secondId = classificationMaintenanceService.createDirector({
      mainName: 'Ｄｕｐｌｉｃａｔｅ　Ｄｉｒｅｃｔｏｒ',
      countryRegion: 'US'
    })

    const pending = await scrapeVideo(1, 'Ambiguous Director Source', {
      fields: ['title', 'director'],
      mode: 'replaceIfPresent',
      directorAmbiguity: 'choice',
      closeBrowser: false
    })

    assert.equal(pending.ok, true)
    assert.equal(pending.skipped, true)
    assert.deepEqual(
      pending.directorChoice?.candidates.map((candidate) => candidate.id),
      [firstId, secondId]
    )
    assert.deepEqual(
      getDb().prepare('SELECT title, director_id, scraped_status FROM videos WHERE id = 1').get(),
      { title: null, director_id: null, scraped_status: 0 }
    )

    const applied = await scrapeVideo(1, 'Ambiguous Director Source', {
      fields: ['title', 'director'],
      mode: 'replaceIfPresent',
      directorAmbiguity: 'choice',
      directorSelectionId: secondId,
      closeBrowser: false
    })

    assert.equal(applied.ok, true)
    assert.equal(applied.skipped, false)
    assert.deepEqual(
      getDb().prepare('SELECT title, director_id, scraped_status FROM videos WHERE id = 1').get(),
      { title: 'Chosen title', director_id: secondId, scraped_status: 1 }
    )
  })

  it('keeps an ambiguous director during batch-style scraping and applies safe fields', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Batch Director Source',
      version: '1.0.0',
      description: 'Returns a safe title and an ambiguous director',
      supportedFields: ['title', 'director'],
      code: `module.exports = { async parseVideo(ctx) {
        return { code: ctx.code, title: 'Batch safe title', director: 'Batch Duplicate' };
      } };`
    })
    classificationMaintenanceService.createDirector({ mainName: 'Batch Duplicate' })
    classificationMaintenanceService.createDirector({ mainName: 'Ｂａｔｃｈ　Ｄｕｐｌｉｃａｔｅ' })

    const outcome = await scrapeVideo(1, 'Batch Director Source', {
      fields: ['title', 'director'],
      mode: 'replaceIfPresent',
      closeBrowser: false
    })

    assert.equal(outcome.ok, true)
    assert.equal(outcome.skipped, false)
    assert.equal(outcome.classifications?.[0]?.status, 'ambiguous')
    assert.match(outcome.warnings?.[0] ?? '', /手动选择或合并重复导演/)
    assert.deepEqual(
      getDb().prepare('SELECT title, director_id, scraped_status FROM videos WHERE id = 1').get(),
      { title: 'Batch safe title', director_id: null, scraped_status: 1 }
    )
  })

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
      getDb().prepare('SELECT source, url FROM video_sources WHERE video_id = 1').all(),
      [{ source: 'Link Field Source', url: 'https://link.example/TEST-001' }]
    )
    assert.deepEqual(
      getDb()
        .prepare('SELECT source, rating_average, rating_count FROM video_external_stats WHERE video_id = 1')
        .all(),
      [{ source: 'Rating Field Source', rating_average: 4.5, rating_count: 10 }]
    )
  })

  it('persists and confirms composite candidates independently per source', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Ambiguous Composite Title',
      version: '1.0.0',
      supportedFields: ['title', 'summary'],
      code: `module.exports = { async parseVideo(ctx) { return [
        { code: ctx.code, title: 'Title A', summary: 'Must not leak A' },
        { code: ctx.code, title: 'Title B', summary: 'Must not leak B' }
      ]; } };`
    })
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Unique Composite Summary',
      version: '1.0.0',
      supportedFields: ['title', 'summary'],
      code: `module.exports = { async parseVideo(ctx) {
        return { code: ctx.code, title: 'Must not leak unique', summary: 'Summary source' };
      } };`
    })
    createCompositeScraper('video', {
      name: 'Independent Candidate Composite',
      fieldPluginMap: {
        title: 'Ambiguous Composite Title',
        summary: 'Unique Composite Summary'
      }
    })

    const outcome = await scrapeVideo(1, 'Independent Candidate Composite', {
      fields: ['title', 'summary'],
      mode: 'replace',
      closeBrowser: false
    })

    assert.equal(outcome.pending, true)
    const pending = getPendingVideoScrapeForVideo(1)
    assert.ok(pending)
    assert.equal(pending.sources.length, 2)
    assert.deepEqual(
      pending.sources.map((source) => ({
        pluginName: source.pluginName,
        selectedFields: source.selectedFields,
        candidateCount: source.candidates.length,
        selectedCandidateId: source.selectedCandidateId
      })),
      [
        {
          pluginName: 'Ambiguous Composite Title',
          selectedFields: ['title'],
          candidateCount: 2,
          selectedCandidateId: null
        },
        {
          pluginName: 'Unique Composite Summary',
          selectedFields: ['summary'],
          candidateCount: 1,
          selectedCandidateId: null
        }
      ]
    )

    const result = videoPendingScrapeService.confirm({
      pendingScrapeId: pending.id,
      selections: pending.sources.map((source) => ({
        sourceId: source.id,
        candidateId:
          source.pluginName === 'Ambiguous Composite Title'
            ? source.candidates[1].id
            : source.candidates[0].id
      }))
    })

    assert.equal(result.status, 'applied')
    assert.deepEqual(
      getDb().prepare('SELECT title, summary FROM videos WHERE id = 1').get(),
      { title: 'Title B', summary: 'Summary source' }
    )
  })

  it('ignores unsupported fields before validating and applying the selected plugin result', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Title Only Source',
      version: '1.0.0',
      description: 'Returns a title plus an undeclared malformed field',
      supportedFields: ['title'],
      code: `module.exports = { async parseVideo(ctx) {
        return { code: ctx.code, title: 'Supported title', sampleImageUrls: 'not-an-array' };
      } };`
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

  it('still rejects a malformed field when the plugin declares it as supported', async () => {
    await installScraperPluginPackage({
      schemaVersion: 1,
      kind: 'video',
      name: 'Declared Invalid Samples Source',
      version: '1.0.0',
      description: 'Declares and returns malformed samples',
      supportedFields: ['title', 'samples'],
      code: `module.exports = { async parseVideo(ctx) {
        return { code: ctx.code, title: 'Do not apply', sampleImageUrls: 'not-an-array' };
      } };`
    })

    const outcome = await scrapeVideo(1, 'Declared Invalid Samples Source', {
      fields: ['title'],
      closeBrowser: false
    })

    assert.equal(outcome.ok, false)
    assert.match(outcome.error ?? '', /sampleImageUrls must be an array/)
    assert.equal(
      (getDb().prepare('SELECT title FROM videos WHERE id = 1').get() as { title: string | null }).title,
      null
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
      "INSERT INTO video_sources (video_id, source, url, fetched_at) VALUES (1, 'No Match Link Source', 'https://keep.example', '2024-01-01')"
    ).run()

    const outcome = await scrapeVideo(1, 'Partial Match Composite', {
      fields: ['source', 'title'],
      mode: 'replace',
      closeBrowser: false
    })

    assert.equal(outcome.ok, true)
    assert.deepEqual(
      getDb().prepare('SELECT source, url FROM video_sources WHERE video_id = 1').all(),
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
