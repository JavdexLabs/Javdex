import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { createVideoMaintenanceService } from './videoMaintenanceService'
import { createVideoQueryService } from './videoQueryService'

let tempRoot: string | null = null

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function setupDb(prefix = 'javdex-video-maintenance-'): { videoPath: string; imagePath: string } {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  const videoPath = path.join(tempRoot, 'APP-001.mp4')
  const imagePath = path.join(tempRoot, 'image.png')
  fs.writeFileSync(videoPath, 'video')
  fs.writeFileSync(imagePath, PNG_1X1)
  const db = initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  insertTestVideoWithFile(db, {
    code: 'APP-001',
    filePath: videoPath,
    title: 'Application boundary',
    scrapedStatus: 1
  })
  return { videoPath, imagePath }
}

function setupPolicyDb(): { root: string; videoPath: string } {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-video-maintenance-policy-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  const videoPath = path.join(tempRoot, 'IPX-535.mp4')
  fs.writeFileSync(videoPath, 'video')
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const db = getDb()
  insertTestVideoWithFile(db, {
    code: 'IPX-535',
    filePath: videoPath,
    title: 'Title',
    summary: 'Summary',
    rating: 4,
    releaseDate: '2024-01-01',
    maker: 'Maker',
    series: 'Series',
    director: 'Director',
    scrapedStatus: 1
  })
  return { root: tempRoot, videoPath }
}

