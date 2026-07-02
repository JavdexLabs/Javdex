import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { getLibraryOverviewStats } from './overviewRepo'

let tempRoot: string | null = null

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-overview-'))
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const db = getDb()
  db.prepare(
    `INSERT INTO videos (code, file_path, scraped_status) VALUES ('A-1', 'a.mp4', 1)`
  ).run()
  db.prepare(
    `INSERT INTO videos (code, file_path, scraped_status) VALUES ('B-1', 'b.mp4', 0)`
  ).run()
  db.prepare(
    `INSERT INTO videos (code, file_path, scraped_status) VALUES ('C-1', 'c.mp4', 2)`
  ).run()
  db.prepare(`INSERT INTO actresses (main_name, gender) VALUES ('Alice', 'female')`).run()
  db.prepare(`INSERT INTO actresses (main_name, gender) VALUES ('Bob', 'male')`).run()
  db.prepare(`UPDATE actresses SET last_scraped_at = '2024-01-01T00:00:00.000Z' WHERE main_name = 'Alice'`).run()
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
      total: 2,
      female: 1,
      male: 1,
      scraped: 1,
      unscraped: 0
    })
    assert.equal(stats.playlists, 1)
    assert.equal(stats.tags, 1)
    assert.equal(stats.galleryAssets, 0)
    assert.deepEqual(stats.facets, { directors: 1, makers: 0, publishers: 0, series: 0 })
  })
})
