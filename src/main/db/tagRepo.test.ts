import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { insertTestVideoWithFile } from './testVideoFixtures'
import { pruneUnusedTags } from './tagRepo'

let tempRoot: string | null = null

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-tag-repo-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const db = getDb()
  insertTestVideoWithFile(db, { code: 'ABC-1', filePath: 'a.mp4', scrapedStatus: 0 })
  db.prepare("INSERT INTO tags (id, name) VALUES (1, 'Linked'), (2, 'Orphan')").run()
  db.prepare('INSERT INTO video_tag (video_id, tag_id) VALUES (1, 1)').run()
}

afterEach(() => {
  closeDatabase()
  delete process.env.JAVDEX_TEST_USER_DATA
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('tagRepo.pruneUnusedTags', () => {
  it('deletes tags with no video links and keeps tags still used by a video', () => {
    setupDb()
    const db = getDb()

    assert.equal(pruneUnusedTags(), 1)
    assert.deepEqual(db.prepare('SELECT name FROM tags WHERE id = 1').get(), { name: 'Linked' })
    assert.equal(db.prepare('SELECT id FROM tags WHERE id = 2').get(), undefined)
    assert.equal(pruneUnusedTags(), 0)
  })
})
