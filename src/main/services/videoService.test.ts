import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { clearVideoMetadata, correctVideoCode, deleteVideoWithFile } from './videoService'

let tempRoot: string | null = null

function setupDb(): { root: string; videoPath: string } {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-video-service-'))
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
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('videoService', () => {
  it('deletes the source file and database row', () => {
    const { videoPath } = setupDb()

    deleteVideoWithFile(1)

    assert.equal(fs.existsSync(videoPath), false)
    assert.equal((getDb().prepare('SELECT COUNT(*) AS c FROM videos').get() as { c: number }).c, 0)
    assert.equal((getDb().prepare('SELECT COUNT(*) AS c FROM video_files').get() as { c: number }).c, 0)
  })

  it('clears scraped metadata and relations but keeps manual tags', () => {
    setupDb()
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

    clearVideoMetadata(1)

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
    const { videoPath } = setupDb()
    const db = getDb()
    const missingPath = path.join(tempRoot!, 'missing.mp4')
    insertTestVideoWithFile(db, {
      code: 'MUKD-501',
      filePath: missingPath,
      scrapedStatus: 0
    })

    const result = correctVideoCode(1, 'MUKD-501')

    assert.equal(result.mergedIntoId, 2)
    const videos = db.prepare('SELECT id, code FROM videos ORDER BY id').all() as Array<{
      id: number
      code: string
    }>
    assert.deepEqual(videos, [{ id: 2, code: 'MUKD-501' }])
    const files = db
      .prepare('SELECT video_id, file_path FROM video_files ORDER BY id')
      .all() as Array<{ video_id: number; file_path: string }>
    assert.deepEqual(files, [{ video_id: 2, file_path: videoPath }])
  })
})