afterEach(() => {
  closeDatabase()
  delete process.env.JAVDEX_TEST_USER_DATA
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('VideoMaintenanceService', () => {
  it('edits metadata, status, rating, poster, and manual tags', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    const query = createVideoQueryService()

    videos.edit(1, { title: 'Edited', tags: ['scraped-tag'] })
    videos.setRating(1, 5)
    videos.addManualTag(1, 'manual-tag')
    videos.markScrapeSucceeded(1)

    const detail = query.get(1)
    assert.equal(detail?.title, 'Edited')
    assert.equal(detail?.rating, 5)
    assert.deepEqual(detail?.tags.map((tag) => [tag.name, tag.origin]), [
      ['scraped-tag', 'scraped'],
      ['manual-tag', 'manual']
    ])
    assert.equal(detail?.scraped_status, 1)

    const manualTag = detail?.tags.find((tag) => tag.name === 'manual-tag')
    assert.ok(manualTag)
    videos.removeManualTag(1, manualTag.id)
    assert.deepEqual(query.get(1)?.tags.map((tag) => tag.name), ['scraped-tag'])
  })

  it('imports and deletes a local sample in the temporary media directory', async () => {
    const { imagePath } = setupDb()
    const videos = createVideoMaintenanceService()
    const query = createVideoQueryService()

    const sample = await videos.importSample(1, { source: 'file', sourcePath: imagePath })
    assert.ok(sample.local_path)
    assert.equal(fs.existsSync(path.join(tempRoot!, 'media_assets', sample.local_path)), true)

    videos.setPoster(1, sample.local_path)
    videos.deleteSample(1, sample.id)
    assert.equal(fs.existsSync(path.join(tempRoot!, 'media_assets', sample.local_path)), false)
    assert.equal(query.get(1)?.poster_path, null)
  })

  it('switches the primary file, deletes a secondary source, then deletes the video', () => {
    const { videoPath } = setupDb()
    const secondaryPath = path.join(tempRoot!, 'APP-001-CD2.mp4')
    fs.writeFileSync(secondaryPath, 'video 2')
    const fileInfo = getDb()
      .prepare(
        `INSERT INTO video_files (video_id, file_path, is_primary)
         VALUES (1, ?, 0)`
      )
      .run(secondaryPath)
    const secondaryId = Number(fileInfo.lastInsertRowid)
    const videos = createVideoMaintenanceService()
    const query = createVideoQueryService()

    videos.setPrimaryFile(1, secondaryId)
    videos.deleteFile(1, 1)
    assert.equal(fs.existsSync(videoPath), false)
    assert.equal(query.get(1)?.files[0]?.file_path, secondaryPath)

    videos.delete(1)
    assert.equal(fs.existsSync(secondaryPath), false)
    assert.equal(query.get(1), null)
  })

  it('deletes a symbolic link without deleting its target file', () => {
    const { videoPath } = setupDb()
    const targetPath = path.join(tempRoot!, 'target.mp4')
    const linkPath = path.join(tempRoot!, 'linked.mp4')
    fs.writeFileSync(targetPath, 'target')
    fs.symlinkSync(targetPath, linkPath, 'file')
    getDb().prepare('UPDATE video_files SET file_path = ? WHERE id = 1').run(linkPath)
    const videos = createVideoMaintenanceService()

    videos.delete(1)

    assert.equal(fs.existsSync(linkPath), false)
    assert.equal(fs.existsSync(targetPath), true)
    assert.equal(fs.existsSync(videoPath), true)
  })

  it('corrects an imported code', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    const query = createVideoQueryService()

    assert.deepEqual(videos.correctImport(1, 'APP-002'), {
      code: 'APP-002',
      previousCode: 'APP-001'
    })
    assert.equal(query.get(1)?.code, 'APP-002')
  })

  it('deletes the source file and database row', () => {
    const { videoPath } = setupPolicyDb()
    const videos = createVideoMaintenanceService()

    videos.delete(1)

    assert.equal(fs.existsSync(videoPath), false)
    assert.equal((getDb().prepare('SELECT COUNT(*) AS c FROM videos').get() as { c: number }).c, 0)
    assert.equal((getDb().prepare('SELECT COUNT(*) AS c FROM video_files').get() as { c: number }).c, 0)
  })

  it('clears scraped metadata and relations but keeps manual tags', () => {
    setupPolicyDb()
    const db = getDb()
    db.prepare('INSERT INTO tags (name) VALUES (?)').run('Drama')
    db.prepare('INSERT INTO tags (name) VALUES (?)').run('收藏')
    db.prepare(
      `INSERT INTO video_tag (video_id, tag_id, origin) VALUES (1, 1, 'scraped')`
    ).run()
    db.prepare(
      `INSERT INTO video_tag (video_id, tag_id, origin) VALUES (1, 2, 'manual')`
    ).run()
    db.prepare(
      `INSERT INTO video_external_stats (video_id, source, rating_average, rating_count)
       VALUES (1, 'JavLibrary', 3.5, 100)`
    ).run()
    const videos = createVideoMaintenanceService()

    videos.clearMetadata(1)

    const row = db.prepare('SELECT title, summary, maker, scraped_status FROM videos WHERE id = 1').get() as {
      title: string | null
      summary: string | null
      maker: string | null
      scraped_status: number
    }
    assert.deepEqual(row, { title: null, summary: null, maker: null, scraped_status: 0 })
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM video_tag').get() as { c: number }).c, 1)
    const kept = db.prepare('SELECT t.name FROM tags t JOIN video_tag vt ON vt.tag_id = t.id').get() as {
      name: string
    }
    assert.equal(kept.name, '收藏')
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM video_external_stats WHERE video_id = 1').get() as { c: number })
        .c,
      0
    )
  })

  it('merges into an existing code when the existing file is missing', () => {
    const { videoPath } = setupPolicyDb()
    const db = getDb()
    const missingPath = path.join(tempRoot!, 'missing.mp4')
    insertTestVideoWithFile(db, {
      code: 'MUKD-501',
      filePath: missingPath,
      scrapedStatus: 0
    })
    const videos = createVideoMaintenanceService()

    const result = videos.correctImport(1, 'MUKD-501')

    assert.equal(result.mergedIntoId, 2)
    const videosRows = db.prepare('SELECT id, code FROM videos ORDER BY id').all() as Array<{
      id: number
      code: string
    }>
    assert.deepEqual(videosRows, [{ id: 2, code: 'MUKD-501' }])
    const files = db
      .prepare('SELECT video_id, file_path FROM video_files ORDER BY id')
      .all() as Array<{ video_id: number; file_path: string }>
    assert.deepEqual(files, [{ video_id: 2, file_path: videoPath }])
  })
})
