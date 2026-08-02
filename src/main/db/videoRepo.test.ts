import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { insertTestVideoWithFile } from './testVideoFixtures'
import { addAlias, upsertActressFromScrape } from './actressRepo'
import type { ScrapeResult, VideoScrapeField, VideoScrapeUpdateMode } from '@shared/types'
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
  planVideoScrapeResult,
  removeManualVideoTag,
  resolveEffectiveScrapeFields,
  applyScrapeResult,
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

const MATRIX_FIELDS: VideoScrapeField[] = [
  'title',
  'summary',
  'cover',
  'releaseDate',
  'maker',
  'publisher',
  'series',
  'director',
  'duration',
  'actressesFemale',
  'actressesMale',
  'tags',
  'source',
  'rating',
  'samples'
]

function expectedMatrixImpact(
  mode: VideoScrapeUpdateMode,
  currentPresent: boolean,
  scrapedPresent: boolean
): { action: 'preserve' | 'set' | 'replace' | 'clear'; reason: string; applied: boolean } {
  if (mode === 'replace') {
    return {
      action: scrapedPresent ? 'replace' : 'clear',
      reason: 'replace',
      applied: true
    }
  }
  if (mode === 'replaceIfPresent') {
    return {
      action: scrapedPresent ? 'replace' : 'preserve',
      reason: scrapedPresent ? 'replaceIfPresent' : 'noValue',
      applied: scrapedPresent
    }
  }
  if (currentPresent) {
    return { action: 'preserve', reason: 'existingValue', applied: false }
  }
  return {
    action: scrapedPresent ? 'set' : 'preserve',
    reason: scrapedPresent ? 'fillEmpty' : 'noValue',
    applied: scrapedPresent
  }
}

describe('videoRepo.resolveEffectiveScrapeFields', () => {
  it('fillEmpty keeps only empty scalar fields', () => {
    setupDb()
    const effective = resolveEffectiveScrapeFields(
      1,
      ['title', 'summary', 'maker'],
      'fillEmpty'
    )
    assert.deepEqual(effective, ['summary'])
  })

  it('fillEmpty evaluates female and male cast independently', () => {
    setupDb()
    const db = getDb()
    db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)').run('Alice', 'female')
    const actress = db.prepare('SELECT id FROM actresses WHERE main_name = ?').get('Alice') as {
      id: number
    }
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, actress.id)

    const effective = resolveEffectiveScrapeFields(
      1,
      ['actressesFemale', 'actressesMale', 'title'],
      'fillEmpty'
    )
    assert.deepEqual(effective, ['actressesMale'])
  })

  it('replaceIfPresent keeps all selected fields regardless of current values', () => {
    setupDb()
    const effective = resolveEffectiveScrapeFields(
      1,
      ['title', 'summary', 'maker'],
      'replaceIfPresent'
    )
    assert.deepEqual(effective, ['title', 'summary', 'maker'])
  })

  it('fillEmpty includes cast fields when video has no performers', () => {
    setupDb()
    const effective = resolveEffectiveScrapeFields(
      1,
      ['actressesFemale', 'actressesMale'],
      'fillEmpty'
    )
    assert.deepEqual(effective, ['actressesFemale', 'actressesMale'])
  })
})

describe('videoRepo.planVideoScrapeResult update matrix', () => {
  const modes: VideoScrapeUpdateMode[] = ['fillEmpty', 'replaceIfPresent', 'replace']
  for (const field of MATRIX_FIELDS) {
    for (const mode of modes) {
      it(`${field} follows ${mode} semantics for every current and scraped value state`, () => {
        setupDb()
        const prepared = matrixScrapeValue(field)
        for (const currentPresent of [false, true]) {
          for (const scrapedPresent of [false, true]) {
            configureMatrixCurrent(field, 1, currentPresent)
            const plan = planVideoScrapeResult(
              1,
              scrapedPresent ? prepared.result : { code: 'MATRIX-EMPTY' },
              scrapedPresent ? prepared.coverPath : null,
              scrapedPresent ? prepared.samplePaths : [],
              [field],
              'Matrix',
              mode,
              'Matrix'
            )
            const impact = plan.impacts[0]
            const expected = expectedMatrixImpact(mode, currentPresent, scrapedPresent)
            assert.deepEqual(
              { action: impact.action, reason: impact.reason, applied: plan.shouldApply },
              expected,
              `currentPresent=${currentPresent}, scrapedPresent=${scrapedPresent}`
            )
          }
        }
      })
    }
  }
})

