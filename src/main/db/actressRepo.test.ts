import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import {
  applyActressScrapeResult,
  clearActressMetadataRecord,
  clearBrokenActressAvatarIfNeeded,
  countActressesForBatchScrape,
  deleteActressGalleryAsset,
  backfillActressGalleryAssetDimensions,
  listActresses,
  listActressesForBatchScrape,
  mergeActresses,
  getActressDetail,
  replaceActressGalleryAssets,
  resolveEffectiveActressScrapeFields,
  setActressPosterPath,
  touchActressLastScrapedAt
} from './actressRepo'

let tempRoot: string | null = null

/** Smallest valid JPEG (1x1) for asset readability checks in tests. */
const MINIMAL_JPEG = Buffer.from(
  'ffd8ffe000104a4649460000010101004800480000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191082242b1c11552d1f0243362728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f007b941100ffd9',
  'hex'
)

function writeTestAvatar(relPath: string): void {
  if (!tempRoot) throw new Error('test root not initialized')
  const abs = path.join(tempRoot, 'media_assets', relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, MINIMAL_JPEG)
}

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-actress-repo-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  writeTestAvatar('avatars/complete.jpg')
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const db = getDb()
  db.prepare(
    `INSERT INTO actresses
      (main_name, avatar_path, birth_date, debut_date, height_cm, bust_cm, waist_cm, hip_cm,
       blood_type, zodiac, nationality, profile_summary, gender)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'Complete',
    'avatars/complete.jpg',
    '1990-01-01',
    '2010-01-01',
    160,
    90,
    60,
    88,
    'A',
    'Aries',
    'Japan',
    'Bio',
    'female'
  )
  db.prepare(
    `INSERT INTO actresses
      (main_name, avatar_path, birth_date, bust_cm, waist_cm, hip_cm, gender)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('Missing Female', null, null, null, 58, 86, 'female')
  db.prepare(
    `INSERT INTO actresses (main_name, gender) VALUES (?, ?)`
  ).run('Missing Male', 'male')
  db.prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)').run(
    'Unknown Gender',
    null
  )
  db.prepare(
    'INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, ?, ?)'
  ).run(1, 'Complete Alias', 'alias', 0)
  db.prepare(
    `INSERT INTO actress_gallery_assets
      (actress_id, type, position, remote_url, local_path, created_at)
     VALUES (?, 'gallery', 0, ?, ?, ?)`
  ).run(1, 'https://example.test/complete.jpg', 'actress_gallery/complete.jpg', 'now')
}

afterEach(() => {
  closeDatabase()
  delete process.env.JAVDEX_TEST_USER_DATA
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('actressRepo.listActresses', () => {
  it('matches main name, alias, and typed names', () => {
    setupDb()
    const db = getDb()
    db.prepare(
      'INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, ?, ?)'
    ).run(1, '完整中文', 'zh', 1)
    db.prepare(
      'INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, ?, ?)'
    ).run(1, 'Complete EN', 'en', 1)
    db.prepare('INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, ?, ?)').run(
      1,
      'Complete Romaji',
      'alias',
      0
    )

    assert.deepEqual(
      listActresses('Complete', 'all').map((a) => a.main_name),
      ['Complete']
    )
    assert.deepEqual(
      listActresses('Alias', 'all').map((a) => a.main_name),
      ['Complete']
    )
    assert.deepEqual(
      listActresses('完整', 'all').map((a) => a.main_name),
      ['Complete']
    )
    assert.deepEqual(
      listActresses('Complete EN', 'all').map((a) => a.main_name),
      ['Complete']
    )
    assert.deepEqual(
      listActresses('Romaji', 'all').map((a) => a.main_name),
      ['Complete']
    )
    assert.deepEqual(listActresses('Missing Female', 'all').map((a) => a.main_name), [
      'Missing Female'
    ])
  })

  it('sorts by video count descending by default', () => {
    setupDb()
    const db = getDb()
    db.prepare('INSERT INTO videos (code, title, file_path, add_time) VALUES (?, ?, ?, ?)').run(
      'A-001',
      'A',
      'a.mp4',
      '2024-01-01'
    )
    db.prepare('INSERT INTO videos (code, title, file_path, add_time) VALUES (?, ?, ?, ?)').run(
      'B-001',
      'B',
      'b.mp4',
      '2024-01-02'
    )
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, 1)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(2, 1)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, 2)

    const sorted = listActresses(undefined, 'all', 'video_count', 'desc')
    assert.equal(sorted[0]?.main_name, 'Complete')
    assert.equal(sorted[0]?.video_count, 2)
    assert.equal(sorted.find((a) => a.main_name === 'Missing Female')?.video_count, 1)
  })
})

