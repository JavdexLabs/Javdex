import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { insertTestVideoWithFile } from './testVideoFixtures'
import {
  collectVideoLibraryCleanupHints,
  isStubActress,
  runLibraryCleanup
} from './libraryCleanup'

let tempRoot: string | null = null

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-library-cleanup-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))

  const db = getDb()
  insertTestVideoWithFile(db, { code: 'ABC-1', filePath: 'a.mp4', scrapedStatus: 0 })
  db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)').run('Stub Actress', 'female')
  db.prepare('INSERT INTO actresses (main_name, gender, profile_summary) VALUES (?, ?, ?)').run(
    'Rich Actress',
    'female',
    'Bio'
  )
  db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, 1)
  db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, 2)
}

afterEach(() => {
  closeDatabase()
  delete process.env.JAVDEX_TEST_USER_DATA
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('libraryCleanup', () => {
  it('collects actress hints from a video', () => {
    setupDb()
    assert.deepEqual(collectVideoLibraryCleanupHints(1), { actressIds: [1, 2] })
  })

  it('prunes stub actresses after video links are removed', () => {
    setupDb()
    const db = getDb()
    const hints = collectVideoLibraryCleanupHints(1)

    db.prepare('DELETE FROM video_actress WHERE video_id = 1').run()

    const result = runLibraryCleanup(hints)
    assert.equal(result.stubActressesRemoved, 1)
    assert.equal(result.unusedTagsRemoved, 0)

    assert.equal(db.prepare('SELECT id FROM actresses WHERE main_name = ?').get('Stub Actress'), undefined)
    assert.ok(db.prepare('SELECT id FROM actresses WHERE main_name = ?').get('Rich Actress'))
  })

  it('does not prune an actress with meaningful profile data', () => {
    setupDb()
    assert.equal(isStubActress(2), false)
  })

  it('deletes tags that are no longer linked to any video', () => {
    setupDb()
    const db = getDb()
    db.prepare("INSERT INTO tags (id, name) VALUES (11, 'Keep'), (12, 'Drop')").run()
    db.prepare('INSERT INTO video_tag (video_id, tag_id) VALUES (1, 11)').run()

    const result = runLibraryCleanup()
    assert.equal(result.unusedTagsRemoved, 1)
    assert.ok(db.prepare('SELECT id FROM tags WHERE id = 11').get())
    assert.equal(db.prepare('SELECT id FROM tags WHERE id = 12').get(), undefined)
  })
})
