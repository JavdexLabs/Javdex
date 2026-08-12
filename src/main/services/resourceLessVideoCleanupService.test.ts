import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { deleteResourceLessVideos } from './resourceLessVideoCleanupService'

let tempRoot = ''
let previousUserData: string | undefined

function createOwnedAsset(relativePath: string): void {
  const absolutePath = path.join(tempRoot, 'media_assets', relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, 'image')
}

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-resource-less-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
})

afterEach(() => {
  closeDatabase()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('resourceLessVideoCleanupService', () => {
  it('deletes only zero-resource videos and removes their relations and owned images', () => {
    const db = getDb()
    const coverPath = 'covers/empty.jpg'
    const samplePath = 'samples/empty.jpg'
    createOwnedAsset(coverPath)
    createOwnedAsset(samplePath)
    const emptyVideoId = Number(
      db
        .prepare("INSERT INTO videos (code, title, cover_path) VALUES ('EMPTY-001', 'Empty', ?)")
        .run(coverPath).lastInsertRowid
    )
    const linkedVideoId = Number(
      db
        .prepare("INSERT INTO videos (code, title) VALUES ('LINKED-001', 'Linked')")
        .run().lastInsertRowid
    )
    db.prepare(
      `INSERT INTO video_resources
         (video_id, kind, locator, resource_key, is_primary)
       VALUES (?, 'web', ?, ?, 1)`
    ).run(
      linkedVideoId,
      'https://example.test/watch?id=1&token=secret',
      'web:https://example.test/watch?id=1&token=secret'
    )
    const tagId = Number(db.prepare("INSERT INTO tags (name) VALUES ('cleanup-tag')").run().lastInsertRowid)
    db.prepare(
      "INSERT INTO video_tag (video_id, tag_id, origin) VALUES (?, ?, 'manual')"
    ).run(emptyVideoId, tagId)
    db.prepare(
      `INSERT INTO video_assets (video_id, type, local_path, position)
       VALUES (?, 'sample', ?, 0)`
    ).run(emptyVideoId, samplePath)
    const stagedPath = '.video_scrape_staging/empty-candidate.jpg'
    createOwnedAsset(stagedPath)
    const pendingId = Number(db.prepare(
      `INSERT INTO pending_video_scrapes (
         video_id, selected_fields_json, applicable_fields_json, update_mode,
         request_json, warnings_json, created_at, updated_at
       ) VALUES (?, '[]', '[]', 'replace', '{}', '[]', '2025-01-01', '2025-01-01')`
    ).run(emptyVideoId).lastInsertRowid)
    const sourceId = Number(db.prepare(
      `INSERT INTO pending_video_scrape_sources (
         pending_scrape_id, plugin_name, plugin_source, plugin_config_json,
         source_name, selected_fields_json
       ) VALUES (?, 'test', 'builtin', '{}', 'test', '[]')`
    ).run(pendingId).lastInsertRowid)
    const candidateId = Number(db.prepare(
      "INSERT INTO pending_video_scrape_candidates (source_id, result_json) VALUES (?, '{\"code\":\"EMPTY-001\"}')"
    ).run(sourceId).lastInsertRowid)
    db.prepare(
      "INSERT INTO pending_video_scrape_resources (candidate_id, field, staged_path) VALUES (?, 'cover', ?)"
    ).run(candidateId, stagedPath)
    const unrelatedSourceFile = path.join(tempRoot, 'unrelated-source.mp4')
    fs.writeFileSync(unrelatedSourceFile, 'source')

    const deleted = deleteResourceLessVideos()

    assert.equal(deleted, 1)
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM videos WHERE id = ?').get(emptyVideoId) as { n: number }).n,
      0
    )
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM videos WHERE id = ?').get(linkedVideoId) as { n: number }).n,
      1
    )
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM video_tag WHERE video_id = ?').get(emptyVideoId) as { n: number }).n,
      0
    )
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM tags WHERE id = ?').get(tagId) as { n: number }).n,
      0
    )
    assert.equal(fs.existsSync(path.join(tempRoot, 'media_assets', coverPath)), false)
    assert.equal(fs.existsSync(path.join(tempRoot, 'media_assets', samplePath)), false)
    assert.equal(fs.existsSync(path.join(tempRoot, 'media_assets', stagedPath)), false)
    assert.equal(fs.existsSync(unrelatedSourceFile), true)
  })
})
