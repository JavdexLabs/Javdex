import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { createVideoQueryService } from './videoQueryService'

let tempRoot: string | null = null

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function setupDb(): { videoPath: string; imagePath: string } {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-video-query-'))
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

describe('VideoQueryService', () => {
  it('lists videos and reads their detail without mutating library state', () => {
    const { videoPath, imagePath } = setupDb()
    const videos = createVideoQueryService()
    const db = getDb()
    const rowsBefore = db.prepare('SELECT * FROM videos WHERE id = 1').all()
    const resourcesBefore = db
      .prepare('SELECT * FROM video_resources WHERE video_id = 1 ORDER BY id')
      .all()
    const changesBefore = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const videoBefore = fs.readFileSync(videoPath)
    const imageBefore = fs.readFileSync(imagePath)
    const videoModifiedBefore = fs.statSync(videoPath).mtimeMs
    const imageModifiedBefore = fs.statSync(imagePath).mtimeMs

    assert.deepEqual(videos.list({ search: 'APP-001' }).items.map((item) => item.code), [
      'APP-001'
    ])
    const detail = videos.get(1)
    assert.equal(detail?.title, 'Application boundary')
    assert.equal(detail?.resources.length, 1)
    assert.equal(detail?.resources[0]?.kind, 'local')
    assert.equal(detail ? 'files' in detail : true, false)
    assert.deepEqual(db.prepare('SELECT * FROM videos WHERE id = 1').all(), rowsBefore)
    assert.deepEqual(
      db.prepare('SELECT * FROM video_resources WHERE video_id = 1 ORDER BY id').all(),
      resourcesBefore
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
})
