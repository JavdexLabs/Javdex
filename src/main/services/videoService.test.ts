import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { clearVideoMetadata, correctVideoCode, deleteVideoWithFile } from './videoService'

let tempRoot: string | null = null

function setupDb(): { root: string; videoPath: string } {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-video-service-'))
  const videoPath = path.join(tempRoot, 'IPX-535.mp4')
  fs.writeFileSync(videoPath, 'video')
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const db = getDb()
  db.prepare(
    `INSERT INTO videos (code, title, summary, file_path, rating, release_date, maker, series, director, scraped_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('IPX-535', 'Title', 'Summary', videoPath, 4, '2024-01-01', 'Maker', 'Series', 'Director', 1)
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
  })

  it('merges into an existing code when the existing file is missing', () => {
    const { videoPath } = setupDb()
    const db = getDb()
    const missingPath = path.join(tempRoot!, 'missing.mp4')
    db.prepare('INSERT INTO videos (code, file_path, scraped_status) VALUES (?, ?, 0)').run(
      'MUKD-501',
      missingPath
    )

    const result = correctVideoCode(1, 'MUKD-501')

    assert.equal(result.mergedIntoId, 2)
    const rows = db.prepare('SELECT id, code, file_path FROM videos ORDER BY id').all() as Array<{
      id: number
      code: string
      file_path: string
    }>
    assert.deepEqual(rows, [{ id: 2, code: 'MUKD-501', file_path: videoPath }])
  })
})