describe('videoRepo.applyScrapeResult', () => {
  it('builds a read-only plan before applying field changes', () => {
    setupDb()
    const db = getDb()

    const plan = planVideoScrapeResult(
      1,
      { code: 'IPX-535', title: 'Planned title', summary: undefined },
      null,
      [],
      ['title', 'summary'],
      undefined,
      'replaceIfPresent'
    )

    assert.equal(plan.shouldApply, true)
    assert.deepEqual(
      plan.impacts.map(({ field, action, reason }) => ({ field, action, reason })),
      [
        { field: 'title', action: 'replace', reason: 'replaceIfPresent' },
        { field: 'summary', action: 'preserve', reason: 'noValue' }
      ]
    )
    assert.equal(
      (db.prepare('SELECT title FROM videos WHERE id = 1').get() as { title: string }).title,
      'First'
    )
  })

  it('applies scalar fields consistently across the three update modes', () => {
    setupDb()
    const db = getDb()
    db.prepare(
      `UPDATE videos SET summary = 'Old summary', publisher = 'Old publisher',
       duration_seconds = 100 WHERE id = 1`
    ).run()

    const preserve = applyScrapeResult(
      1,
      { code: 'IPX-535', title: 'New title', summary: undefined, publisher: '', durationSeconds: 200 },
      null,
      new Map(),
      [],
      ['title', 'summary', 'publisher', 'duration'],
      undefined,
      'replaceIfPresent'
    )
    assert.equal(preserve.applied, true)
    assert.deepEqual(
      db.prepare('SELECT title, original_title, summary, publisher, duration_seconds FROM videos WHERE id = 1').get(),
      {
        title: 'New title',
        original_title: 'New title',
        summary: 'Old summary',
        publisher: 'Old publisher',
        duration_seconds: 200
      }
    )

    const clear = applyScrapeResult(
      1,
      { code: 'IPX-535' },
      null,
      new Map(),
      [],
      ['title', 'summary', 'publisher', 'duration'],
      undefined,
      'replace'
    )
    assert.equal(clear.applied, true)
    assert.deepEqual(
      db.prepare('SELECT title, original_title, summary, publisher, duration_seconds FROM videos WHERE id = 1').get(),
      {
        title: null,
        original_title: null,
        summary: null,
        publisher: null,
        duration_seconds: null
      }
    )

    const fill = applyScrapeResult(
      1,
      {
        code: 'IPX-535',
        title: 'Filled title',
        summary: 'Filled summary',
        publisher: 'Filled publisher',
        durationSeconds: 300
      },
      null,
      new Map(),
      [],
      ['title', 'summary', 'publisher', 'duration'],
      undefined,
      'fillEmpty'
    )
    assert.equal(fill.applied, true)
    assert.deepEqual(
      db.prepare('SELECT title, summary, publisher, duration_seconds FROM videos WHERE id = 1').get(),
      {
        title: 'Filled title',
        summary: 'Filled summary',
        publisher: 'Filled publisher',
        duration_seconds: 300
      }
    )
  })

  it('does not record a successful scrape when no selected field can be written', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE videos SET scraped_status = 0, last_scraped_at = NULL, updated_at = NULL WHERE id = 1').run()

    const outcome = applyScrapeResult(
      1,
      { code: 'IPX-535' },
      null,
      new Map(),
      [],
      ['summary'],
      undefined,
      'replaceIfPresent'
    )

    assert.equal(outcome.applied, false)
    assert.deepEqual(outcome.warnings, [])
    assert.deepEqual(
      db.prepare('SELECT scraped_status, last_scraped_at, updated_at FROM videos WHERE id = 1').get(),
      { scraped_status: 0, last_scraped_at: null, updated_at: null }
    )
  })

  it('clears only the selected source site metadata in replace mode', () => {
    setupDb()
    const db = getDb()
    const insert = db.prepare(
      `INSERT INTO video_external_ids (video_id, source, url, fetched_at)
       VALUES (1, ?, ?, '2024-01-01')`
    )
    insert.run('JavDB', 'https://javdb.example/old')
    insert.run('JavLibrary', 'https://javlibrary.example/keep')

    const outcome = applyScrapeResult(
      1,
      { code: 'IPX-535' },
      null,
      new Map(),
      [],
      ['source'],
      'JavDB',
      'replace'
    )

    assert.equal(outcome.applied, true)
    assert.deepEqual(
      db.prepare('SELECT source, url FROM video_external_ids WHERE video_id = 1 ORDER BY source').all(),
      [{ source: 'JavLibrary', url: 'https://javlibrary.example/keep' }]
    )
  })

  it('preserves existing cover and warns when a returned image is unavailable', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE videos SET cover_path = ? WHERE id = 1').run('covers/old.jpg')

    const outcome = applyScrapeResult(
      1,
      { code: 'IPX-535', coverUrl: 'https://example.com/new.jpg' },
      null,
      new Map(),
      [],
      ['cover'],
      'Example',
      'replace'
    )

    assert.equal(outcome.applied, false)
    assert.deepEqual(outcome.warnings, ['封面下载失败，已保留原封面'])
    assert.equal(
      (db.prepare('SELECT cover_path FROM videos WHERE id = 1').get() as { cover_path: string }).cover_path,
      'covers/old.jpg'
    )
  })

  it('keeps the complete old sample set when any returned sample is unavailable', () => {
    setupDb()
    const db = getDb()
    db.prepare(
      "INSERT INTO video_assets (video_id, type, position, remote_url, local_path) VALUES (1, 'sample', 0, ?, ?)"
    ).run('https://example.com/old.jpg', 'samples/old.jpg')

    const outcome = applyScrapeResult(
      1,
      {
        code: 'IPX-535',
        sampleImageUrls: ['https://example.com/one.jpg', 'https://example.com/two.jpg']
      },
      null,
      new Map(),
      ['samples/one.jpg', null],
      ['samples'],
      'Example',
      'replace'
    )

    assert.equal(outcome.applied, false)
    assert.deepEqual(outcome.warnings, ['样张下载不完整，已保留原样张'])
    assert.deepEqual(
      db.prepare("SELECT remote_url, local_path FROM video_assets WHERE video_id = 1 AND type = 'sample'").all(),
      [{ remote_url: 'https://example.com/old.jpg', local_path: 'samples/old.jpg' }]
    )
  })

  it('replaces selected relation sets while preserving manual tags and the other cast gender', () => {
    setupDb()
    const db = getDb()
    db.prepare("UPDATE video_tag SET origin = 'scraped' WHERE video_id = 1").run()
    addManualVideoTag(1, 'Manual Keep')
    const oldFemaleId = Number(
      db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)').run('Old Female', 'female')
        .lastInsertRowid
    )
    const oldMaleId = Number(
      db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)').run('Old Male', 'male')
        .lastInsertRowid
    )
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (1, ?)').run(oldFemaleId)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (1, ?)').run(oldMaleId)

    const outcome = applyScrapeResult(
      1,
      {
        code: 'IPX-535',
        actresses: [{ name: 'New Female', gender: 'female' }],
        tags: ['New Scraped']
      },
      null,
      new Map(),
      [],
      ['actressesFemale', 'tags'],
      'Example',
      'replace'
    )

    assert.equal(outcome.applied, true)
    const detail = getVideoDetail(1)!
    assert.deepEqual(
      detail.actresses.map((item) => item.main_name).sort(),
      ['New Female', 'Old Male']
    )
    assert.equal(
      detail.tags.some((tag) => tag.name === 'Manual Keep' && tag.origin === 'manual'),
      true
    )
    assert.deepEqual(
      detail.tags.filter((tag) => tag.origin === 'scraped').map((tag) => tag.name),
      ['New Scraped']
    )
  })

  it('reuses the unique name owner for canonically equivalent scraped cast names', () => {
    setupDb()

    applyScrapeResult(
      1,
      { code: 'IPX-535', actresses: [{ name: 'Alice Example', gender: 'female' }] },
      null,
      new Map(),
      [],
      ['actressesFemale']
    )
    applyScrapeResult(
      2,
      { code: 'MUKD-501', actresses: [{ name: 'Ａｌｉｃｅ　Ｅｘａｍｐｌｅ', gender: 'female' }] },
      null,
      new Map(),
      [],
      ['actressesFemale']
    )

    const db = getDb()
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM actresses').get() as { n: number }).n,
      1
    )
    const links = db
      .prepare('SELECT video_id, actress_id FROM video_actress ORDER BY video_id')
      .all() as Array<{ video_id: number; actress_id: number }>
    assert.deepEqual(links, [
      { video_id: 1, actress_id: 1 },
      { video_id: 2, actress_id: 1 }
    ])
  })

  it('does not create or link an actress for a migrated pending cast name', () => {
    setupDb()
    const db = getDb()
    const insertActress = db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)')
    const firstId = Number(insertActress.run('Ambiguous Cast Name', 'female').lastInsertRowid)
    const secondId = Number(insertActress.run('Ａｍｂｉｇｕｏｕｓ　Ｃａｓｔ　Ｎａｍｅ', 'female').lastInsertRowid)
    const insertName = db.prepare(
      "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'main', 1)"
    )
    insertName.run(firstId, 'Ambiguous Cast Name')
    insertName.run(secondId, 'Ａｍｂｉｇｕｏｕｓ　Ｃａｓｔ　Ｎａｍｅ')
    const insertClaim = db.prepare(
      `INSERT INTO pending_actress_name_claims
        (normalized_name, actress_id, name, type, is_primary)
       VALUES ('ambiguouscastname', ?, ?, 'main', 1)`
    )
    insertClaim.run(firstId, 'Ambiguous Cast Name')
    insertClaim.run(secondId, 'Ａｍｂｉｇｕｏｕｓ　Ｃａｓｔ　Ｎａｍｅ')

    assert.throws(
      () =>
        applyScrapeResult(
          1,
          {
            code: 'IPX-535',
            title: 'Must Roll Back',
            actresses: [{ name: 'Ambiguous　Cast Name', gender: 'female' }]
          },
          null,
          new Map(),
          [],
          ['title', 'actressesFemale']
        ),
      /已被其他演员使用/
    )

    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM actresses').get() as { n: number }).n,
      2
    )
    assert.equal(
      (db.prepare('SELECT title FROM videos WHERE id = 1').get() as { title: string }).title,
      'First'
    )
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM video_actress').get() as { n: number }).n,
      0
    )
  })

  it('replaceIfPresent updates existing scalars when scrape has values and keeps null scrape values', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE videos SET summary = ? WHERE id = ?').run('Keep me', 1)

    applyScrapeResult(
      1,
      { code: 'IPX-535', title: 'Updated Title', summary: undefined },
      null,
      new Map(),
      [],
      ['title', 'summary'],
      undefined,
      'replaceIfPresent'
    )

    const row = db.prepare('SELECT title, summary FROM videos WHERE id = ?').get(1) as {
      title: string | null
      summary: string | null
    }
    assert.equal(row.title, 'Updated Title')
    assert.equal(row.summary, 'Keep me')
  })

  it('stores external stats under ratingSourceName when provided', () => {
    setupDb()
    const db = getDb()

    applyScrapeResult(
      1,
      { code: 'IPX-535', ratingAverage: 4.5, ratingCount: 100 },
      null,
      new Map(),
      [],
      ['rating'],
      'MyComposite',
      'replace',
      'JavDB'
    )

    const row = db
      .prepare('SELECT source, rating_average, rating_count FROM video_external_stats WHERE video_id = 1')
      .get() as { source: string; rating_average: number; rating_count: number }
    assert.equal(row.source, 'JavDB')
    assert.equal(row.rating_average, 4.5)
    assert.equal(row.rating_count, 100)
    assert.equal(
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM video_external_stats WHERE video_id = 1')
          .get() as { n: number }
      ).n,
      1
    )
  })

  it('adopts cast avatars into per-actress bundles instead of sharing download paths', () => {
    setupDb()
    if (!tempRoot) throw new Error('test root not initialized')
    const mediaRoot = path.join(tempRoot, 'media_assets', 'avatars')
    fs.mkdirSync(mediaRoot, { recursive: true })
    const jpeg = Buffer.from(
      'ffd8ffe000104a4649460000010101004800480000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191082242b1c11552d1f0243362728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f007b941100ffd9',
      'hex'
    )
    fs.writeFileSync(path.join(mediaRoot, 'cast-a.jpg'), jpeg)
    fs.writeFileSync(path.join(mediaRoot, 'cast-b.jpg'), jpeg)

    const avatars = new Map<string, string | null>([
      ['三上悠亚', 'avatars/cast-a.jpg'],
      ['桥本有菜', 'avatars/cast-b.jpg']
    ])
    applyScrapeResult(
      1,
      {
        code: 'IPX-535',
        actresses: [
          { name: '三上悠亚', gender: 'female' },
          { name: '桥本有菜', gender: 'female' }
        ]
      },
      null,
      avatars,
      [],
      ['actressesFemale'],
      undefined,
      'replace'
    )

    const db = getDb()
    const rows = db
      .prepare(
        `SELECT main_name, avatar_path, avatar_source_path, avatar_crop_json
         FROM actresses
         WHERE main_name IN ('三上悠亚', '桥本有菜')
         ORDER BY main_name`
      )
      .all() as Array<{
      main_name: string
      avatar_path: string | null
      avatar_source_path: string | null
      avatar_crop_json: string | null
    }>
    assert.equal(rows.length, 2)
    assert.ok(rows[0].avatar_path)
    assert.ok(rows[1].avatar_path)
    assert.notEqual(rows[0].avatar_path, rows[1].avatar_path)
    assert.notEqual(rows[0].avatar_source_path, rows[1].avatar_source_path)
    assert.ok(rows[0].avatar_crop_json)
    assert.ok(rows[1].avatar_crop_json)
    assert.notEqual(rows[0].avatar_path, 'avatars/cast-a.jpg')
    assert.notEqual(rows[1].avatar_path, 'avatars/cast-b.jpg')
  })
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

