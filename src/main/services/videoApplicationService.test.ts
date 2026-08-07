import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { createVideoApplicationService } from './videoApplicationService'

let tempRoot: string | null = null

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function setupDb(): { videoPath: string; imagePath: string } {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-video-application-'))
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

afterEach(() => {
  closeDatabase()
  delete process.env.JAVDEX_TEST_USER_DATA
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('VideoApplicationService', () => {
  it('lists videos and reads their detail through one application interface', () => {
    const { videoPath, imagePath } = setupDb()
    const videos = createVideoApplicationService()
    const db = getDb()
    const rowsBefore = db
      .prepare('SELECT * FROM videos WHERE id = 1')
      .all()
    const filesBefore = db
      .prepare('SELECT * FROM video_files WHERE video_id = 1 ORDER BY id')
      .all()
    const changesBefore = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const videoBefore = fs.readFileSync(videoPath)
    const imageBefore = fs.readFileSync(imagePath)
    const videoModifiedBefore = fs.statSync(videoPath).mtimeMs
    const imageModifiedBefore = fs.statSync(imagePath).mtimeMs

    assert.deepEqual(videos.list({ search: 'APP-001' }).items.map((item) => item.code), [
      'APP-001'
    ])
    assert.equal(videos.get(1)?.title, 'Application boundary')
    assert.deepEqual(db.prepare('SELECT * FROM videos WHERE id = 1').all(), rowsBefore)
    assert.deepEqual(
      db.prepare('SELECT * FROM video_files WHERE video_id = 1 ORDER BY id').all(),
      filesBefore
    )
    assert.equal(
      (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n,
      changesBefore
    )
    assert.deepEqual(fs.readFileSync(videoPath), videoBefore)
    assert.deepEqual(fs.readFileSync(imagePath), imageBefore)
    assert.equal(fs.statSync(videoPath).mtimeMs, videoModifiedBefore)
    assert.equal(fs.statSync(imagePath).mtimeMs, imageModifiedBefore)
  })

  it('edits metadata, status, rating, poster, and manual tags through the application interface', () => {
    setupDb()
    const videos = createVideoApplicationService()

    videos.edit(1, { title: 'Edited', tags: ['scraped-tag'] })
    videos.setRating(1, 5)
    videos.addManualTag(1, 'manual-tag')
    videos.markScrapeSucceeded(1)

    const detail = videos.get(1)
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
    assert.deepEqual(videos.get(1)?.tags.map((tag) => tag.name), ['scraped-tag'])
  })

  it('imports and deletes a local sample in the temporary media directory', async () => {
    const { imagePath } = setupDb()
    const videos = createVideoApplicationService()

    const sample = await videos.importSample(1, { source: 'file', sourcePath: imagePath })
    assert.ok(sample.local_path)
    assert.equal(fs.existsSync(path.join(tempRoot!, 'media_assets', sample.local_path)), true)

    videos.setPoster(1, sample.local_path)
    videos.deleteSample(1, sample.id)
    assert.equal(fs.existsSync(path.join(tempRoot!, 'media_assets', sample.local_path)), false)
    assert.equal(videos.get(1)?.poster_path, null)
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
    const videos = createVideoApplicationService()

    videos.setPrimaryFile(1, secondaryId)
    videos.deleteFile(1, 1)
    assert.equal(fs.existsSync(videoPath), false)
    assert.equal(videos.get(1)?.files[0]?.file_path, secondaryPath)

    videos.delete(1)
    assert.equal(fs.existsSync(secondaryPath), false)
    assert.equal(videos.get(1), null)
  })

  it('deletes a symbolic link without deleting its target file', () => {
    const { videoPath } = setupDb()
    const targetPath = path.join(tempRoot!, 'target.mp4')
    const linkPath = path.join(tempRoot!, 'linked.mp4')
    fs.writeFileSync(targetPath, 'target')
    fs.symlinkSync(targetPath, linkPath, 'file')
    getDb().prepare('UPDATE video_files SET file_path = ? WHERE id = 1').run(linkPath)
    const videos = createVideoApplicationService()

    videos.delete(1)

    assert.equal(fs.existsSync(linkPath), false)
    assert.equal(fs.existsSync(targetPath), true)
    assert.equal(fs.existsSync(videoPath), true)
  })

  it('corrects an imported code through the application interface', () => {
    setupDb()
    const videos = createVideoApplicationService()

    assert.deepEqual(videos.correctImport(1, 'APP-002'), {
      code: 'APP-002',
      previousCode: 'APP-001'
    })
    assert.equal(videos.get(1)?.code, 'APP-002')
  })
})
