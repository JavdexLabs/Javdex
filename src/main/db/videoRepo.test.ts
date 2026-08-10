import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { insertTestVideoWithFile } from './testVideoFixtures'
import { addAlias, upsertActressFromScrape } from './actressRepo'
import {
  addManualVideoTag,
  countVideosForBatchScrape,
  deleteVideoSampleAsset,
  editVideoRecord,
  getVideoDetail,
  getPrimaryVideoFile,
  listVideos,
  listVideosForBatchScrape,
  markScrapeFailed,
  markScrapeSucceeded,
  removeManualVideoTag,
  setVideoPosterPath,
  setPrimaryVideoFile
} from './videoRepo'

let tempRoot: string | null = null

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-video-repo-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const db = getDb()
  insertTestVideoWithFile(db, {
    code: 'IPX-535',
    filePath: 'a.mp4',
    title: 'First',
    rating: 5,
    releaseDate: '2024-01-02',
    maker: 'Maker A',
    series: 'Series A',
    director: 'Director A',
    scrapedStatus: 1,
    addTime: '2024-01-03'
  })
  insertTestVideoWithFile(db, {
    code: 'MUKD-501',
    filePath: 'b.mp4',
    title: 'Second',
    rating: 3,
    releaseDate: '2023-05-06',
    maker: 'Maker B',
    series: 'Series B',
    director: 'Director B',
    scrapedStatus: 0,
    addTime: '2024-01-04'
  })

  db.prepare('INSERT INTO tags (name) VALUES (?)').run('Drama')
  db.prepare('INSERT INTO tags (name) VALUES (?)').run('HD')
  const drama = db.prepare('SELECT id FROM tags WHERE name = ?').get('Drama') as { id: number }
  const hd = db.prepare('SELECT id FROM tags WHERE name = ?').get('HD') as { id: number }
  db.prepare('INSERT INTO video_tag (video_id, tag_id) VALUES (?, ?)').run(1, drama.id)
  db.prepare('INSERT INTO video_tag (video_id, tag_id) VALUES (?, ?)').run(1, hd.id)
  db.prepare('INSERT INTO video_tag (video_id, tag_id) VALUES (?, ?)').run(2, drama.id)
}

afterEach(() => {
  closeDatabase()
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})





describe('videoRepo.scrapeStatus', () => {
  it('does not downgrade an already scraped video when a later scrape fails', () => {
    setupDb()
    const db = getDb()

    markScrapeFailed(1)
    markScrapeFailed(2)

    const rows = db
      .prepare('SELECT id, scraped_status FROM videos ORDER BY id')
      .all() as Array<{ id: number; scraped_status: number }>
    assert.deepEqual(rows, [
      { id: 1, scraped_status: 1 },
      { id: 2, scraped_status: 2 }
    ])
  })

  it('can manually mark an unscraped or failed video as scraped', () => {
    setupDb()
    const db = getDb()
    markScrapeFailed(2)

    markScrapeSucceeded(2)

    const row = db
      .prepare('SELECT scraped_status, last_scraped_at, updated_at FROM videos WHERE id = ?')
      .get(2) as { scraped_status: number; last_scraped_at: string | null; updated_at: string | null }
    assert.equal(row.scraped_status, 1)
    assert.ok(row.last_scraped_at)
    assert.ok(row.updated_at)
  })
})

