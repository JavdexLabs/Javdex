import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { insertTestVideoWithFile } from './testVideoFixtures'
import { getLibraryOverviewStats } from './overviewRepo'

let tempRoot: string | null = null

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-overview-'))
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const db = getDb()
  insertTestVideoWithFile(db, { code: 'A-1', filePath: 'a.mp4', scrapedStatus: 1 })
  insertTestVideoWithFile(db, { code: 'B-1', filePath: 'b.mp4', scrapedStatus: 0 })
  insertTestVideoWithFile(db, { code: 'C-1', filePath: 'c.mp4', scrapedStatus: 2 })

  // Female scope covers cumulative three-state; male is counted but outside coverage.
  db.prepare(
    `INSERT INTO actresses (main_name, gender, scraped_status, last_scraped_at)
     VALUES ('Alice', 'female', 1, '2024-01-01T00:00:00.000Z')`
  ).run()
  db.prepare(
    `INSERT INTO actresses (main_name, gender, scraped_status, last_scraped_at)
     VALUES ('Carol', 'female', 0, NULL)`
  ).run()
  // Failed with no success time — must still count as failed, not unscraped.
  db.prepare(
    `INSERT INTO actresses (main_name, gender, scraped_status, last_scraped_at)
     VALUES ('Dana', 'female', 2, NULL)`
  ).run()
  // Stale timestamp must not make an unscraped actress look successful.
  db.prepare(
    `INSERT INTO actresses (main_name, gender, scraped_status, last_scraped_at)
     VALUES ('Eve', NULL, 0, '2023-06-01T00:00:00.000Z')`
  ).run()
  db.prepare(
    `INSERT INTO actresses (main_name, gender, scraped_status, last_scraped_at)
     VALUES ('Bob', 'male', 1, '2024-02-01T00:00:00.000Z')`
  ).run()

  db.prepare(`INSERT INTO tags (name) VALUES ('Drama')`).run()
  db.prepare(`INSERT INTO playlists (name) VALUES ('Favorites')`).run()
  db.prepare(
    `INSERT INTO facet_entries (type, value) VALUES ('director', 'Director A')`
  ).run()
}

afterEach(() => {
  closeDatabase()
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('getLibraryOverviewStats', () => {
  it('returns aggregate library counts', () => {
    setupDb()
    const stats = getLibraryOverviewStats()
    assert.deepEqual(stats.videos, { total: 3, scraped: 1, unscraped: 1, failed: 1 })
    assert.deepEqual(stats.actresses, {
      total: 5,
      female: 4,
      male: 1,
      scraped: 1,
      failed: 1,
      unscraped: 2
    })
    assert.equal(
      stats.actresses.scraped + stats.actresses.failed + stats.actresses.unscraped,
      stats.actresses.female
    )
    assert.equal(stats.playlists, 1)
    assert.equal(stats.tags, 1)
    assert.equal(stats.galleryAssets, 0)
    assert.deepEqual(stats.facets, { directors: 1, makers: 0, publishers: 0, series: 0 })
  })

  it('counts actress cumulative status from scraped_status, not last_scraped_at', () => {
    setupDb()
    const db = getDb()
    // Promote Carol to failed without writing a success time.
    db.prepare(`UPDATE actresses SET scraped_status = 2 WHERE main_name = 'Carol'`).run()
    // Clear Alice's success time while keeping scraped_status = success.
    db.prepare(`UPDATE actresses SET last_scraped_at = NULL WHERE main_name = 'Alice'`).run()

    const stats = getLibraryOverviewStats()
    assert.equal(stats.actresses.scraped, 1)
    assert.equal(stats.actresses.failed, 2)
    assert.equal(stats.actresses.unscraped, 1)
    assert.equal(
      stats.actresses.scraped + stats.actresses.failed + stats.actresses.unscraped,
      stats.actresses.female
    )
  })
})