describe('actressRepo.clearActressMetadataRecord', () => {
  it('clears scraped profile fields while keeping main name and video links', () => {
    setupDb()
    const db = getDb()
    db.prepare('INSERT INTO videos (code, title, file_path, add_time) VALUES (?, ?, ?, ?)').run(
      'CLR-001',
      'Test',
      'clr.mp4',
      '2024-01-01'
    )
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, 1)

    clearActressMetadataRecord(1)

    const row = db.prepare('SELECT * FROM actresses WHERE id = 1').get() as Record<string, unknown>
    assert.equal(row.main_name, 'Complete')
    assert.equal(row.birth_date, null)
    assert.equal(row.avatar_path, null)
    assert.equal(row.profile_summary, null)
    const aliases = db
      .prepare("SELECT name FROM actress_names WHERE actress_id = 1 AND type != 'main'")
      .all() as { name: string }[]
    assert.equal(aliases.length, 0)
    const links = db
      .prepare('SELECT COUNT(*) AS c FROM video_actress WHERE actress_id = 1')
      .get() as { c: number }
    assert.equal(links.c, 1)
  })
})

describe('actressRepo.mergeActresses', () => {
  it('merges videos, aliases, and gallery into the keeper', () => {
    setupDb()
    const db = getDb()
    db.prepare('INSERT INTO videos (code, title, file_path, add_time) VALUES (?, ?, ?, ?)').run(
      'MERGE-001',
      'Keeper Video',
      'keeper.mp4',
      '2024-01-01'
    )
    db.prepare('INSERT INTO videos (code, title, file_path, add_time) VALUES (?, ?, ?, ?)').run(
      'MERGE-002',
      'Merge Video',
      'merge.mp4',
      '2024-01-02'
    )
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, 1)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(2, 2)
    db.prepare(
      'INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, ?, ?)'
    ).run(2, 'Missing Alias', 'alias', 0)
    db.prepare(
      `INSERT INTO actress_gallery_assets
        (actress_id, type, position, remote_url, local_path, created_at)
       VALUES (?, 'gallery', 0, ?, ?, ?)`
    ).run(2, 'https://example.test/missing.jpg', 'actress_gallery/missing.jpg', 'now')

    mergeActresses(1, 2, 'keep')

    const detail = getActressDetail(1)
    assert.ok(detail)
    assert.equal(detail.videos.length, 2)
    assert.ok(detail.aliases.includes('Missing Female'))
    assert.ok(detail.aliases.includes('Missing Alias'))
    assert.equal(detail.gallery.length, 2)
    assert.equal(db.prepare('SELECT id FROM actresses WHERE id = 2').get(), undefined)
  })

  it('rejects merging actresses with different genders', () => {
    setupDb()
    const db = getDb()
    const male = db.prepare('SELECT id FROM actresses WHERE main_name = ?').get('Missing Male') as {
      id: number
    }
    assert.throws(() => mergeActresses(1, male.id, 'keep'), /不能合并不同性别/)
  })

  it('can adopt the merged actress main name', () => {
    setupDb()
    mergeActresses(1, 2, 'merge')
    const detail = getActressDetail(1)
    assert.ok(detail)
    assert.equal(detail.main_name, 'Missing Female')
    assert.ok(detail.aliases.includes('Complete'))
  })
})

describe('actressRepo.listActressesForBatchScrape', () => {
  it('filters by scope and missing fields', () => {
    setupDb()

    const targets = listActressesForBatchScrape({
      scope: 'female',
      missingFields: ['avatar']
    })

    assert.deepEqual(
      targets.map((target) => target.main_name),
      ['Missing Female', 'Unknown Gender']
    )
    assert.equal(countActressesForBatchScrape({ scope: 'male', missingFields: [] }), 1)
  })

  it('filters never-scraped actresses by scrape status', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE actresses SET last_scraped_at = ? WHERE main_name = ?').run(
      '2024-01-01T00:00:00.000Z',
      'Complete'
    )
    db.prepare('UPDATE actresses SET last_scraped_at = ? WHERE main_name = ?').run(
      '2024-01-01T00:00:00.000Z',
      'Missing Male'
    )

    const targets = listActressesForBatchScrape({ scope: 'all', scrapeStatus: 'unscraped' })

    assert.deepEqual(
      targets.map((target) => target.main_name).sort(),
      ['Missing Female', 'Unknown Gender']
    )
    assert.equal(countActressesForBatchScrape({ scope: 'all', scrapeStatus: 'unscraped' }), 2)
  })

  it('combines gender and scrape status filters', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE actresses SET last_scraped_at = ? WHERE main_name = ?').run(
      '2024-01-01T00:00:00.000Z',
      'Complete'
    )

    const targets = listActressesForBatchScrape({ scope: 'female', scrapeStatus: 'unscraped' })

    assert.deepEqual(
      targets.map((target) => target.main_name).sort(),
      ['Missing Female', 'Unknown Gender']
    )
    assert.equal(
      countActressesForBatchScrape({ scope: 'female', scrapeStatus: 'scraped' }),
      1
    )
  })

  it('matches actresses missing any selected profile field', () => {
    setupDb()

    const targets = listActressesForBatchScrape({
      scope: 'all',
      missingFields: ['birthDate', 'measurements']
    })

    assert.deepEqual(
      targets.map((target) => target.main_name),
      ['Missing Female', 'Missing Male', 'Unknown Gender']
    )
  })
})