function configureMatrixCurrent(field: VideoScrapeField, videoId: number, present: boolean): void {
  const db = getDb()
  const scalarColumns: Partial<Record<VideoScrapeField, string>> = {
    title: 'title',
    summary: 'summary',
    releaseDate: 'release_date',
    maker: 'maker',
    publisher: 'publisher',
    series: 'series',
    director: 'director',
    duration: 'duration_seconds'
  }
  const scalarColumn = scalarColumns[field]
  if (scalarColumn) {
    db.prepare(`UPDATE videos SET ${scalarColumn} = ? WHERE id = ?`).run(
      present ? (field === 'duration' ? 120 : 'Existing') : null,
      videoId
    )
    return
  }
  if (field === 'cover') {
    const relPath = present ? `covers/matrix-${videoId}.jpg` : null
    db.prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run(relPath, videoId)
    if (relPath && tempRoot) {
      const absPath = path.join(tempRoot, 'media_assets', relPath)
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      fs.writeFileSync(absPath, Buffer.from('ffd8ffe000104a464946', 'hex'))
    }
    return
  }
  if (field === 'actressesFemale' || field === 'actressesMale') {
    const gender = field === 'actressesFemale' ? 'female' : 'male'
    db.prepare(
      `DELETE FROM video_actress
       WHERE video_id = ? AND actress_id IN (SELECT id FROM actresses WHERE gender = ?)`
    ).run(videoId, gender)
    if (present) {
      const actressName = `Matrix ${gender} ${videoId}`
      db.prepare('INSERT OR IGNORE INTO actresses (main_name, gender) VALUES (?, ?)').run(
        actressName,
        gender
      )
      const actressId = (
        db.prepare('SELECT id FROM actresses WHERE main_name = ?').get(actressName) as {
          id: number
        }
      ).id
      db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(
        videoId,
        actressId
      )
    }
    return
  }
  if (field === 'tags') {
    db.prepare("DELETE FROM video_tag WHERE video_id = ? AND origin = 'scraped'").run(videoId)
    if (present) {
      const tagName = `Matrix Tag ${videoId}`
      db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tagName)
      const tagId = (db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as { id: number })
        .id
      db.prepare(
        "INSERT INTO video_tag (video_id, tag_id, origin) VALUES (?, ?, 'scraped')"
      ).run(videoId, tagId)
    }
    return
  }
  if (field === 'source') {
    db.prepare("DELETE FROM video_external_ids WHERE video_id = ? AND source = 'Matrix'").run(videoId)
    if (present) {
      db.prepare(
        "INSERT INTO video_external_ids (video_id, source, url, fetched_at) VALUES (?, 'Matrix', ?, '2024-01-01')"
      ).run(videoId, 'https://existing.example')
    }
    return
  }
  if (field === 'rating') {
    db.prepare("DELETE FROM video_external_stats WHERE video_id = ? AND source = 'Matrix'").run(videoId)
    if (present) {
      db.prepare(
        "INSERT INTO video_external_stats (video_id, source, rating_average, fetched_at) VALUES (?, 'Matrix', 4, '2024-01-01')"
      ).run(videoId)
    }
    return
  }
  if (field === 'samples') {
    db.prepare("DELETE FROM video_assets WHERE video_id = ? AND type = 'sample'").run(videoId)
    if (present && tempRoot) {
      const relPath = `samples/matrix-${videoId}.jpg`
      const absPath = path.join(tempRoot, 'media_assets', relPath)
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      fs.writeFileSync(absPath, Buffer.from('ffd8ffe000104a464946', 'hex'))
      db.prepare(
        "INSERT INTO video_assets (video_id, type, position, local_path) VALUES (?, 'sample', 0, ?)"
      ).run(videoId, relPath)
    }
  }
}

