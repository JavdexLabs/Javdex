import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { createMediaLibrary, archiveMediaLibrary } from '../db/mediaLibraryRepo'
import { ensureVideoMembership } from '../db/libraryMembershipRepo'
import { addManualVideoTag, getVideoDetail } from '../db/videoRepo'
import type { ScrapeResult, VideoScrapeField, VideoScrapeUpdateMode } from '@shared/videoScrapeTypes'
import {
  applyScrapeResult,
  planVideoScrapeResult,
  resolveEffectiveScrapeFields,
  resolveVideoBatchTargets
} from './videoScrapeApplyService'
import { classificationMaintenanceService } from './classificationMaintenanceService'

let tempRoot: string | null = null

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-video-scrape-apply-'))
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

  classificationMaintenanceService.assignVideoOrganization(1, 'maker', {
    createName: 'Maker A'
  })
  classificationMaintenanceService.assignVideoSeries(1, { createName: 'Series A' })
  classificationMaintenanceService.assignVideoDirector(1, { createName: 'Director A' })
  classificationMaintenanceService.assignVideoOrganization(2, 'maker', {
    createName: 'Maker B'
  })
  classificationMaintenanceService.assignVideoSeries(2, { createName: 'Series B' })
  classificationMaintenanceService.assignVideoDirector(2, { createName: 'Director B' })

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
  delete process.env.JAVDEX_TEST_USER_DATA
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