describe('videoRepo.listVideos', () => {
  it('sorts and paginates videos', () => {
    setupDb()
    const page = listVideos({ sortBy: 'add_time', sortDir: 'desc', limit: 1, offset: 0 })

    assert.equal(page.total, 2)
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0].code, 'MUKD-501')
  })

  it('sorts facet videos by release date desc with missing dates last', () => {
    setupDb()
    const db = getDb()
    insertTestVideoWithFile(db, {
      code: 'NEW-001',
      filePath: 'c.mp4',
      title: 'No date',
      director: 'Director A',
      releaseDate: null,
      scrapedStatus: 1,
      addTime: '2024-06-01'
    })

    const result = listVideos({ director: 'Director A', sortBy: 'release_date', sortDir: 'desc' })

    assert.equal(result.total, 2)
    assert.deepEqual(
      result.items.map((video) => video.code),
      ['IPX-535', 'NEW-001']
    )
  })

  it('filters by status, year and facet fields', () => {
    setupDb()
    const result = listVideos({
      scrapedStatus: 1,
      year: 2024,
      maker: 'Maker A',
      sortBy: 'code',
      sortDir: 'asc'
    })

    assert.equal(result.total, 1)
    assert.equal(result.items[0].code, 'IPX-535')
  })

  it('applies multi-tag AND filters', () => {
    setupDb()
    const db = getDb()
    const tags = db.prepare('SELECT id, name FROM tags ORDER BY name').all() as {
      id: number
      name: string
    }[]
    const result = listVideos({ tagIds: tags.map((t) => t.id) })

    assert.equal(result.total, 1)
    assert.equal(result.items[0].code, 'IPX-535')
  })

  it('filters resource kinds with OR semantics and treats no-resource as zero rows', () => {
    setupDb()
    const db = getDb()
    db.prepare(
      `INSERT INTO video_resources
         (video_id, kind, locator, resource_key, is_primary, add_time)
       VALUES (1, 'direct', 'https://cdn.example.test/IPX-535.mp4', 'http:ipx-direct', 0, '2024-02-01')`
    ).run()
    db.prepare(
      `INSERT INTO videos (code, scraped_status, add_time)
       VALUES ('EMPTY-001', 0, '2024-02-02')`
    ).run()

    const result = listVideos({ resourceKinds: ['direct', 'none'], sortBy: 'code', sortDir: 'asc' })

    assert.equal(result.total, 2)
    assert.deepEqual(
      result.items.map((video) => video.code),
      ['EMPTY-001', 'IPX-535']
    )
    assert.deepEqual(listVideos({ resourceKinds: ['none'] }).items.map((video) => video.code), [
      'EMPTY-001'
    ])
  })

  it('projects resource count and primary-first deduplicated resource kinds', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE video_resources SET is_primary = 0 WHERE video_id = 1').run()
    db.prepare(
      `INSERT INTO video_resources
         (video_id, kind, locator, resource_key, is_primary, add_time)
       VALUES
         (1, 'direct', 'https://cdn.example.test/one.mp4', 'http:one', 0, '2024-02-01'),
         (1, 'web', 'https://example.test/watch/1', 'http:web-one', 1, '2024-03-01'),
         (1, 'direct', 'https://cdn.example.test/two.mp4', 'http:two', 0, '2024-04-01')`
    ).run()

    const [video] = listVideos({ search: 'IPX-535' }).items

    assert.equal(video.resource_count, 4)
    assert.deepEqual(video.resource_kinds, ['web', 'local', 'direct'])
  })

  it('searches videos by actress alias', () => {
    setupDb()
    const db = getDb()
    const actressId = upsertActressFromScrape('Yui Hatano', null)
    addAlias(actressId, '波多野結衣')
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, actressId)

    const byMain = listVideos({ search: 'Hatano' })
    assert.equal(byMain.total, 1)
    assert.equal(byMain.items[0].code, 'IPX-535')

    const byAlias = listVideos({ search: '波多野' })
    assert.equal(byAlias.total, 1)
    assert.equal(byAlias.items[0].code, 'IPX-535')
  })

  it('preserves SQL LIKE pattern matching in the video search actress branch', () => {
    setupDb()
    const db = getDb()
    const actressId = upsertActressFromScrape('Pattern Actress', null)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(2, actressId)

    const result = listVideos({ search: 'Pattern_Actress' })

    assert.equal(result.total, 1)
    assert.equal(result.items[0].code, 'MUKD-501')
  })

  it('excludes migrated pending actress names from video search', () => {
    setupDb()
    const db = getDb()
    const actressId = upsertActressFromScrape('Pending Holder', null)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, actressId)
    db.prepare(
      "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'alias', 0)"
    ).run(actressId, 'Ambiguous Pending')
    db.prepare(
      `INSERT INTO pending_actress_name_claims
         (normalized_name, actress_id, name, type, is_primary)
       VALUES (?, ?, ?, 'alias', 0)`
    ).run('ambiguouspending', actressId, 'Ambiguous Pending')

    assert.equal(listVideos({ search: 'Ambiguous Pending' }).total, 0)
  })
})



