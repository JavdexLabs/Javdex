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
  pruneFacetEntryIfUnused,
  runLibraryCleanup
} from './libraryCleanup'

let tempRoot: string | null = null

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-library-cleanup-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))

  const db = getDb()
  insertTestVideoWithFile(db, { code: 'ABC-1', filePath: 'a.mp4', scrapedStatus: 0 })
  db.prepare('INSERT INTO facet_entries (type, value) VALUES (?, ?)').run('maker', 'Old Maker')
  db.prepare('INSERT INTO facet_entries (type, value) VALUES (?, ?)').run('director', 'Old Director')
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
  it('collects actress and facet hints from a video', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE videos SET maker = ?, director = ? WHERE id = 1').run('Old Maker', 'Old Director')

    assert.deepEqual(collectVideoLibraryCleanupHints(1), {
      actressIds: [1, 2],
      facets: {
        maker: ['Old Maker'],
        publisher: [],
        series: [],
        director: ['Old Director']
      }
    })
  })

  it('prunes unused facet entries and stub actresses after video links are removed', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE videos SET maker = ?, director = ? WHERE id = 1').run('Old Maker', 'Old Director')
    const hints = collectVideoLibraryCleanupHints(1)

    db.prepare('DELETE FROM video_actress WHERE video_id = 1').run()
    db.prepare('UPDATE videos SET maker = NULL, director = NULL WHERE id = 1').run()

    const result = runLibraryCleanup(hints)
    assert.equal(result.facetsRemoved, 2)
    assert.equal(result.stubActressesRemoved, 1)

    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS c FROM facet_entries WHERE type = 'maker' AND value = ?").get(
          'Old Maker'
        ) as { c: number }
      ).c,
      0
    )
    assert.equal(db.prepare('SELECT id FROM actresses WHERE main_name = ?').get('Stub Actress'), undefined)
    assert.ok(db.prepare('SELECT id FROM actresses WHERE main_name = ?').get('Rich Actress'))
  })

  it('does not prune facet entries still referenced by another video', () => {
    setupDb()
    const db = getDb()
    insertTestVideoWithFile(db, {
      code: 'ABC-2',
      filePath: 'b.mp4',
      scrapedStatus: 0,
      maker: 'Shared Maker'
    })
    db.prepare('INSERT OR IGNORE INTO facet_entries (type, value) VALUES (?, ?)').run(
      'maker',
      'Shared Maker'
    )

    assert.equal(pruneFacetEntryIfUnused('maker', 'Shared Maker'), false)
    assert.equal(isStubActress(2), false)
  })
})