describe('videoScrapeApplyService.resolveEffectiveScrapeFields', () => {
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

function configureMatrixCurrent(field: VideoScrapeField, videoId: number, present: boolean): void {
  const db = getDb()
  if (field === 'maker' || field === 'publisher') {
    classificationMaintenanceService.assignVideoOrganization(
      videoId,
      field,
      present ? { createName: `Existing ${field} ${videoId}` } : null
    )
    return
  }
  if (field === 'series') {
    classificationMaintenanceService.assignVideoSeries(
      videoId,
      present ? { createName: `Existing series ${videoId}` } : null
    )
    return
  }
  if (field === 'director') {
    classificationMaintenanceService.assignVideoDirector(
      videoId,
      present ? { createName: `Existing director ${videoId}` } : null
    )
    return
  }
  const scalarColumns: Partial<Record<VideoScrapeField, string>> = {
    title: 'title',
    summary: 'summary',
    releaseDate: 'release_date',
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
    db.prepare("DELETE FROM video_sources WHERE video_id = ? AND source = 'Matrix'").run(videoId)
    if (present) {
      db.prepare(
        "INSERT INTO video_sources (video_id, source, url, fetched_at) VALUES (?, 'Matrix', ?, '2024-01-01')"
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

describe('videoScrapeApplyService.planVideoScrapeResult update matrix', () => {
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

describe('videoScrapeApplyService.applyScrapeResult', () => {
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
    db.prepare("UPDATE videos SET summary = 'Old summary', duration_seconds = 100 WHERE id = 1").run()

    const preserve = applyScrapeResult(
      1,
      { code: 'IPX-535', title: 'New title', summary: undefined, durationSeconds: 200 },
      null,
      new Map(),
      [],
      ['title', 'summary', 'duration'],
      undefined,
      'replaceIfPresent'
    )
    assert.equal(preserve.applied, true)
    assert.deepEqual(
      db.prepare('SELECT title, original_title, summary, duration_seconds FROM videos WHERE id = 1').get(),
      {
        title: 'New title',
        original_title: 'New title',
        summary: 'Old summary',
        duration_seconds: 200
      }
    )

    const clear = applyScrapeResult(
      1,
      { code: 'IPX-535' },
      null,
      new Map(),
      [],
      ['title', 'summary', 'duration'],
      undefined,
      'replace'
    )
    assert.equal(clear.applied, true)
    assert.deepEqual(
      db.prepare('SELECT title, original_title, summary, duration_seconds FROM videos WHERE id = 1').get(),
      {
        title: null,
        original_title: null,
        summary: null,
        duration_seconds: null
      }
    )

    const fill = applyScrapeResult(
      1,
      {
        code: 'IPX-535',
        title: 'Filled title',
        summary: 'Filled summary',
        durationSeconds: 300
      },
      null,
      new Map(),
      [],
      ['title', 'summary', 'duration'],
      undefined,
      'fillEmpty'
    )
    assert.equal(fill.applied, true)
    assert.deepEqual(
      db.prepare('SELECT title, summary, duration_seconds FROM videos WHERE id = 1').get(),
      {
        title: 'Filled title',
        summary: 'Filled summary',
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
      `INSERT INTO video_sources (video_id, source, url, fetched_at)
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
      db.prepare('SELECT source, url FROM video_sources WHERE video_id = 1 ORDER BY source').all(),
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
    assert.equal(db.prepare('SELECT id FROM tags WHERE name = ?').get('HD'), undefined)
    assert.ok(db.prepare('SELECT id FROM tags WHERE name = ?').get('Drama'))
  })

  it('keeps a committed scrape successful when post-commit library cleanup fails', () => {
    setupDb()
    const db = getDb()
    const oldActressId = Number(
      db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)').run('Old Stub', 'female')
        .lastInsertRowid
    )
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (1, ?)').run(oldActressId)
    db.exec(`
      CREATE TRIGGER fail_stub_cleanup
      BEFORE DELETE ON actresses
      WHEN OLD.id = ${oldActressId}
      BEGIN
        SELECT RAISE(ABORT, 'cleanup failed');
      END
    `)
    const previousConsoleError = console.error
    console.error = () => undefined
    try {
      const outcome = applyScrapeResult(
        1,
        { code: 'IPX-535', actresses: [{ name: 'New Actress', gender: 'female' }] },
        'covers/new.jpg',
        new Map(),
        [],
        ['cover', 'actressesFemale'],
        'Example',
        'replace'
      )
      assert.equal(outcome.applied, true)
    } finally {
      console.error = previousConsoleError
    }

    assert.deepEqual(
      db.prepare('SELECT cover_path, scraped_status FROM videos WHERE id = 1').get(),
      { cover_path: 'covers/new.jpg', scraped_status: 1 }
    )
    assert.deepEqual(
      getVideoDetail(1)!.actresses.map((actress) => actress.main_name),
      ['New Actress']
    )
  })

  it('does not roll back scraped tags when orphan-tag cleanup fails after commit', () => {
    setupDb()
    const db = getDb()
    db.prepare("UPDATE video_tag SET origin = 'scraped' WHERE video_id = 1").run()
    db.exec(`
      CREATE TRIGGER fail_orphan_tag_cleanup
      BEFORE DELETE ON tags
      WHEN OLD.name = 'HD'
      BEGIN
        SELECT RAISE(ABORT, 'tag cleanup failed');
      END
    `)

    const previousConsoleError = console.error
    console.error = () => undefined
    try {
      const outcome = applyScrapeResult(
        1,
        { code: 'IPX-535', tags: ['Committed Tag'] },
        null,
        new Map(),
        [],
        ['tags'],
        'Example',
        'replace'
      )
      assert.equal(outcome.applied, true)
    } finally {
      console.error = previousConsoleError
    }

    assert.deepEqual(
      getVideoDetail(1)!.tags.map((tag) => [tag.name, tag.origin]),
      [['Committed Tag', 'scraped']]
    )
    assert.ok(db.prepare('SELECT id FROM tags WHERE name = ?').get('HD'))
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

  it('leaves downloaded cast avatars untouched for application-layer adoption', () => {
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
    assert.deepEqual(
      rows.map(({ avatar_path, avatar_source_path, avatar_crop_json }) => ({
        avatar_path,
        avatar_source_path,
        avatar_crop_json
      })),
      [
        { avatar_path: null, avatar_source_path: null, avatar_crop_json: null },
        { avatar_path: null, avatar_source_path: null, avatar_crop_json: null }
      ]
    )
    assert.equal(fs.existsSync(path.join(mediaRoot, 'cast-a.jpg')), true)
    assert.equal(fs.existsSync(path.join(mediaRoot, 'cast-b.jpg')), true)
  })
})

describe('videoScrapeApplyService classification entity resolution', () => {
  it('preserves entity update semantics across fillEmpty, replaceIfPresent, and replace', () => {
    setupDb()
    const db = getDb()
    const originalMakerId = (
      db.prepare('SELECT maker_organization_id AS id FROM videos WHERE id = 1').get() as {
        id: number
      }
    ).id

    const fill = applyScrapeResult(
      1,
      { code: 'IPX-535', maker: 'Replacement Maker' },
      null,
      new Map(),
      [],
      ['maker'],
      undefined,
      'fillEmpty'
    )
    assert.equal(fill.applied, false)
    assert.equal(
      (db.prepare('SELECT maker_organization_id AS id FROM videos WHERE id = 1').get() as { id: number }).id,
      originalMakerId
    )

    const absent = applyScrapeResult(
      1,
      { code: 'IPX-535' },
      null,
      new Map(),
      [],
      ['maker'],
      undefined,
      'replaceIfPresent'
    )
    assert.equal(absent.applied, false)
    assert.equal(
      (db.prepare('SELECT maker_organization_id AS id FROM videos WHERE id = 1').get() as { id: number }).id,
      originalMakerId
    )

    const cleared = applyScrapeResult(
      1,
      { code: 'IPX-535' },
      null,
      new Map(),
      [],
      ['maker'],
      undefined,
      'replace'
    )
    assert.equal(cleared.applied, true)
    assert.deepEqual(
      db.prepare('SELECT maker_organization_id FROM videos WHERE id = 1').get(),
      { maker_organization_id: null }
    )

    const filled = applyScrapeResult(
      1,
      { code: 'IPX-535', maker: 'Replacement Maker' },
      null,
      new Map(),
      [],
      ['maker'],
      undefined,
      'fillEmpty'
    )
    assert.equal(filled.applied, true)
    assert.equal(filled.classifications[0]?.status, 'created')
    assert.equal(
      getVideoDetail(1)?.maker,
      'Replacement Maker'
    )
  })

  it('matches main names, aliases, and normalized equivalents without overwriting profiles', () => {
    setupDb()
    const db = getDb()
    const organizationId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Main Studio',
      aliases: ['Publishing Label'],
      summary: 'Curated organization profile',
      countryRegion: 'JP',
      foundedYear: 1998,
      status: 'active'
    })
    const directorId = classificationMaintenanceService.createDirector({
      mainName: 'Canonical Director',
      aliases: ['Director Alias'],
      summary: 'Curated director profile',
      countryRegion: 'JP',
      birthDate: '1970-01-02',
      status: 'active'
    })
    const seriesId = classificationMaintenanceService.createSeries({
      mainName: 'Canonical Series',
      aliases: ['Series Alias'],
      summary: 'Curated series profile',
      startYear: 2010,
      status: 'ongoing'
    })

    const outcome = applyScrapeResult(
      1,
      {
        code: 'IPX-535',
        maker: 'ｍａｉｎ　ｓｔｕｄｉｏ',
        publisher: 'Publishing Label',
        director: 'Director Alias',
        series: 'Series Alias'
      },
      null,
      new Map(),
      [],
      ['maker', 'publisher', 'director', 'series'],
      undefined,
      'replaceIfPresent'
    )

    assert.equal(outcome.applied, true)
    assert.deepEqual(
      db.prepare(
        `SELECT maker_organization_id, publisher_organization_id, director_id, series_id
         FROM videos WHERE id = 1`
      ).get(),
      {
        maker_organization_id: organizationId,
        publisher_organization_id: organizationId,
        director_id: directorId,
        series_id: seriesId
      }
    )
    assert.deepEqual(
      outcome.classifications.map(({ field, status, entityId }) => ({ field, status, entityId })),
      [
        { field: 'maker', status: 'matched', entityId: organizationId },
        { field: 'publisher', status: 'matched', entityId: organizationId },
        { field: 'series', status: 'matched', entityId: seriesId },
        { field: 'director', status: 'matched', entityId: directorId }
      ]
    )
    assert.ok(
      db.prepare(
        "SELECT 1 FROM organization_roles WHERE organization_id = ? AND role = 'publisher'"
      ).get(organizationId)
    )
    assert.deepEqual(
      db.prepare(
        `SELECT summary, country_region, founded_year, status
         FROM organizations WHERE id = ?`
      ).get(organizationId),
      {
        summary: 'Curated organization profile',
        country_region: 'JP',
        founded_year: 1998,
        status: 'active'
      }
    )
    assert.deepEqual(
      db.prepare(
        'SELECT summary, country_region, birth_date, status FROM directors WHERE id = ?'
      ).get(directorId),
      {
        summary: 'Curated director profile',
        country_region: 'JP',
        birth_date: '1970-01-02',
        status: 'active'
      }
    )
    assert.deepEqual(
      db.prepare('SELECT summary, start_year, status FROM series WHERE id = ?').get(seriesId),
      { summary: 'Curated series profile', start_year: 2010, status: 'ongoing' }
    )
  })

  it('creates only basic entities, reuses one organization across roles, and leaves series unowned', () => {
    setupDb()
    const db = getDb()
    const outcome = applyScrapeResult(
      1,
      {
        code: 'IPX-535',
        maker: 'Shared New Organization',
        publisher: 'Shared New Organization',
        director: 'New Director',
        series: 'New Series'
      },
      null,
      new Map(),
      [],
      ['maker', 'publisher', 'director', 'series'],
      undefined,
      'replaceIfPresent'
    )

    assert.equal(outcome.applied, true)
    const video = db.prepare(
      `SELECT maker_organization_id, publisher_organization_id, director_id, series_id
       FROM videos WHERE id = 1`
    ).get() as {
      maker_organization_id: number
      publisher_organization_id: number
      director_id: number
      series_id: number
    }
    assert.equal(video.maker_organization_id, video.publisher_organization_id)
    assert.deepEqual(
      db.prepare(
        'SELECT role FROM organization_roles WHERE organization_id = ? ORDER BY role'
      ).all(video.maker_organization_id),
      [{ role: 'maker' }, { role: 'publisher' }]
    )
    assert.deepEqual(
      db.prepare(
        `SELECT summary, country_region, founded_year, ended_year, status,
                parent_organization_id
         FROM organizations WHERE id = ?`
      ).get(video.maker_organization_id),
      {
        summary: null,
        country_region: null,
        founded_year: null,
        ended_year: null,
        status: 'unknown',
        parent_organization_id: null
      }
    )
    assert.deepEqual(
      db.prepare(
        `SELECT summary, country_region, birth_date, death_date, birth_place,
                career_start_year, career_end_year, status
         FROM directors WHERE id = ?`
      ).get(video.director_id),
      {
        summary: null,
        country_region: null,
        birth_date: null,
        death_date: null,
        birth_place: null,
        career_start_year: null,
        career_end_year: null,
        status: 'unknown'
      }
    )
    assert.deepEqual(
      db.prepare(
        `SELECT summary, owner_organization_id, parent_series_id, start_year, end_year, status
         FROM series WHERE id = ?`
      ).get(video.series_id),
      {
        summary: null,
        owner_organization_id: null,
        parent_series_id: null,
        start_year: null,
        end_year: null,
        status: 'unknown'
      }
    )
    assert.ok(outcome.classifications.every((item) => item.status === 'created'))
  })

  it('rolls back scalar writes and newly created entities when a classification assignment fails', () => {
    setupDb()
    const db = getDb()
    db.exec(`
      CREATE TRIGGER reject_scraped_director
      BEFORE UPDATE OF director_id ON videos
      WHEN NEW.id = 1
      BEGIN
        SELECT RAISE(ABORT, 'forced director assignment failure');
      END
    `)

    assert.throws(
      () =>
        applyScrapeResult(
          1,
          {
            code: 'IPX-535',
            title: 'Must roll back',
            maker: 'Rollback Organization',
            director: 'Rollback Director'
          },
          null,
          new Map(),
          [],
          ['title', 'maker', 'director'],
          undefined,
          'replaceIfPresent'
        ),
      /forced director assignment failure/
    )
    assert.deepEqual(
      { title: getVideoDetail(1)?.title, maker: getVideoDetail(1)?.maker },
      { title: 'First', maker: 'Maker A' }
    )
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE main_name = 'Rollback Organization'").get() as { n: number }).n,
      0
    )
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM directors WHERE main_name = 'Rollback Director'").get() as { n: number }).n,
      0
    )
  })

  it('keeps the current director when its alias is one of multiple candidates without updating the video', () => {
    setupDb()
    const db = getDb()
    const currentDirectorId = (
      db.prepare('SELECT director_id AS id FROM videos WHERE id = 1').get() as { id: number }
    ).id
    classificationMaintenanceService.updateDirector(currentDirectorId, {
      mainName: 'Director A',
      aliases: ['Shared Director']
    })
    classificationMaintenanceService.createDirector({
      mainName: 'Shared Director',
      countryRegion: 'US'
    })
    db.prepare(
      "UPDATE videos SET updated_at = '2020-01-01T00:00:00.000Z', last_scraped_at = NULL WHERE id = 1"
    ).run()

    const outcome = applyScrapeResult(
      1,
      { code: 'IPX-535', director: 'Shared Director' },
      null,
      new Map(),
      [],
      ['director'],
      undefined,
      'replaceIfPresent',
      undefined,
      { directorAmbiguity: 'choice' }
    )

    assert.equal(outcome.applied, false)
    assert.equal(outcome.directorChoice, undefined)
    assert.deepEqual(outcome.classifications, [
      {
        field: 'director',
        status: 'preserved',
        inputName: 'Shared Director',
        entityId: currentDirectorId
      }
    ])
    assert.deepEqual(
      db.prepare('SELECT director_id, updated_at, last_scraped_at FROM videos WHERE id = 1').get(),
      {
        director_id: currentDirectorId,
        updated_at: '2020-01-01T00:00:00.000Z',
        last_scraped_at: null
      }
    )
  })

  it('pauses a single scrape for director choice and applies the selected candidate on retry', () => {
    setupDb()
    const db = getDb()
    classificationMaintenanceService.assignVideoDirector(1, null)
    const firstId = classificationMaintenanceService.createDirector({
      mainName: 'Duplicate Director',
      countryRegion: 'JP',
      birthDate: '1960-01-01'
    })
    const secondId = classificationMaintenanceService.createDirector({
      mainName: 'Ｄｕｐｌｉｃａｔｅ　Ｄｉｒｅｃｔｏｒ',
      countryRegion: 'US',
      birthDate: '1980-01-01'
    })

    const choiceRequired = applyScrapeResult(
      1,
      { code: 'IPX-535', title: 'Deferred title', director: 'Duplicate Director' },
      null,
      new Map(),
      [],
      ['title', 'director'],
      undefined,
      'replaceIfPresent',
      undefined,
      { directorAmbiguity: 'choice' }
    )

    assert.equal(choiceRequired.applied, false)
    assert.deepEqual(
      choiceRequired.directorChoice?.candidates.map((candidate) => candidate.id),
      [firstId, secondId]
    )
    assert.equal(
      (db.prepare('SELECT title FROM videos WHERE id = 1').get() as { title: string }).title,
      'First'
    )

    const selected = applyScrapeResult(
      1,
      { code: 'IPX-535', title: 'Deferred title', director: 'Duplicate Director' },
      null,
      new Map(),
      [],
      ['title', 'director'],
      undefined,
      'replaceIfPresent',
      undefined,
      { directorAmbiguity: 'choice', directorSelectionId: secondId }
    )

    assert.equal(selected.applied, true)
    assert.deepEqual(
      db.prepare('SELECT title, director_id FROM videos WHERE id = 1').get(),
      { title: 'Deferred title', director_id: secondId }
    )
  })

  it('preserves an ambiguous director in batch mode while applying safe fields with an actionable warning', () => {
    setupDb()
    const db = getDb()
    classificationMaintenanceService.assignVideoDirector(1, null)
    classificationMaintenanceService.createDirector({ mainName: 'Batch Duplicate' })
    classificationMaintenanceService.createDirector({ mainName: 'Ｂａｔｃｈ　Ｄｕｐｌｉｃａｔｅ' })

    const outcome = applyScrapeResult(
      1,
      { code: 'IPX-535', title: 'Safe batch title', director: 'Batch Duplicate' },
      null,
      new Map(),
      [],
      ['title', 'director'],
      undefined,
      'replaceIfPresent',
      undefined,
      { directorAmbiguity: 'preserve' }
    )

    assert.equal(outcome.applied, true)
    assert.equal(
      (db.prepare('SELECT title FROM videos WHERE id = 1').get() as { title: string }).title,
      'Safe batch title'
    )
    assert.equal(
      (db.prepare('SELECT director_id FROM videos WHERE id = 1').get() as { director_id: null })
        .director_id,
      null
    )
    assert.match(outcome.warnings[0] ?? '', /已保留现有关联.*手动选择或合并/)
    assert.equal(outcome.classifications[0]?.status, 'ambiguous')
  })

  it('reports an invalid classification name structurally while applying safe fields', () => {
    setupDb()
    const db = getDb()
    const currentDirectorId = (
      db.prepare('SELECT director_id AS id FROM videos WHERE id = 1').get() as { id: number }
    ).id

    const outcome = applyScrapeResult(
      1,
      { code: 'IPX-535', title: 'Safe invalid-name title', director: '\u0085' },
      null,
      new Map(),
      [],
      ['title', 'director'],
      undefined,
      'replaceIfPresent'
    )

    assert.equal(outcome.applied, true)
    assert.deepEqual(
      db.prepare('SELECT title, director_id FROM videos WHERE id = 1').get(),
      { title: 'Safe invalid-name title', director_id: currentDirectorId }
    )
    assert.equal(outcome.classifications[0]?.status, 'invalid')
    assert.match(outcome.classifications[0]?.message ?? '', /导演名称无效/)
    assert.match(outcome.warnings[0] ?? '', /导演名称无效/)
  })

  it('treats same-name series in different owner scopes as ambiguous and never infers an owner', () => {
    setupDb()
    const db = getDb()
    classificationMaintenanceService.assignVideoSeries(1, null)
    const firstOwnerId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'First Series Owner'
    })
    const secondOwnerId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Second Series Owner'
    })
    classificationMaintenanceService.createSeries({
      mainName: 'Scoped Series',
      ownerOrganizationId: firstOwnerId
    })
    classificationMaintenanceService.createSeries({
      mainName: 'Ｓｃｏｐｅｄ　Ｓｅｒｉｅｓ',
      ownerOrganizationId: secondOwnerId
    })

    const ambiguous = applyScrapeResult(
      1,
      { code: 'IPX-535', title: 'Safe series title', series: 'Scoped Series' },
      null,
      new Map(),
      [],
      ['title', 'series'],
      undefined,
      'replaceIfPresent'
    )
    assert.equal(ambiguous.applied, true)
    assert.equal(
      (db.prepare('SELECT series_id FROM videos WHERE id = 1').get() as { series_id: null }).series_id,
      null
    )
    assert.equal(ambiguous.classifications[0]?.status, 'ambiguous')

    const uniqueOwnedSeriesId = classificationMaintenanceService.createSeries({
      mainName: 'Unique Owned Series',
      ownerOrganizationId: firstOwnerId
    })
    const matched = applyScrapeResult(
      1,
      { code: 'IPX-535', series: 'Unique Owned Series' },
      null,
      new Map(),
      [],
      ['series'],
      undefined,
      'replaceIfPresent'
    )
    assert.equal(matched.classifications[0]?.status, 'matched')
    assert.equal(
      (db.prepare('SELECT series_id FROM videos WHERE id = 1').get() as { series_id: number })
        .series_id,
      uniqueOwnedSeriesId
    )
    classificationMaintenanceService.assignVideoSeries(1, null)

    const created = applyScrapeResult(
      1,
      { code: 'IPX-535', series: 'Unowned Scraped Series' },
      null,
      new Map(),
      [],
      ['series'],
      undefined,
      'replaceIfPresent'
    )
    const seriesId = created.classifications[0]?.entityId
    assert.equal(created.classifications[0]?.status, 'created')
    assert.equal(
      (
        db.prepare('SELECT owner_organization_id FROM series WHERE id = ?').get(seriesId) as {
          owner_organization_id: null
        }
      ).owner_organization_id,
      null
    )
  })
})

describe('videoScrapeApplyService.resolveVideoBatchTargets', () => {
  it('keeps active media-library batch targets inside their membership scope', () => {
    setupDb()
    const db = getDb()
    const secondLibrary = createMediaLibrary({ name: 'Second library' })
    ensureVideoMembership({
      libraryId: secondLibrary.id,
      videoId: 1,
      addedVia: 'shared'
    })
    const exclusive = insertTestVideoWithFile(db, {
      code: 'ONLY-002',
      filePath: 'only-second.mp4',
      libraryId: secondLibrary.id,
      scrapedStatus: 0
    })

    assert.deepEqual(
      resolveVideoBatchTargets({ status: 'all', libraryId: 1 }).map((video) => video.id),
      [1, 2]
    )
    assert.deepEqual(
      resolveVideoBatchTargets({ status: 'all', libraryId: secondLibrary.id }).map(
        (video) => video.id
      ),
      [1, exclusive.videoId]
    )
    db.prepare('UPDATE videos SET summary = ? WHERE id = 1').run('Shared summary')
    assert.deepEqual(
      resolveVideoBatchTargets({ status: 0, libraryId: secondLibrary.id }).map(
        (video) => video.id
      ),
      [exclusive.videoId]
    )
    assert.deepEqual(
      resolveVideoBatchTargets({
        status: 'all',
        libraryId: secondLibrary.id,
        missingFields: ['summary']
      }).map((video) => video.id),
      [exclusive.videoId]
    )
    assert.deepEqual(
      resolveVideoBatchTargets({
        status: 'all',
        libraryId: 1,
        videoIds: [1, exclusive.videoId]
      }).map((video) => video.id),
      [1]
    )
  })

  it('returns no targets for an archived media-library scope while preserving global compatibility', () => {
    setupDb()
    const secondLibrary = createMediaLibrary({ name: 'Archived batch library' })
    const exclusive = insertTestVideoWithFile(getDb(), {
      code: 'ARCHIVE-001',
      filePath: 'archived.mp4',
      libraryId: secondLibrary.id
    })

    archiveMediaLibrary({
      libraryId: secondLibrary.id,
      expectedRevision: secondLibrary.revision
    })

    assert.deepEqual(
      resolveVideoBatchTargets({ status: 'all', libraryId: secondLibrary.id }),
      []
    )
    assert.equal(
      resolveVideoBatchTargets({ status: 'all' }).some((video) => video.id === exclusive.videoId),
      true
    )
  })

  it('excludes videos that already have a pending scrape decision', () => {
    setupDb()
    getDb().prepare(
      `INSERT INTO pending_video_scrapes (
         video_id, revision, selected_fields_json, applicable_fields_json,
         update_mode, request_json, warnings_json, created_at, updated_at
       ) VALUES (1, 1, '[]', '[]', 'replace', '{}', '[]', '2026-01-01', '2026-01-01')`
    ).run()

    assert.deepEqual(
      resolveVideoBatchTargets({ status: 'all' }).map((video) => video.id),
      [2]
    )
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

    const targets = resolveVideoBatchTargets({
      status: 'all',
      missingFields: ['summary', 'cover']
    })

    assert.deepEqual(
      targets.map((target) => target.code),
      ['MUKD-501']
    )
    assert.equal(
      resolveVideoBatchTargets({ status: 'all', missingFields: ['summary'] }).length,
      1
    )
  })

  it('combines status and missing-field filters', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE videos SET summary = ? WHERE code = ?').run('Has summary', 'MUKD-501')

    const targets = resolveVideoBatchTargets({
      status: 0,
      missingFields: ['summary', 'publisher']
    })

    assert.deepEqual(
      targets.map((target) => target.code),
      ['MUKD-501']
    )
  })

  it('treats a stored cover path as present even when the file is unreadable', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE videos SET cover_path = ? WHERE id = 1').run('covers/broken.jpg')
    db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)').run('Only Female', 'female')
    const femaleId = Number(
      (db.prepare('SELECT id FROM actresses WHERE main_name = ?').get('Only Female') as { id: number }).id
    )
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (1, ?)').run(femaleId)
    db.prepare(
      "INSERT INTO video_sources (video_id, source, url, fetched_at) VALUES (1, 'JavLibrary', 'https://keep.example', '2024-01-01')"
    ).run()

    assert.deepEqual(
      resolveVideoBatchTargets({
        status: 1,
        missingFields: ['cover', 'actressesMale', 'source'],
        sourceName: 'JavDB'
      }).map((target) => target.code),
      ['IPX-535']
    )
    assert.deepEqual(
      resolveEffectiveScrapeFields(1, ['cover', 'actressesFemale', 'actressesMale'], 'fillEmpty'),
      ['actressesMale']
    )
  })
})

describe('videoScrapeApplyService tags emptiness', () => {
  it('fillEmpty ignores manual tags when deciding whether tags are empty', () => {
    setupDb()
    addManualVideoTag(1, 'CustomOnly')

    const effective = resolveEffectiveScrapeFields(1, ['tags'], 'fillEmpty')
    assert.deepEqual(effective, ['tags'])
  })
})