describe('actressRepo.resolveEffectiveActressScrapeFields', () => {
  it('fillEmpty keeps only currently missing fields', () => {
    setupDb()

    assert.deepEqual(
      resolveEffectiveActressScrapeFields(
        1,
        [
          'avatar',
          'gallery',
          'birthDate',
          'debutDate',
          'heightCm',
          'measurements',
          'bloodType',
          'zodiac',
          'nationality',
          'profileSummary',
          'aliases'
        ],
        'fillEmpty'
      ),
      []
    )
    assert.deepEqual(
      resolveEffectiveActressScrapeFields(
        2,
        [
          'avatar',
          'gallery',
          'birthDate',
          'heightCm',
          'measurements',
          'aliases'
        ],
        'fillEmpty'
      ),
      ['avatar', 'gallery', 'birthDate', 'heightCm', 'measurements', 'aliases']
    )
  })

  it('fillEmpty treats broken avatar files as missing and clears the stored path', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE actresses SET avatar_path = ? WHERE id = ?').run('avatars/missing.jpg', 1)

    assert.deepEqual(
      resolveEffectiveActressScrapeFields(1, ['avatar', 'birthDate'], 'fillEmpty'),
      ['avatar']
    )
    assert.deepEqual(db.prepare('SELECT avatar_path FROM actresses WHERE id = ?').get(1), {
      avatar_path: null
    })
  })
})

describe('actressRepo.clearBrokenActressAvatarIfNeeded', () => {
  it('includes broken avatars in batch missing-avatar targets', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE actresses SET avatar_path = ? WHERE id = ?').run('avatars/missing.jpg', 1)

    assert.equal(clearBrokenActressAvatarIfNeeded(1), true)
    assert.deepEqual(db.prepare('SELECT avatar_path FROM actresses WHERE id = ?').get(1), {
      avatar_path: null
    })
    assert.equal(
      countActressesForBatchScrape({ scope: 'female', missingFields: ['avatar'] }),
      3
    )
    assert.deepEqual(
      listActressesForBatchScrape({ scope: 'female', missingFields: ['avatar'] }).map(
        (row) => row.main_name
      ),
      ['Complete', 'Missing Female', 'Unknown Gender']
    )
  })
})

describe('actressRepo.backfillActressGalleryAssetDimensions', () => {
  it('probes stored local files and fills missing gallery dimensions', () => {
    setupDb()
    const db = getDb()
    writeTestAvatar('actress_gallery/landscape.jpg')
    db.prepare(
      `INSERT INTO actress_gallery_assets
         (actress_id, type, position, remote_url, local_path, width, height, created_at)
       VALUES (1, 'gallery', 1, ?, ?, NULL, NULL, ?)`
    ).run('https://example.test/landscape.jpg', 'actress_gallery/landscape.jpg', 'now')

    assert.equal(backfillActressGalleryAssetDimensions(db, 1), 1)

    const row = db
      .prepare('SELECT width, height FROM actress_gallery_assets WHERE local_path = ?')
      .get('actress_gallery/landscape.jpg') as { width: number; height: number }
    assert.ok(row.width > 0)
    assert.ok(row.height > 0)
  })
})

describe('actressRepo.posterPath', () => {
  it('clears the poster when the referenced gallery image is deleted', () => {
    setupDb()
    const db = getDb()
    const asset = db
      .prepare('SELECT id FROM actress_gallery_assets WHERE actress_id = ?')
      .get(1) as { id: number }

    setActressPosterPath(1, 'actress_gallery/complete.jpg')
    deleteActressGalleryAsset(1, asset.id)

    assert.deepEqual(db.prepare('SELECT poster_path FROM actresses WHERE id = ?').get(1), {
      poster_path: null
    })
  })
})