describe('videoRepo.getVideoDetail', () => {
  it('lists female cast before male cast', () => {
    setupDb()
    const db = getDb()
    db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)').run('Aaron', 'male')
    db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)').run('Bella', 'female')
    db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)').run('Charlie', 'male')
    const aaron = db.prepare('SELECT id FROM actresses WHERE main_name = ?').get('Aaron') as {
      id: number
    }
    const bella = db.prepare('SELECT id FROM actresses WHERE main_name = ?').get('Bella') as {
      id: number
    }
    const charlie = db.prepare('SELECT id FROM actresses WHERE main_name = ?').get('Charlie') as {
      id: number
    }
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, aaron.id)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, bella.id)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, charlie.id)

    const detail = getVideoDetail(1)
    assert.ok(detail)
    assert.deepEqual(
      detail.actresses.map((a) => a.main_name),
      ['Bella', 'Aaron', 'Charlie']
    )
  })

  it('includes external rating stats', () => {
    setupDb()
    const db = getDb()
    db.prepare(
      `INSERT INTO video_external_stats
         (video_id, source, rating_average, rating_count, fetched_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(1, 'JavDB', 8.5, 1234, '2024-06-01T12:00:00.000Z')

    const detail = getVideoDetail(1)
    assert.ok(detail)
    assert.equal(detail.external_stats.length, 1)
    assert.equal(detail.external_stats[0]?.source, 'JavDB')
    assert.equal(detail.external_stats[0]?.rating_average, 8.5)
    assert.equal(detail.external_stats[0]?.rating_count, 1234)
  })
})

describe('videoRepo.setPrimaryVideoFile', () => {
  it('marks one file as primary and clears the previous primary', () => {
    setupDb()
    const db = getDb()
    const info = db
      .prepare(
        `INSERT INTO video_resources
           (video_id, kind, locator, resource_key, size_bytes, is_primary, add_time)
         VALUES (?, 'local', ?, 'local:' || ?, ?, 0, ?)`
      )
      .run(1, 'alt.mp4', 'alt.mp4', 2048, '2024-01-05')
    const altFileId = Number(info.lastInsertRowid)

    setPrimaryVideoFile(1, altFileId)

    const files = db
      .prepare('SELECT id, is_primary FROM video_resources WHERE video_id = 1 ORDER BY id')
      .all() as Array<{ id: number; is_primary: number }>
    assert.deepEqual(files, [
      { id: 1, is_primary: 0 },
      { id: altFileId, is_primary: 1 }
    ])
    assert.equal(getPrimaryVideoFile(1)?.id, altFileId)
  })
})

describe('videoRepo.posterPath', () => {
  it('clears the poster when the referenced sample is deleted', () => {
    setupDb()
    const db = getDb()
    const info = db
      .prepare(
        "INSERT INTO video_assets (video_id, type, position, local_path) VALUES (?, 'sample', 0, ?)"
      )
      .run(1, 'samples/ipx-535.jpg')
    const assetId = Number(info.lastInsertRowid)

    setVideoPosterPath(1, 'samples/ipx-535.jpg')
    deleteVideoSampleAsset(1, assetId)

    assert.deepEqual(db.prepare('SELECT poster_path FROM videos WHERE id = ?').get(1), {
      poster_path: null
    })
  })
})

describe('videoRepo.listVideosForBatchScrape', () => {
  it('filters by scrape status', () => {
    setupDb()

    const targets = listVideosForBatchScrape({ status: 0 })

    assert.deepEqual(
      targets.map((target) => target.code),
      ['MUKD-501']
    )
    assert.equal(countVideosForBatchScrape({ status: 1 }), 1)
  })

  it('can constrain batch targets to explicit selected video ids', () => {
    setupDb()

    const targets = listVideosForBatchScrape({
      status: 'all',
      videoIds: [2, 2, 999]
    })

    assert.deepEqual(
      targets.map((target) => target.code),
      ['MUKD-501']
    )
    assert.equal(countVideosForBatchScrape({ status: 'all', videoIds: [] }), 0)
  })

})

describe('videoRepo tags by origin', () => {
  it('orders scraped tags before manual tags in detail', () => {
    setupDb()
    const db = getDb()
    db.prepare("UPDATE video_tag SET origin = 'scraped' WHERE video_id = 1").run()
    addManualVideoTag(1, 'Zeta')
    addManualVideoTag(1, 'Alpha')

    const detail = getVideoDetail(1)!
    const scraped = detail.tags.filter((tag) => tag.origin === 'scraped')
    const manual = detail.tags.filter((tag) => tag.origin === 'manual')

    assert.equal(scraped.length, 2)
    assert.deepEqual(manual.map((tag) => tag.name), ['Alpha', 'Zeta'])
    assert.equal(detail.tags.slice(0, scraped.length).every((tag) => tag.origin === 'scraped'), true)
  })

  it('editVideoRecord only replaces scraped tags', () => {
    setupDb()
    const db = getDb()
    db.prepare("UPDATE video_tag SET origin = 'scraped' WHERE video_id = 1").run()
    addManualVideoTag(1, 'KeepMe')

    editVideoRecord(1, { tags: ['NewScraped'] })

    const detail = getVideoDetail(1)!
    assert.ok(detail.tags.some((tag) => tag.name === 'KeepMe' && tag.origin === 'manual'))
    assert.ok(detail.tags.some((tag) => tag.name === 'NewScraped' && tag.origin === 'scraped'))
    assert.equal(detail.tags.filter((tag) => tag.origin === 'scraped').length, 1)
  })

  it('editVideoRecord replaces female and male cast separately', () => {
    setupDb()
    const db = getDb()
    db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)').run('Old Female', 'female')
    db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)').run('Old Male', 'male')
    const oldFemale = db.prepare('SELECT id FROM actresses WHERE main_name = ?').get('Old Female') as {
      id: number
    }
    const oldMale = db.prepare('SELECT id FROM actresses WHERE main_name = ?').get('Old Male') as {
      id: number
    }
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, oldFemale.id)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, oldMale.id)

    editVideoRecord(1, {
      actressesFemale: ['New Female'],
      actressesMale: ['New Male']
    })

    const detail = getVideoDetail(1)!
    assert.deepEqual(detail.actresses.map((item) => item.main_name).sort(), ['New Female', 'New Male'])
    assert.equal(
      (db.prepare('SELECT gender FROM actresses WHERE main_name = ?').get('New Female') as { gender: string })
        .gender,
      'female'
    )
    assert.equal(
      (db.prepare('SELECT gender FROM actresses WHERE main_name = ?').get('New Male') as { gender: string })
        .gender,
      'male'
    )
  })

  it('removeManualVideoTag only removes manual tags', () => {
    setupDb()
    const db = getDb()
    db.prepare("UPDATE video_tag SET origin = 'scraped' WHERE video_id = 1").run()
    addManualVideoTag(1, 'Temp')

    const temp = getVideoDetail(1)!.tags.find((tag) => tag.name === 'Temp')!
    removeManualVideoTag(1, temp.id)

    const after = getVideoDetail(1)!
    assert.ok(!after.tags.some((tag) => tag.name === 'Temp'))
    assert.ok(after.tags.some((tag) => tag.name === 'Drama'))
    assert.equal(db.prepare('SELECT id FROM tags WHERE name = ?').get('Temp'), undefined)
  })

  it('removeManualVideoTag keeps tag when scraped associations remain', () => {
    setupDb()
    const db = getDb()
    db.prepare("UPDATE video_tag SET origin = 'scraped' WHERE video_id = 1").run()
    const drama = db.prepare('SELECT id FROM tags WHERE name = ?').get('Drama') as { id: number }

    removeManualVideoTag(2, drama.id)

    assert.ok(db.prepare('SELECT id FROM tags WHERE id = ?').get(drama.id))
    assert.deepEqual(
      db.prepare('SELECT COUNT(*) AS n FROM video_tag WHERE tag_id = ?').get(drama.id),
      { n: 1 }
    )
  })

  it('promotes scraped tag to manual when adding the same name', () => {
    setupDb()
    const db = getDb()
    db.prepare("UPDATE video_tag SET origin = 'scraped' WHERE video_id = 1").run()
    const drama = db.prepare('SELECT id FROM tags WHERE name = ?').get('Drama') as { id: number }

    addManualVideoTag(1, 'Drama')

    const row = db
      .prepare('SELECT origin FROM video_tag WHERE video_id = 1 AND tag_id = ?')
      .get(drama.id) as { origin: string }
    assert.equal(row.origin, 'manual')

    const detail = getVideoDetail(1)!
    assert.equal(detail.tags.filter((tag) => tag.origin === 'scraped').length, 1)
    assert.equal(detail.tags.filter((tag) => tag.origin === 'manual').length, 1)
    assert.ok(detail.tags.some((tag) => tag.name === 'Drama' && tag.origin === 'manual'))
    assert.ok(detail.tags.some((tag) => tag.name === 'HD' && tag.origin === 'scraped'))
  })
})