function matrixScrapeValue(field: VideoScrapeField): {
  result: ScrapeResult
  coverPath: string | null
  samplePaths: Array<string | null>
} {
  const result: ScrapeResult = { code: 'MATRIX-001' }
  let coverPath: string | null = null
  let samplePaths: Array<string | null> = []
  switch (field) {
    case 'title': result.title = 'Next'; break
    case 'summary': result.summary = 'Next'; break
    case 'cover': result.coverUrl = 'https://next.example/cover.jpg'; coverPath = 'covers/next.jpg'; break
    case 'releaseDate': result.releaseDate = '2025-01-02'; break
    case 'maker': result.maker = 'Next'; break
    case 'publisher': result.publisher = 'Next'; break
    case 'series': result.series = 'Next'; break
    case 'director': result.director = 'Next'; break
    case 'duration': result.durationSeconds = 240; break
    case 'actressesFemale': result.actresses = [{ name: 'Next Female', gender: 'female' }]; break
    case 'actressesMale': result.actresses = [{ name: 'Next Male', gender: 'male' }]; break
    case 'tags': result.tags = ['Next Tag']; break
    case 'source': result.sourceUrl = 'https://next.example'; break
    case 'rating': result.ratingAverage = 4.5; result.ratingCount = 10; break
    case 'samples': result.sampleImageUrls = ['https://next.example/sample.jpg']; samplePaths = ['samples/next.jpg']; break
  }
  return { result, coverPath, samplePaths }
}

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
        `INSERT INTO video_files (video_id, file_path, file_size, is_primary, add_time)
         VALUES (?, ?, ?, 0, ?)`
      )
      .run(1, 'alt.mp4', 2048, '2024-01-05')
    const altFileId = Number(info.lastInsertRowid)

    setPrimaryVideoFile(1, altFileId)

    const files = db
      .prepare('SELECT id, is_primary FROM video_files WHERE video_id = 1 ORDER BY id')
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

  it('filters by videos missing any selected metadata field', () => {
    setupDb()
    if (!tempRoot) throw new Error('test root not initialized')
    const db = getDb()
    db.prepare('UPDATE videos SET summary = ? WHERE code = ?').run('Has summary', 'IPX-535')
    db.prepare('UPDATE videos SET cover_path = ? WHERE code = ?').run(
      'covers/ipx-535.jpg',
      'IPX-535'
    )
    db.prepare('INSERT INTO video_assets (video_id, type, local_path) VALUES (?, ?, ?)').run(
      1,
      'cover',
      'covers/ipx-535.jpg'
    )
    const covers = path.join(tempRoot, 'media_assets', 'covers')
    fs.mkdirSync(covers, { recursive: true })
    fs.writeFileSync(
      path.join(covers, 'ipx-535.jpg'),
      Buffer.from('ffd8ffe000104a464946', 'hex')
    )

    const targets = listVideosForBatchScrape({
      status: 'all',
      missingFields: ['summary', 'cover']
    })

    assert.deepEqual(
      targets.map((target) => target.code),
      ['MUKD-501']
    )
    assert.equal(countVideosForBatchScrape({ status: 'all', missingFields: ['summary'] }), 1)
  })

  it('combines status and missing-field filters', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE videos SET summary = ? WHERE code = ?').run('Has summary', 'MUKD-501')

    const targets = listVideosForBatchScrape({
      status: 0,
      missingFields: ['summary', 'publisher']
    })

    assert.deepEqual(
      targets.map((target) => target.code),
      ['MUKD-501']
    )
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

  it('uses image health, cast gender, and the selected site when filtering missing fields', () => {
    setupDb()
    if (!tempRoot) throw new Error('test root not initialized')
    const db = getDb()
    const covers = path.join(tempRoot, 'media_assets', 'covers')
    fs.mkdirSync(covers, { recursive: true })
    fs.writeFileSync(path.join(covers, 'broken.jpg'), Buffer.from('<html>not an image</html>'))
    db.prepare('UPDATE videos SET cover_path = ? WHERE id = 1').run('covers/broken.jpg')
    db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)').run('Only Female', 'female')
    const femaleId = Number(
      (db.prepare('SELECT id FROM actresses WHERE main_name = ?').get('Only Female') as { id: number }).id
    )
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (1, ?)').run(femaleId)
    db.prepare(
      "INSERT INTO video_external_ids (video_id, source, url, fetched_at) VALUES (1, 'JavLibrary', 'https://keep.example', '2024-01-01')"
    ).run()

    assert.deepEqual(
      listVideosForBatchScrape({
        status: 1,
        missingFields: ['cover', 'actressesMale', 'source'],
        sourceName: 'JavDB'
      }).map((target) => target.code),
      ['IPX-535']
    )
    assert.deepEqual(
      resolveEffectiveScrapeFields(
        1,
        ['actressesFemale', 'actressesMale', 'source'],
        'fillEmpty',
        'JavLibrary'
      ),
      ['actressesMale']
    )
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

  it('fillEmpty ignores manual tags when deciding whether tags are empty', () => {
    setupDb()
    addManualVideoTag(1, 'CustomOnly')

    const effective = resolveEffectiveScrapeFields(1, ['tags'], 'fillEmpty')
    assert.deepEqual(effective, ['tags'])
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