describe('actressRepo.replaceActressGalleryAssets', () => {
  it('keeps local paths that remain in the replaced asset set', () => {
    setupDb()
    const db = getDb()
    db.prepare(
      `INSERT INTO actress_gallery_assets
         (actress_id, type, position, remote_url, local_path, created_at)
       VALUES (?, 'gallery', 0, ?, ?, ?)`
    ).run(1, 'https://example.test/keep.jpg', 'actress_gallery/keep.jpg', 'now')

    replaceActressGalleryAssets(1, [
      { remoteUrl: 'https://example.test/keep.jpg', localPath: 'actress_gallery/keep.jpg' },
      { remoteUrl: 'https://example.test/new.jpg', localPath: 'actress_gallery/new.jpg' }
    ])

    assert.deepEqual(
      db
        .prepare(
          'SELECT local_path FROM actress_gallery_assets WHERE actress_id = ? ORDER BY position'
        )
        .all(1)
        .map((row) => (row as { local_path: string }).local_path),
      ['actress_gallery/keep.jpg', 'actress_gallery/new.jpg']
    )
  })
})

describe('actressRepo.touchActressLastScrapedAt', () => {
  it('updates last_scraped_at without changing profile fields', () => {
    setupDb()
    touchActressLastScrapedAt(2)
    const row = getDb().prepare('SELECT last_scraped_at, birth_date FROM actresses WHERE id = ?').get(2) as {
      last_scraped_at: string | null
      birth_date: string | null
    }
    assert.ok(row.last_scraped_at)
    assert.equal(row.birth_date, null)
  })
})

describe('actressRepo.applyActressScrapeResult', () => {
  it('fillEmpty preserves existing measurement values while filling missing ones', () => {
    setupDb()
    const { applied } = applyActressScrapeResult(
      2,
      {
        birthDate: '2000-02-03',
        bustCm: 88,
        waistCm: 55,
        hipCm: 80,
        profileSummary: 'Filled bio'
      },
      null,
      [],
      ['birthDate', 'measurements', 'profileSummary'],
      'fillEmpty'
    )

    assert.equal(applied, true)
    const row = getDb().prepare('SELECT * FROM actresses WHERE id = ?').get(2) as {
      birth_date: string | null
      bust_cm: number | null
      waist_cm: number | null
      hip_cm: number | null
      profile_summary: string | null
    }
    assert.equal(row.birth_date, '2000-02-03')
    assert.equal(row.bust_cm, 88)
    assert.equal(row.waist_cm, 58)
    assert.equal(row.hip_cm, 86)
    assert.equal(row.profile_summary, 'Filled bio')
  })

  it('replaceIfPresent updates existing profile values while preserving null scrape results', () => {
    setupDb()
    const { applied } = applyActressScrapeResult(
      1,
      {
        birthDate: '1995-03-04',
        profileSummary: undefined
      },
      null,
      [],
      ['birthDate', 'profileSummary'],
      'replaceIfPresent'
    )

    assert.equal(applied, true)
    const row = getDb().prepare('SELECT birth_date, profile_summary FROM actresses WHERE id = ?').get(1) as {
      birth_date: string | null
      profile_summary: string | null
    }
    assert.equal(row.birth_date, '1995-03-04')
    assert.equal(row.profile_summary, 'Bio')
  })

  it('skips conflicting aliases and applies other scrape fields', () => {
    setupDb()
    const { applied, warnings } = applyActressScrapeResult(
      2,
      {
        birthDate: '1995-03-04',
        aliases: ['Complete Alias', 'Safe Alias']
      },
      null,
      [],
      ['birthDate', 'aliases'],
      'replace'
    )

    assert.equal(applied, true)
    assert.deepEqual(warnings, ['别名「Complete Alias」已被其他演员使用，已跳过'])

    const row = getDb().prepare('SELECT birth_date FROM actresses WHERE id = ?').get(2) as {
      birth_date: string | null
    }
    assert.equal(row.birth_date, '1995-03-04')

    const aliases = getDb()
      .prepare("SELECT name FROM actress_names WHERE actress_id = ? AND type = 'alias' ORDER BY name")
      .all(2) as { name: string }[]
    assert.deepEqual(
      aliases.map((item) => item.name),
      ['Safe Alias']
    )
  })
})
