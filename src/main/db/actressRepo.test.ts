import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAvatarCropV1, parseAvatarCrop } from '@shared/avatarCrop'
import type { ScrapedStatus } from '@shared/commonTypes'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { insertTestVideoWithFile } from './testVideoFixtures'
import {
  addActressGalleryAsset,
  clearActressMetadataRecord,
  countActressesForBatchScrape,
  deleteActressGalleryAsset,
  deleteUnlinkedActressRecords,
  deleteUnlinkedActresses,
  backfillActressGalleryAssetDimensions,
  findActressByNameOrAlias,
  listActresses,
  listActressesForBatchScrape,
  listActressAvatarCandidates,
  listActressPage,
  markActressScrapeSucceeded,
  getActressDetail,
  replaceActressGalleryAssets,
  recordActressScrapeFailure,
  resolveEffectiveActressScrapeFields,
  setActressPosterPath,
} from './actressRepo'
import {
  applyActressScrapeResult,
  clearBrokenActressAvatarIfNeeded,
  editActressWithAssets as editActress,
  getActressAvatarSourceInfo,
  mergeActressesWithAssets as mergeActresses,
  planActressScrapeResult,
  setActressAvatarBundle,
  upsertActressFromScrapeWithAssets as upsertActressFromScrape
} from '../services/actressAssetService'
import { mediaAssetStore } from '../services/mediaAssetStore'
import { findActressIdByOwnedName } from './actressNameOwnership'

let tempRoot: string | null = null

/** Smallest valid JPEG (1x1) for asset readability checks in tests. */
const MINIMAL_JPEG = Buffer.from(
  'ffd8ffe000104a4649460000010101004800480000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191082242b1c11552d1f0243362728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f007b941100ffd9',
  'hex'
)

/** Recognized WebP container whose dimensions are intentionally unavailable to nativeImage. */
const WEBP_CONTAINER = Buffer.from(
  '524946461600000057454250565038580a0000000000000000000000000000',
  'hex'
)

function writeTestAvatar(relPath: string): void {
  if (!tempRoot) throw new Error('test root not initialized')
  const abs = path.join(tempRoot, 'media_assets', relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, MINIMAL_JPEG)
}

function writeTestAsset(relPath: string, data: Buffer | string): void {
  if (!tempRoot) throw new Error('test root not initialized')
  const abs = path.join(tempRoot, 'media_assets', relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, data)
}

function assetExists(relPath: string | null): boolean {
  if (!tempRoot || !relPath) return false
  return fs.existsSync(path.join(tempRoot, 'media_assets', relPath))
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
  const insertName = db.prepare(
    "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'main', 1)"
  )
  const insertOwnership = db.prepare(
    'INSERT INTO actress_name_ownership (normalized_name, actress_id) VALUES (?, ?)'
  )
  for (const [id, name, normalizedName] of [
    [1, 'Complete', 'complete'],
    [2, 'Missing Female', 'missingfemale'],
    [3, 'Missing Male', 'missingmale'],
    [4, 'Unknown Gender', 'unknowngender']
  ] as const) {
    insertName.run(id, name)
    insertOwnership.run(normalizedName, id)
  }
  insertOwnership.run('completealias', 1)
  db.prepare(
    `INSERT INTO actress_gallery_assets
      (actress_id, type, position, remote_url, local_path, created_at)
     VALUES (?, 'gallery', 0, ?, ?, ?)`
  ).run(1, 'https://example.test/complete.jpg', 'actress_gallery/complete.jpg', 'now')
}

function setActressScrapeRecord(
  id: number,
  status: ScrapedStatus,
  lastScrapedAt: string | null
): void {
  getDb()
    .prepare('UPDATE actresses SET scraped_status = ?, last_scraped_at = ? WHERE id = ?')
    .run(status, lastScrapedAt, id)
}

const ACTRESS_SCRAPE_STATUS_LABEL: Record<ScrapedStatus, string> = {
  0: '未刮削',
  1: '刮削成功',
  2: '刮削失败'
}

const KEEPER_SUCCESS_TIME = '2023-03-03T00:00:00.000Z'
const MERGED_SUCCESS_TIME = '2024-04-04T00:00:00.000Z'

/** Every pairing of cumulative states, with the history the keeper must end up with. */
const MERGE_SCRAPE_STATUS_MATRIX: Array<{
  keep: ScrapedStatus
  merge: ScrapedStatus
  status: ScrapedStatus
  lastScrapedAt: string | null
}> = [
  { keep: 0, merge: 0, status: 0, lastScrapedAt: null },
  { keep: 0, merge: 2, status: 2, lastScrapedAt: null },
  { keep: 0, merge: 1, status: 1, lastScrapedAt: MERGED_SUCCESS_TIME },
  { keep: 2, merge: 0, status: 2, lastScrapedAt: null },
  { keep: 2, merge: 2, status: 2, lastScrapedAt: null },
  { keep: 2, merge: 1, status: 1, lastScrapedAt: MERGED_SUCCESS_TIME },
  { keep: 1, merge: 0, status: 1, lastScrapedAt: KEEPER_SUCCESS_TIME },
  { keep: 1, merge: 2, status: 1, lastScrapedAt: KEEPER_SUCCESS_TIME },
  { keep: 1, merge: 1, status: 1, lastScrapedAt: MERGED_SUCCESS_TIME }
]

afterEach(() => {
  closeDatabase()
  delete process.env.JAVDEX_TEST_USER_DATA
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('actressRepo actress name ownership', () => {
  it('changes the main-name row and ownership together when an actress is renamed', () => {
    setupDb()
    const db = getDb()
    editActress(1, { main_name: 'Renamed Complete' })

    assert.equal(findActressIdByOwnedName('Renamed Complete'), 1)
    assert.equal(findActressIdByOwnedName('Complete'), null)
    assert.deepEqual(
      db
        .prepare("SELECT name, is_primary FROM actress_names WHERE actress_id = 1 AND type = 'main'")
        .all(),
      [{ name: 'Renamed Complete', is_primary: 1 }]
    )
  })

  it('keeps ownership while another name type still declares the same normalized name', () => {
    setupDb()

    editActress(1, {
      name_zh: 'Shared Name',
      aliases: ['Ｓｈａｒｅｄ　Ｎａｍｅ']
    })
    editActress(1, { name_zh: null })

    assert.equal(findActressIdByOwnedName('shared name'), 1)

    editActress(1, { aliases: [] })

    assert.equal(findActressIdByOwnedName('shared name'), null)
  })

  it('rolls back the complete manual edit when any declared name has another owner', () => {
    setupDb()

    assert.throws(
      () =>
        editActress(1, {
          main_name: 'Changed Before Conflict',
          birth_date: '2001-02-03',
          name_en: 'Ｍｉｓｓｉｎｇ　Ｆｅｍａｌｅ'
        }),
      /已被其他演员使用/
    )

    const actress = getDb()
      .prepare('SELECT main_name, birth_date FROM actresses WHERE id = 1')
      .get() as { main_name: string; birth_date: string | null }
    assert.deepEqual(actress, { main_name: 'Complete', birth_date: '1990-01-01' })
    assert.equal(findActressIdByOwnedName('Complete'), 1)
    assert.equal(findActressIdByOwnedName('Changed Before Conflict'), null)
  })

  it('rolls back profile changes and compensates new avatar files when the database write fails', () => {
    setupDb()
    const db = getDb()
    db.exec(`
      CREATE TRIGGER fail_avatar_update
      BEFORE UPDATE OF avatar_path ON actresses
      BEGIN
        SELECT RAISE(ABORT, 'forced avatar failure');
      END
    `)

    assert.throws(
      () => editActress(1, {
        birth_date: '1999-01-01',
        avatarImageBase64: MINIMAL_JPEG.toString('base64')
      }),
      /forced avatar failure/
    )

    const row = db.prepare(
      'SELECT birth_date, avatar_path, avatar_source_path FROM actresses WHERE id = 1'
    ).get() as { birth_date: string | null; avatar_path: string | null; avatar_source_path: string | null }
    assert.equal(row.birth_date, '1990-01-01')
    assert.equal(row.avatar_path, 'avatars/complete.jpg')
    assert.equal(row.avatar_source_path, null)
    const sourceDir = path.join(tempRoot!, 'media_assets', 'avatar_sources')
    assert.deepEqual(fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir) : [], [])
  })
})

describe('actressRepo.listActresses', () => {
  it('excludes migrated pending names from search and exact identity lookup', () => {
    setupDb()
    const db = getDb()
    const insertName = db.prepare(
      "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'alias', 0)"
    )
    insertName.run(2, 'Ambiguous Migrated Name')
    insertName.run(3, 'Ａｍｂｉｇｕｏｕｓ　Ｍｉｇｒａｔｅｄ　Ｎａｍｅ')
    const insertClaim = db.prepare(
      `INSERT INTO pending_actress_name_claims
        (normalized_name, actress_id, name, type, is_primary)
       VALUES (?, ?, ?, 'alias', 0)`
    )
    insertClaim.run('ambiguousmigratedname', 2, 'Ambiguous Migrated Name')
    insertClaim.run('ambiguousmigratedname', 3, 'Ａｍｂｉｇｕｏｕｓ　Ｍｉｇｒａｔｅｄ　Ｎａｍｅ')

    assert.deepEqual(listActresses('Ambiguous Migrated', 'all'), [])
    assert.equal(findActressByNameOrAlias('ambiguous migrated name'), null)
  })

  it('does not match a replaced main name that is not kept as an explicit alias', () => {
    setupDb()
    const actressId = upsertActressFromScrape('Former (Name)', null)
    editActress(actressId, { main_name: 'Current Name' })

    assert.deepEqual(
      listActresses('(', 'all').map((actress) => actress.main_name),
      []
    )

    const db = getDb()
    const mainNames = db
      .prepare("SELECT name, is_primary FROM actress_names WHERE actress_id = ? AND type = 'main'")
      .all(actressId)
    assert.deepEqual(mainNames, [{ name: 'Current Name', is_primary: 1 }])
  })

  it('matches main name, alias, and typed names', () => {
    setupDb()
    editActress(1, {
      name_zh: '完整中文',
      name_en: 'Complete EN',
      aliases: ['Complete Alias', 'Complete Romaji']
    })

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

  it('treats SQL LIKE metacharacters as literal search text', () => {
    setupDb()
    upsertActressFromScrape('Percent % Name', null)
    const aliasActressId = upsertActressFromScrape('Alias Holder', null)
    const englishNameActressId = upsertActressFromScrape('English Name Holder', null)
    editActress(aliasActressId, { aliases: ['Under_score'] })
    editActress(englishNameActressId, { name_en: String.raw`Back\slash` })

    assert.deepEqual(
      listActresses('%', 'all').map((actress) => actress.main_name),
      ['Percent % Name']
    )
    assert.deepEqual(
      listActresses('_', 'all').map((actress) => actress.main_name),
      ['Alias Holder']
    )
    assert.deepEqual(
      listActresses('\\', 'all').map((actress) => actress.main_name),
      ['English Name Holder']
    )
  })

  it('ignores stored names that are not visible name types', () => {
    setupDb()
    const db = getDb()
    db.prepare(
      'INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, ?, ?)'
    ).run(1, 'Invisible Historical Name', 'historical', 0)

    assert.deepEqual(listActresses('Invisible', 'all'), [])
  })

  it('sorts by video count descending by default', () => {
    setupDb()
    const db = getDb()
    insertTestVideoWithFile(db, { code: 'A-001', filePath: 'a.mp4', title: 'A', addTime: '2024-01-01' })
    insertTestVideoWithFile(db, { code: 'B-001', filePath: 'b.mp4', title: 'B', addTime: '2024-01-02' })
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, 1)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(2, 1)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, 2)

    const sorted = listActresses(undefined, 'all', 'video_count', 'desc')
    assert.equal(sorted[0]?.main_name, 'Complete')
    assert.equal(sorted[0]?.video_count, 2)
    assert.equal(sorted.find((a) => a.main_name === 'Missing Female')?.video_count, 1)
  })
})

describe('actressRepo.listActressPage', () => {
  /** Complete: success, Missing Female: failed, Missing Male: success, Unknown Gender: unscraped. */
  function setupStatuses(): void {
    setupDb()
    const update = getDb().prepare('UPDATE actresses SET scraped_status = ? WHERE id = ?')
    update.run(1, 1)
    update.run(2, 2)
    update.run(1, 3)
  }

  it('returns a stable slice with the total number of matching actresses', () => {
    setupDb()

    const first = listActressPage({ gender: 'all', limit: 2, offset: 0 })
    const second = listActressPage({ gender: 'all', limit: 2, offset: 2 })

    assert.equal(first.total, 4)
    assert.equal(second.total, 4)
    assert.deepEqual(
      [...first.items, ...second.items].map((item) => item.main_name),
      ['Complete', 'Missing Female', 'Missing Male', 'Unknown Gender']
    )
  })

  it('pages an explicit renderer-session actress subset with complete totals', () => {
    setupStatuses()

    const page = listActressPage({
      gender: 'all',
      actressIds: [4, 2],
      limit: 1,
      offset: 0
    })

    assert.equal(page.total, 2)
    assert.deepEqual(page.items.map((item) => item.main_name), ['Missing Female'])
    assert.deepEqual(page.statusCounts, { all: 2, success: 0, unscraped: 1, failed: 1 })
    assert.equal(listActressPage({ gender: 'all', actressIds: [] }).total, 0)
  })

  it('returns the cumulative status of every actress with per-status counts', () => {
    setupStatuses()

    const page = listActressPage({ gender: 'all' })

    assert.deepEqual(
      page.items.map((item) => [item.main_name, item.scraped_status]),
      [
        ['Complete', 1],
        ['Missing Female', 2],
        ['Missing Male', 1],
        ['Unknown Gender', 0]
      ]
    )
    assert.deepEqual(page.statusCounts, { all: 4, success: 2, unscraped: 1, failed: 1 })
  })

  it('filters by each status while keeping the counts of the unfiltered scope', () => {
    setupStatuses()

    const success = listActressPage({ gender: 'all', status: 'success' })
    const unscraped = listActressPage({ gender: 'all', status: 'unscraped' })
    const failed = listActressPage({ gender: 'all', status: 'failed' })

    assert.deepEqual(success.items.map((item) => item.main_name), ['Complete', 'Missing Male'])
    assert.deepEqual(unscraped.items.map((item) => item.main_name), ['Unknown Gender'])
    assert.deepEqual(failed.items.map((item) => item.main_name), ['Missing Female'])
    assert.deepEqual(failed.statusCounts, success.statusCounts)
  })

  it('combines the status filter with search, gender and sort', () => {
    setupStatuses()
    const db = getDb()
    insertTestVideoWithFile(db, { code: 'A-001', filePath: 'a.mp4', title: 'A', addTime: '2024-01-01' })
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, 2)
    db.prepare('UPDATE actresses SET scraped_status = 1 WHERE id = 4').run()

    assert.deepEqual(
      listActressPage({ search: 'Missing', gender: 'all', status: 'success' }).items.map(
        (item) => item.main_name
      ),
      ['Missing Male']
    )
    assert.deepEqual(
      listActressPage({ gender: 'female', status: 'failed' }).items.map((item) => [
        item.main_name,
        item.video_count
      ]),
      [['Missing Female', 1]]
    )
    assert.deepEqual(
      listActressPage({ gender: 'all', status: 'success', sortBy: 'video_count', sortDir: 'asc' })
        .items.map((item) => item.main_name),
      ['Complete', 'Missing Male', 'Unknown Gender']
    )
  })

  it('counts statuses within the current search and gender scope', () => {
    setupStatuses()

    assert.deepEqual(listActressPage({ gender: 'female' }).statusCounts, {
      all: 2,
      success: 1,
      unscraped: 0,
      failed: 1
    })
    assert.deepEqual(listActressPage({ search: 'Missing', gender: 'all' }).statusCounts, {
      all: 2,
      success: 1,
      unscraped: 0,
      failed: 1
    })
  })

  it('treats a missing status as all statuses', () => {
    setupStatuses()

    assert.deepEqual(
      listActressPage({ gender: 'all', status: 'all' }).items.map((item) => item.main_name),
      listActressPage({ gender: 'all' }).items.map((item) => item.main_name)
    )
  })

  it('keeps avatar file health outside the pure database query', () => {
    setupStatuses()
    const db = getDb()
    db.prepare('UPDATE actresses SET avatar_path = ? WHERE id = ?').run(
      'avatars/missing.jpg',
      2
    )

    const allNames = listActressPage({ gender: 'all', avatar: 'with' }).items.map(
      (item) => item.main_name
    )
    assert.deepEqual(
      allNames,
      listActressPage({ gender: 'all', avatar: 'without' }).items.map(
        (item) => item.main_name
      )
    )
    assert.deepEqual(
      listActressPage({ gender: 'all', avatar: 'without-face', actressIds: [1] }).items.map(
        (item) => item.main_name
      ),
      ['Complete']
    )
    assert.equal(listActressPage({ gender: 'all', avatar: 'without-face' }).total, 0)
    assert.equal(allNames.length, 4)
  })

  it('does not derive avatar fingerprints during a database list query', () => {
    setupStatuses()
    assert.equal(listActressPage({ gender: 'all' }).items[0]?.avatar_fingerprint, undefined)
  })

  it('returns minimal avatar path candidates without inspecting files', () => {
    setupStatuses()
    getDb().prepare('UPDATE actresses SET avatar_path = ? WHERE id = ?').run(
      'avatars/missing.jpg',
      2
    )

    const manifest = listActressAvatarCandidates()

    assert.deepEqual(manifest, [
      {
        id: 1,
        main_name: 'Complete',
        avatar_path: 'avatars/complete.jpg'
      },
      {
        id: 2,
        main_name: 'Missing Female',
        avatar_path: 'avatars/missing.jpg'
      }
    ])
    assert.deepEqual(Object.keys(manifest[0] ?? {}).sort(), [
      'avatar_path',
      'id',
      'main_name'
    ])
  })
})

describe('actressRepo.clearActressMetadataRecord', () => {
  it('clears scraped profile fields while keeping main name and video links', () => {
    setupDb()
    const db = getDb()
    insertTestVideoWithFile(db, {
      code: 'CLR-001',
      filePath: 'clr.mp4',
      title: 'Test',
      addTime: '2024-01-01'
    })
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

  it('clears non-name metadata without claiming a migrated pending main name', () => {
    setupDb()
    const db = getDb()
    db.prepare(
      "DELETE FROM actress_name_ownership WHERE normalized_name IN ('complete', 'missingfemale')"
    ).run()
    db.prepare('UPDATE actresses SET main_name = ? WHERE id = 2').run('Ｃｏｍｐｌｅｔｅ')
    db.prepare("UPDATE actress_names SET name = ? WHERE actress_id = 2 AND type = 'main'").run(
      'Ｃｏｍｐｌｅｔｅ'
    )
    const insertClaim = db.prepare(
      `INSERT INTO pending_actress_name_claims
        (normalized_name, actress_id, name, type, is_primary)
       VALUES ('complete', ?, ?, 'main', 1)`
    )
    insertClaim.run(1, 'Complete')
    insertClaim.run(2, 'Ｃｏｍｐｌｅｔｅ')

    clearActressMetadataRecord(1)

    assert.equal(findActressIdByOwnedName('Complete'), null)
    assert.equal(findActressIdByOwnedName('Complete Alias'), null)
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM pending_actress_name_claims').get() as { n: number }).n,
      2
    )
    assert.equal(getActressDetail(1)?.avatar_path, null)
  })

  it('resets every cumulative state to unscraped and drops the success time', () => {
    setupDb()
    markActressScrapeSucceeded(1)
    recordActressScrapeFailure(2)

    clearActressMetadataRecord(1)
    clearActressMetadataRecord(2)
    clearActressMetadataRecord(3)

    for (const id of [1, 2, 3]) {
      const detail = getActressDetail(id)
      assert.equal(detail?.scraped_status, 0)
      assert.equal(detail?.last_scraped_at, null)
    }
  })

  it('keeps related links when clearing actress metadata', () => {
    setupDb()
    editActress(1, { links: [{ label: 'Wiki', url: 'https://example.com/actress' }] })

    clearActressMetadataRecord(1)

    assert.equal(getActressDetail(1)?.profile_summary, null)
    assert.deepEqual(getActressDetail(1)?.links.map((link) => link.label), ['Wiki'])
  })
})

describe('actress related links', () => {
  it('stores related links on an actress and returns them on detail', () => {
    setupDb()
    editActress(1, {
      links: [
        { label: '', url: 'https://example.com/wiki' },
        { label: 'Forum', url: 'https://forum.example/thread' },
        { label: 'Dup', url: 'https://example.com/wiki#section' }
      ]
    })

    assert.deepEqual(
      getActressDetail(1)?.links.map((link) => [link.label, link.url, link.position]),
      [
        ['example.com', 'https://example.com/wiki', 0],
        ['Forum', 'https://forum.example/thread', 1]
      ]
    )
  })

  it('unions related links on merge with the keeper first', () => {
    setupDb()
    editActress(1, {
      links: [
        { label: '百科', url: 'https://example.com/wiki' },
        { label: 'Keep', url: 'https://example.com/keep' }
      ]
    })
    editActress(2, {
      links: [
        { label: 'Wiki', url: 'https://example.com/wiki#source' },
        { label: 'Forum', url: 'https://forum.example/thread' }
      ]
    })

    mergeActresses(1, 2, 'keep')

    assert.deepEqual(
      getActressDetail(1)?.links.map((link) => [link.label, link.url]),
      [
        ['百科', 'https://example.com/wiki'],
        ['Keep', 'https://example.com/keep'],
        ['Forum', 'https://forum.example/thread']
      ]
    )
  })
})

describe('actressRepo.deleteUnlinkedActresses', () => {
  it('deletes every selected unlinked actress and returns its stored assets for cleanup', () => {
    setupDb()
    writeTestAsset('actress_gallery/complete.jpg', MINIMAL_JPEG)

    const result = deleteUnlinkedActressRecords([1, 2, 2])
    assert.equal(result.deletedCount, 2)
    assert.equal(getActressDetail(1), null)
    assert.equal(getActressDetail(2), null)
    assert.ok(result.assetPaths.includes('avatars/complete.jpg'))
    assert.ok(result.assetPaths.includes('actress_gallery/complete.jpg'))
    assert.equal(assetExists('avatars/complete.jpg'), true)
  })

  it('rejects the whole batch when any selected actress still has a linked video', () => {
    setupDb()
    const db = getDb()
    insertTestVideoWithFile(db, {
      code: 'DELETE-001',
      filePath: 'delete.mp4',
      title: 'Linked',
      addTime: '2024-01-01'
    })
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, 1)

    assert.throws(() => deleteUnlinkedActresses([1, 2]), /1 位演员仍有关联影片/)
    assert.ok(getActressDetail(1))
    assert.ok(getActressDetail(2))
  })
})

describe('actressRepo.mergeActresses', () => {
  it('merges videos, aliases, and gallery into the keeper', () => {
    setupDb()
    const db = getDb()
    insertTestVideoWithFile(db, {
      code: 'MERGE-001',
      filePath: 'keeper.mp4',
      title: 'Keeper Video',
      addTime: '2024-01-01'
    })
    insertTestVideoWithFile(db, {
      code: 'MERGE-002',
      filePath: 'merge.mp4',
      title: 'Merge Video',
      addTime: '2024-01-02'
    })
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, 1)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(2, 2)
    db.prepare(
      'INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, ?, ?)'
    ).run(2, 'Missing Alias', 'alias', 0)
    db.prepare(
      'INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, ?, ?)'
    ).run(2, '缺失女优', 'zh', 1)
    db.prepare(
      'INSERT INTO actress_name_ownership (normalized_name, actress_id) VALUES (?, ?)'
    ).run('缺失女优', 2)
    db.prepare('UPDATE actresses SET cup_size = ? WHERE id = ?').run('F', 2)
    db.prepare('INSERT INTO actress_tags (name, source) VALUES (?, ?)').run('Merged Tag', 'manual')
    db.prepare('INSERT INTO actress_tag (actress_id, tag_id) VALUES (?, ?)').run(2, 1)
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
    assert.equal(detail.name_zh, '缺失女优')
    assert.equal(detail.cup_size, 'F')
    assert.deepEqual(
      db
        .prepare(
          `SELECT at.name
           FROM actress_tags at
           JOIN actress_tag link ON link.tag_id = at.id
           WHERE link.actress_id = ?`
        )
        .all(1),
      [{ name: 'Merged Tag' }]
    )
    assert.equal(detail.gallery.length, 2)
    assert.equal(db.prepare('SELECT id FROM actresses WHERE id = 2').get(), undefined)
    assert.equal(findActressByNameOrAlias('Missing Female'), 1)
    assert.deepEqual(
      listActresses('Missing Female', 'all').map((actress) => actress.id),
      [1]
    )
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

  it('rolls back the whole merge when final main-name reconstruction fails', () => {
    setupDb()
    const db = getDb()
    db.exec(`
      CREATE TRIGGER fail_merged_main_name
      BEFORE INSERT ON actress_names
      WHEN NEW.actress_id = 1
        AND NEW.type = 'main'
        AND NEW.name = 'Missing Female'
      BEGIN
        SELECT RAISE(ABORT, 'main reconstruction failed');
      END;
    `)

    assert.throws(() => mergeActresses(1, 2, 'merge'), /main reconstruction failed/)

    assert.equal(getActressDetail(1)?.main_name, 'Complete')
    assert.equal(getActressDetail(2)?.main_name, 'Missing Female')
    assert.equal(findActressByNameOrAlias('Complete'), 1)
    assert.equal(findActressByNameOrAlias('Missing Female'), 2)
  })

  it('rolls back the whole merge when alias reconstruction fails', () => {
    setupDb()
    const db = getDb()
    db.exec(`
      CREATE TRIGGER fail_merged_alias
      BEFORE INSERT ON actress_names
      WHEN NEW.actress_id = 1
        AND NEW.type = 'alias'
        AND NEW.name = 'Missing Female'
      BEGIN
        SELECT RAISE(ABORT, 'alias reconstruction failed');
      END;
    `)

    assert.throws(() => mergeActresses(1, 2, 'keep'), /alias reconstruction failed/)

    assert.equal(getActressDetail(1)?.main_name, 'Complete')
    assert.equal(getActressDetail(2)?.main_name, 'Missing Female')
    assert.equal(findActressByNameOrAlias('Complete'), 1)
    assert.equal(findActressByNameOrAlias('Missing Female'), 2)
  })

  it('rejects the whole merge when any resulting name belongs to a third actress', () => {
    setupDb()
    const db = getDb()
    const thirdId = upsertActressFromScrape('Third Owner', null)
    editActress(thirdId, { aliases: ['Contested Alias'] })
    db.prepare(
      "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'alias', 0)"
    ).run(2, 'Contested Alias')

    assert.throws(() => mergeActresses(1, 2, 'keep'), /名称「Contested Alias」已被其他演员使用/)

    assert.equal(getActressDetail(1)?.main_name, 'Complete')
    assert.equal(getActressDetail(2)?.main_name, 'Missing Female')
    assert.equal(findActressByNameOrAlias('Contested Alias'), thirdId)
    assert.equal(findActressByNameOrAlias('Missing Female'), 2)
  })

  it('rejects the whole merge when the selected final main name belongs to a third actress', () => {
    setupDb()
    const db = getDb()
    const thirdId = upsertActressFromScrape('Shared Name', null)
    db.prepare('UPDATE actresses SET main_name = ? WHERE id = ?').run('Ｓｈａｒｅｄ　Ｎａｍｅ', 2)
    db.prepare("UPDATE actress_names SET name = ? WHERE actress_id = ? AND type = 'main'").run(
      'Ｓｈａｒｅｄ　Ｎａｍｅ',
      2
    )

    assert.throws(() => mergeActresses(1, 2, 'merge'), /名称「Ｓｈａｒｅｄ　Ｎａｍｅ」已被其他演员使用/)

    assert.equal(getActressDetail(1)?.main_name, 'Complete')
    assert.equal(getActressDetail(2)?.main_name, 'Ｓｈａｒｅｄ　Ｎａｍｅ')
    assert.equal(findActressByNameOrAlias('Shared Name'), thirdId)
  })

  it('resolves a migrated pending name claimed only by the two merged actresses', () => {
    setupDb()
    const db = getDb()
    db.prepare(
      "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'alias', 0)"
    ).run(1, 'Shared Merge Name')
    db.prepare(
      "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'alias', 0)"
    ).run(2, 'Ｓｈａｒｅｄ　Ｍｅｒｇｅ　Ｎａｍｅ')
    const insertPending = db.prepare(
      `INSERT INTO pending_actress_name_claims
         (normalized_name, actress_id, name, type, is_primary)
       VALUES (?, ?, ?, 'alias', 0)`
    )
    insertPending.run('sharedmergename', 1, 'Shared Merge Name')
    insertPending.run('sharedmergename', 2, 'Ｓｈａｒｅｄ　Ｍｅｒｇｅ　Ｎａｍｅ')

    mergeActresses(1, 2, 'keep')

    assert.equal(findActressByNameOrAlias('shared merge name'), 1)
    assert.deepEqual(
      db
        .prepare(
          'SELECT actress_id FROM pending_actress_name_claims WHERE normalized_name = ?'
        )
        .all('sharedmergename'),
      []
    )
  })

  it('preserves existing aliases without reapplying scraped-value heuristics', () => {
    setupDb()
    const db = getDb()
    db.prepare(
      "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'alias', 0)"
    ).run(2, 'Watch Mori')
    db.prepare(
      'INSERT INTO actress_name_ownership (normalized_name, actress_id) VALUES (?, ?)'
    ).run('watchmori', 2)

    mergeActresses(1, 2, 'keep')

    assert.equal(findActressByNameOrAlias('Watch Mori'), 1)
    assert.ok(getActressDetail(1)?.aliases.includes('Watch Mori'))
  })

  it('deletes unusable keeper avatar assets after adopting the merged actress avatar', () => {
    setupDb()
    const db = getDb()
    writeTestAsset('avatars/broken-keeper.jpg', 'not an image')
    writeTestAsset('avatar_sources/broken-keeper.jpg', 'not an image')
    writeTestAvatar('avatars/merged-valid.jpg')
    db.prepare(
      'UPDATE actresses SET avatar_path = ?, avatar_source_path = ? WHERE id = ?'
    ).run('avatars/broken-keeper.jpg', 'avatar_sources/broken-keeper.jpg', 1)
    db.prepare('UPDATE actresses SET avatar_path = ? WHERE id = ?').run(
      'avatars/merged-valid.jpg',
      2
    )

    const result = mergeActresses(1, 2, 'keep')

    assert.equal(getActressDetail(1)?.avatar_path, 'avatars/merged-valid.jpg')
    assert.ok(result.fileChanges.obsoletePaths.includes('avatars/broken-keeper.jpg'))
    assert.ok(result.fileChanges.obsoletePaths.includes('avatar_sources/broken-keeper.jpg'))
    assert.equal(assetExists('avatars/broken-keeper.jpg'), false)
    assert.equal(assetExists('avatars/merged-valid.jpg'), true)
  })

  for (const merged of MERGE_SCRAPE_STATUS_MATRIX) {
    const keeperLabel = ACTRESS_SCRAPE_STATUS_LABEL[merged.keep]
    const mergedLabel = ACTRESS_SCRAPE_STATUS_LABEL[merged.merge]
    it(`keeps ${ACTRESS_SCRAPE_STATUS_LABEL[merged.status]} when merging ${mergedLabel} into ${keeperLabel}`, () => {
      setupDb()
      setActressScrapeRecord(1, merged.keep, merged.keep === 1 ? KEEPER_SUCCESS_TIME : null)
      setActressScrapeRecord(2, merged.merge, merged.merge === 1 ? MERGED_SUCCESS_TIME : null)

      mergeActresses(1, 2, 'keep')

      const detail = getActressDetail(1)
      assert.equal(detail?.scraped_status, merged.status)
      assert.equal(detail?.last_scraped_at, merged.lastScrapedAt)
    })
  }

  it('keeps the newer success time when the keeper succeeded more recently', () => {
    setupDb()
    setActressScrapeRecord(1, 1, '2025-05-05T00:00:00.000Z')
    setActressScrapeRecord(2, 1, '2024-04-04T00:00:00.000Z')

    mergeActresses(1, 2, 'keep')

    assert.equal(getActressDetail(1)?.last_scraped_at, '2025-05-05T00:00:00.000Z')
  })

  it('ignores a success time left on a record that is not scraped successfully', () => {
    setupDb()
    setActressScrapeRecord(1, 2, '2019-09-09T00:00:00.000Z')
    setActressScrapeRecord(2, 1, '2018-08-08T00:00:00.000Z')

    mergeActresses(1, 2, 'keep')

    const detail = getActressDetail(1)
    assert.equal(detail?.scraped_status, 1)
    assert.equal(detail?.last_scraped_at, '2018-08-08T00:00:00.000Z')
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

  it('filters actresses by cumulative scrape status', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE actresses SET scraped_status = 1 WHERE main_name = ?').run('Complete')
    db.prepare('UPDATE actresses SET scraped_status = 2 WHERE main_name = ?').run('Missing Male')

    const targets = listActressesForBatchScrape({ scope: 'all', scrapeStatus: 'unscraped' })

    assert.deepEqual(
      targets.map((target) => target.main_name).sort(),
      ['Missing Female', 'Unknown Gender']
    )
    assert.equal(countActressesForBatchScrape({ scope: 'all', scrapeStatus: 'unscraped' }), 2)
    assert.equal(countActressesForBatchScrape({ scope: 'all', scrapeStatus: 'success' }), 1)
    assert.equal(countActressesForBatchScrape({ scope: 'all', scrapeStatus: 'failed' }), 1)
  })

  it('combines gender and scrape status filters', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE actresses SET scraped_status = 1 WHERE main_name = ?').run('Complete')

    const targets = listActressesForBatchScrape({ scope: 'female', scrapeStatus: 'unscraped' })

    assert.deepEqual(
      targets.map((target) => target.main_name).sort(),
      ['Missing Female', 'Unknown Gender']
    )
    assert.equal(
      countActressesForBatchScrape({ scope: 'female', scrapeStatus: 'success' }),
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

  it('limits batch targets to the explicitly selected actress ids', () => {
    setupDb()

    const targets = listActressesForBatchScrape({
      scope: 'all',
      actressIds: [4, 2, 2]
    })

    assert.deepEqual(
      targets.map((target) => target.main_name),
      ['Missing Female', 'Unknown Gender']
    )
    assert.equal(
      countActressesForBatchScrape({ scope: 'all', actressIds: [] }),
      0
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
        'fillEmpty',
        true
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

  it('fillEmpty treats broken avatar files as missing without mutating during planning', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE actresses SET avatar_path = ? WHERE id = ?').run('avatars/missing.jpg', 1)

    assert.deepEqual(
      resolveEffectiveActressScrapeFields(1, ['avatar', 'birthDate'], 'fillEmpty'),
      ['avatar']
    )
    assert.deepEqual(db.prepare('SELECT avatar_path FROM actresses WHERE id = ?').get(1), {
      avatar_path: 'avatars/missing.jpg'
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

  it('clears broken avatar source and crop while keeping a usable display avatar', () => {
    setupDb()
    const db = getDb()
    const fingerprint = mediaAssetStore.fingerprint(MINIMAL_JPEG)
    db.prepare(
      `UPDATE actresses
       SET avatar_source_path = ?, avatar_crop_json = ?
       WHERE id = ?`
    ).run(
      'avatars/missing-source.jpg',
      JSON.stringify(
        createAvatarCropV1({
          sourceFingerprint: fingerprint,
          zoom: 1.2,
          offsetX: 4,
          offsetY: -3
        })
      ),
      1
    )

    assert.equal(clearBrokenActressAvatarIfNeeded(1), true)
    assert.deepEqual(
      db
        .prepare(
          'SELECT avatar_path, avatar_source_path, avatar_crop_json FROM actresses WHERE id = ?'
        )
        .get(1),
      {
        avatar_path: 'avatars/complete.jpg',
        avatar_source_path: null,
        avatar_crop_json: null
      }
    )
  })
})

describe('actressRepo.getActressAvatarSourceInfo', () => {
  it('uses a legacy display avatar as the source without renderer fetch', () => {
    setupDb()

    assert.deepEqual(getActressAvatarSourceInfo(1), {
      assetPath: 'avatars/complete.jpg',
      sourceFingerprint: mediaAssetStore.fingerprint(MINIMAL_JPEG),
      requiresSourceAdoption: true
    })
  })

  it('prefers the saved original source after an avatar bundle is created', () => {
    setupDb()
    const fingerprint = mediaAssetStore.fingerprint(MINIMAL_JPEG)
    setActressAvatarBundle(2, 'Missing Female', {
      displayImageBase64: MINIMAL_JPEG.toString('base64'),
      sourceImageBase64: MINIMAL_JPEG.toString('base64'),
      crop: createAvatarCropV1({
        sourceFingerprint: fingerprint,
        zoom: 1,
        offsetX: 0,
        offsetY: 0
      })
    })

    const info = getActressAvatarSourceInfo(2)
    assert.ok(info)
    assert.equal(info.sourceFingerprint, fingerprint)
    assert.equal(info.requiresSourceAdoption, false)
    assert.match(info.assetPath, /^avatars\//)
  })
})

describe('actressRepo.setActressAvatarBundle', () => {
  it('persists avatar source, display, and crop; recrops without replacing the source', () => {
    setupDb()
    const db = getDb()
    const displayImageBase64 = MINIMAL_JPEG.toString('base64')
    const sourceImageBase64 = MINIMAL_JPEG.toString('base64')
    const sourceFingerprint = mediaAssetStore.fingerprint(MINIMAL_JPEG)

    setActressAvatarBundle(1, 'Complete', {
      displayImageBase64,
      sourceImageBase64,
      crop: createAvatarCropV1({
        sourceFingerprint,
        zoom: 1.25,
        offsetX: 5,
        offsetY: -2
      })
    })

    const first = db
      .prepare(
        'SELECT avatar_path, avatar_source_path, avatar_crop_json FROM actresses WHERE id = ?'
      )
      .get(1) as {
      avatar_path: string | null
      avatar_source_path: string | null
      avatar_crop_json: string | null
    }
    assert.equal(assetExists(first.avatar_path), true)
    assert.equal(assetExists(first.avatar_source_path), true)
    assert.equal(parseAvatarCrop(first.avatar_crop_json, sourceFingerprint)?.zoom, 1.25)

    setActressAvatarBundle(1, 'Complete', {
      displayImageBase64,
      crop: createAvatarCropV1({
        sourceFingerprint,
        zoom: 2,
        offsetX: -6,
        offsetY: 3
      })
    })

    const second = db
      .prepare(
        'SELECT avatar_path, avatar_source_path, avatar_crop_json FROM actresses WHERE id = ?'
      )
      .get(1) as {
      avatar_path: string | null
      avatar_source_path: string | null
      avatar_crop_json: string | null
    }
    assert.equal(second.avatar_source_path, first.avatar_source_path)
    assert.equal(parseAvatarCrop(second.avatar_crop_json, sourceFingerprint)?.zoom, 2)
    assert.equal(parseAvatarCrop(second.avatar_crop_json, sourceFingerprint)?.offsetX, -6)
  })

  it('adopts recognized legacy image bytes when native dimension probing is unavailable', () => {
    setupDb()
    const db = getDb()
    writeTestAsset('avatars/legacy.webp', WEBP_CONTAINER)
    db.prepare(
      `UPDATE actresses
       SET avatar_path = ?, avatar_source_path = NULL, avatar_crop_json = NULL
       WHERE id = ?`
    ).run('avatars/legacy.webp', 1)

    const source = getActressAvatarSourceInfo(1)
    assert.ok(source)
    assert.equal(source.requiresSourceAdoption, true)

    setActressAvatarBundle(1, 'Complete', {
      displayImageBase64: MINIMAL_JPEG.toString('base64'),
      sourceAssetPath: source.assetPath,
      crop: createAvatarCropV1({
        sourceFingerprint: source.sourceFingerprint,
        zoom: 1.2,
        offsetX: 2,
        offsetY: -3
      })
    })

    const saved = db
      .prepare('SELECT avatar_source_path FROM actresses WHERE id = ?')
      .get(1) as { avatar_source_path: string }
    assert.match(saved.avatar_source_path, /\.webp$/)
    assert.equal(assetExists(saved.avatar_source_path), true)
  })

  it('repairs an existing source whose stored extension does not match its bytes', () => {
    setupDb()
    const db = getDb()
    const sourceFingerprint = mediaAssetStore.fingerprint(WEBP_CONTAINER)
    writeTestAsset('avatars/mislabeled.jpg', WEBP_CONTAINER)
    db.prepare(
      `UPDATE actresses
       SET avatar_source_path = ?, avatar_crop_json = ?
       WHERE id = ?`
    ).run(
      'avatars/mislabeled.jpg',
      JSON.stringify(
        createAvatarCropV1({
          sourceFingerprint,
          zoom: 1.1,
          offsetX: 0,
          offsetY: 0
        })
      ),
      1
    )

    setActressAvatarBundle(1, 'Complete', {
      displayImageBase64: MINIMAL_JPEG.toString('base64'),
      crop: createAvatarCropV1({
        sourceFingerprint,
        zoom: 1.3,
        offsetX: 4,
        offsetY: -2
      })
    })

    const saved = db
      .prepare('SELECT avatar_source_path FROM actresses WHERE id = ?')
      .get(1) as { avatar_source_path: string }
    assert.match(saved.avatar_source_path, /\.webp$/)
    assert.equal(assetExists('avatars/mislabeled.jpg'), false)
    assert.equal(assetExists(saved.avatar_source_path), true)
  })

  it('rejects invalid display bytes before writing the avatar bundle', () => {
    setupDb()
    const sourceFingerprint = mediaAssetStore.fingerprint(MINIMAL_JPEG)

    assert.throws(
      () =>
        setActressAvatarBundle(1, 'Complete', {
          displayImageBase64: Buffer.from('not an image').toString('base64'),
          sourceImageBase64: MINIMAL_JPEG.toString('base64'),
          crop: createAvatarCropV1({
            sourceFingerprint,
            zoom: 1,
            offsetX: 0,
            offsetY: 0
          })
        }),
      /头像展示图无效/
    )
  })

  it('keeps source paths distinct for equal-length Chinese names with identical bytes', () => {
    setupDb()
    const db = getDb()
    const idA = upsertActressFromScrape('三上悠亚', null, 'female')
    const idB = upsertActressFromScrape('桥本有菜', null, 'female')
    const payload = {
      displayImageBase64: MINIMAL_JPEG.toString('base64'),
      sourceImageBase64: MINIMAL_JPEG.toString('base64'),
      crop: createAvatarCropV1({
        sourceFingerprint: mediaAssetStore.fingerprint(MINIMAL_JPEG),
        zoom: 1,
        offsetX: 0,
        offsetY: 0
      })
    }
    setActressAvatarBundle(idA, '三上悠亚', payload)
    setActressAvatarBundle(idB, '桥本有菜', payload)

    const a = db
      .prepare('SELECT avatar_path, avatar_source_path FROM actresses WHERE id = ?')
      .get(idA) as { avatar_path: string; avatar_source_path: string }
    const b = db
      .prepare('SELECT avatar_path, avatar_source_path FROM actresses WHERE id = ?')
      .get(idB) as { avatar_path: string; avatar_source_path: string }
    assert.notEqual(a.avatar_path, b.avatar_path)
    assert.notEqual(a.avatar_source_path, b.avatar_source_path)
    assert.equal(assetExists(a.avatar_source_path), true)
    assert.equal(assetExists(b.avatar_source_path), true)
  })
})

describe('actressRepo cumulative scrape status', () => {
  it('keeps an actress created by video scraping unscraped and exposes the status in detail', () => {
    setupDb()
    writeTestAvatar('avatars/video-scrape-download.jpg')

    const actressId = upsertActressFromScrape(
      'Created From Video Scrape',
      'avatars/video-scrape-download.jpg',
      'female'
    )

    const detail = getActressDetail(actressId)
    assert.ok(detail)
    assert.equal(detail.scraped_status, 0)
    assert.equal(detail.last_scraped_at, null)
    assert.ok(detail.avatar_path)
  })
})

describe('actressRepo cumulative scrape status maintenance invariants', () => {
  for (const status of [0, 1, 2] as ScrapedStatus[]) {
    const successTime = status === 1 ? '2022-02-02T00:00:00.000Z' : null
    it(`keeps ${ACTRESS_SCRAPE_STATUS_LABEL[status]} and its success time through manual maintenance`, () => {
      setupDb()
      const db = getDb()
      setActressScrapeRecord(1, status, successTime)
      writeTestAsset('actress_gallery/maintenance.jpg', MINIMAL_JPEG)

      editActress(1, {
        main_name: 'Maintained',
        birth_date: '1991-02-03',
        profile_summary: 'Manually maintained',
        aliases: ['Maintained Alias']
      })
      setActressAvatarBundle(1, 'Maintained', {
        displayImageBase64: MINIMAL_JPEG.toString('base64'),
        sourceImageBase64: MINIMAL_JPEG.toString('base64'),
        crop: createAvatarCropV1({
          sourceFingerprint: mediaAssetStore.fingerprint(MINIMAL_JPEG),
          zoom: 1.4,
          offsetX: 2,
          offsetY: -2
        })
      })
      const added = addActressGalleryAsset(1, {
        remoteUrl: 'https://example.test/maintenance.jpg',
        localPath: 'actress_gallery/maintenance.jpg'
      })
      setActressPosterPath(1, 'actress_gallery/maintenance.jpg')
      setActressPosterPath(1, null)
      deleteActressGalleryAsset(1, added.id)
      insertTestVideoWithFile(db, {
        code: 'MAINT-001',
        filePath: 'maint.mp4',
        title: 'Maintenance',
        addTime: '2024-01-01'
      })
      db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(1, 1)
      upsertActressFromScrape('Maintained', null, 'female')

      const detail = getActressDetail(1)
      assert.equal(detail?.scraped_status, status)
      assert.equal(detail?.last_scraped_at, successTime)
    })
  }
})

describe('actressRepo.upsertActressFromScrape avatar adopt', () => {
  it('adopts a downloaded avatar into source+display+crop and drops the temp path', () => {
    setupDb()
    writeTestAvatar('avatars/download-temp.jpg')
    const id = upsertActressFromScrape('三上悠亚', 'avatars/download-temp.jpg', 'female')
    const row = getDb()
      .prepare(
        'SELECT avatar_path, avatar_source_path, avatar_crop_json FROM actresses WHERE id = ?'
      )
      .get(id) as {
      avatar_path: string | null
      avatar_source_path: string | null
      avatar_crop_json: string | null
    }
    assert.notEqual(row.avatar_path, 'avatars/download-temp.jpg')
    assert.equal(assetExists(row.avatar_path), true)
    assert.equal(assetExists(row.avatar_source_path), true)
    assert.ok(row.avatar_crop_json)
    assert.equal(assetExists('avatars/download-temp.jpg'), false)
  })

  it('gives equal-length Chinese names distinct avatar files from the same download bytes', () => {
    setupDb()
    writeTestAvatar('avatars/dl-a.jpg')
    writeTestAvatar('avatars/dl-b.jpg')
    const idA = upsertActressFromScrape('三上悠亚', 'avatars/dl-a.jpg', 'female')
    const idB = upsertActressFromScrape('桥本有菜', 'avatars/dl-b.jpg', 'female')
    const a = getDb()
      .prepare('SELECT avatar_path, avatar_source_path FROM actresses WHERE id = ?')
      .get(idA) as { avatar_path: string; avatar_source_path: string }
    const b = getDb()
      .prepare('SELECT avatar_path, avatar_source_path FROM actresses WHERE id = ?')
      .get(idB) as { avatar_path: string; avatar_source_path: string }
    assert.notEqual(a.avatar_path, b.avatar_path)
    assert.notEqual(a.avatar_source_path, b.avatar_source_path)
  })

  it('does not replace an existing usable avatar', () => {
    setupDb()
    writeTestAvatar('avatars/new-download.jpg')
    upsertActressFromScrape('Complete', 'avatars/new-download.jpg', 'female')
    const row = getDb()
      .prepare('SELECT avatar_path FROM actresses WHERE id = ?')
      .get(1) as { avatar_path: string | null }
    assert.equal(row.avatar_path, 'avatars/complete.jpg')
    assert.equal(assetExists('avatars/new-download.jpg'), false)
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

    assert.equal(
      backfillActressGalleryAssetDimensions(
        db,
        1,
        (assetPath) => mediaAssetStore.readStoredImageDimensions(assetPath)
      ),
      1
    )

    const row = db
      .prepare('SELECT width, height FROM actress_gallery_assets WHERE local_path = ?')
      .get('actress_gallery/landscape.jpg') as { width: number; height: number }
    assert.ok(row.width > 0)
    assert.ok(row.height > 0)
  })
})

describe('actressRepo query purity', () => {
  it('does not change database rows or stored resources when listing and reading details', () => {
    setupDb()
    const db = getDb()
    const relPath = 'actress_gallery/complete.jpg'
    writeTestAsset(relPath, MINIMAL_JPEG)
    const absolutePath = path.join(tempRoot!, 'media_assets', relPath)
    const rowsBefore = db
      .prepare('SELECT * FROM actress_gallery_assets ORDER BY id')
      .all()
    const actressesBefore = db.prepare('SELECT * FROM actresses ORDER BY id').all()
    const namesBefore = db.prepare('SELECT * FROM actress_names ORDER BY id').all()
    const changesBefore = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const bytesBefore = fs.readFileSync(absolutePath)
    const modifiedBefore = fs.statSync(absolutePath).mtimeMs

    const page = listActressPage({ gender: 'all', avatar: 'all', limit: 2, offset: 0 })
    const detail = getActressDetail(1)

    assert.equal(page.items.length, 2)
    assert.equal(detail?.gallery.length, 1)
    assert.deepEqual(
      db.prepare('SELECT * FROM actress_gallery_assets ORDER BY id').all(),
      rowsBefore
    )
    assert.deepEqual(db.prepare('SELECT * FROM actresses ORDER BY id').all(), actressesBefore)
    assert.deepEqual(db.prepare('SELECT * FROM actress_names ORDER BY id').all(), namesBefore)
    assert.equal(
      (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n,
      changesBefore
    )
    assert.deepEqual(fs.readFileSync(absolutePath), bytesBefore)
    assert.equal(fs.statSync(absolutePath).mtimeMs, modifiedBefore)
    assert.deepEqual(
      db.prepare('SELECT width, height FROM actress_gallery_assets WHERE actress_id = 1').get(),
      { width: null, height: null }
    )
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

describe('actressRepo.recordActressScrapeFailure', () => {
  it('records failure without writing a success time or changing profile fields', () => {
    setupDb()
    recordActressScrapeFailure(2)
    const detail = getActressDetail(2)
    assert.equal(detail?.scraped_status, 2)
    assert.equal(detail?.last_scraped_at, null)
    assert.equal(detail?.birth_date, null)
  })
})

describe('actressRepo.markActressScrapeSucceeded', () => {
  it('promotes an unscraped actress and stamps the missing success time', () => {
    setupDb()

    markActressScrapeSucceeded(2)

    const detail = getActressDetail(2)
    assert.equal(detail?.scraped_status, 1)
    assert.ok(detail?.last_scraped_at)
  })

  it('promotes a failed actress and stamps the missing success time', () => {
    setupDb()
    recordActressScrapeFailure(2)

    markActressScrapeSucceeded(2)

    const detail = getActressDetail(2)
    assert.equal(detail?.scraped_status, 1)
    assert.ok(detail?.last_scraped_at)
  })

  it('keeps an existing success time instead of restamping it', () => {
    setupDb()
    getDb()
      .prepare('UPDATE actresses SET scraped_status = 1, last_scraped_at = ? WHERE id = ?')
      .run('2020-01-02T03:04:05.000Z', 2)

    markActressScrapeSucceeded(2)

    const detail = getActressDetail(2)
    assert.equal(detail?.scraped_status, 1)
    assert.equal(detail?.last_scraped_at, '2020-01-02T03:04:05.000Z')
  })

  it('stamps a success time over a blank stored time', () => {
    setupDb()
    getDb().prepare('UPDATE actresses SET last_scraped_at = ? WHERE id = ?').run('   ', 2)

    markActressScrapeSucceeded(2)

    const detail = getActressDetail(2)
    assert.equal(detail?.scraped_status, 1)
    assert.ok(detail?.last_scraped_at?.trim())
  })

  it('rejects marking an actress that does not exist', () => {
    setupDb()

    assert.throws(() => markActressScrapeSucceeded(9999), /演员不存在/)
  })
})

describe('actressRepo.applyActressScrapeResult', () => {
  for (const mode of ['replace', 'fillEmpty', 'replaceIfPresent'] as const) {
    it(`keeps every selected field plan aligned with the ${mode} database result`, () => {
      setupDb()
      const actressId = mode === 'fillEmpty' ? 2 : 1
      const avatarPath = `avatars/plan-matrix-${mode}.png`
      const galleryPath = `actress_gallery/plan-matrix-${mode}.jpg`
      writeTestAsset(
        avatarPath,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64'
        )
      )
      writeTestAvatar(galleryPath)
      const result = {
        avatarUrl: `https://example.test/${mode}.png`,
        birthDate: '2001-02-03',
        nameZh: `中文名${mode}`,
        nameEn: `English ${mode}`,
        debutDate: '2020-04-05',
        heightCm: 167,
        bustCm: 91,
        waistCm: 61,
        hipCm: 89,
        cupSize: 'F',
        bloodType: 'B',
        zodiac: 'Taurus',
        nationality: 'Japan',
        profileSummary: `Profile ${mode}`,
        aliases: [`Alias ${mode}`]
      }
      const gallery = [{ remoteUrl: `https://example.test/${mode}.jpg`, localPath: galleryPath }]
      const fields = [
        'avatar',
        'gallery',
        'birthDate',
        'nameZh',
        'nameEn',
        'debutDate',
        'heightCm',
        'measurements',
        'cupSize',
        'bloodType',
        'zodiac',
        'nationality',
        'profileSummary',
        'aliases'
      ] as const
      const plan = planActressScrapeResult(
        actressId,
        result,
        avatarPath,
        gallery,
        [...fields],
        mode
      )

      const outcome = applyActressScrapeResult(
        actressId,
        result,
        avatarPath,
        gallery,
        [...fields],
        mode
      )
      const detail = getActressDetail(actressId)!

      assert.equal(outcome.applied, true)
      for (const impact of plan.impacts) {
        let actual: string | number | string[] | null
        switch (impact.field) {
          case 'avatar':
            assert.equal(impact.action === 'clear', detail.avatar_path == null)
            if (impact.action === 'set') assert.equal(assetExists(detail.avatar_path), true)
            continue
          case 'gallery':
            actual = detail.gallery.map(
              (asset) => asset.local_path?.trim() || asset.remote_url?.trim() || ''
            ).filter(Boolean)
            break
          case 'birthDate': actual = detail.birth_date; break
          case 'nameZh': actual = detail.name_zh; break
          case 'nameEn': actual = detail.name_en; break
          case 'debutDate': actual = detail.debut_date; break
          case 'heightCm': actual = detail.height_cm; break
          case 'cupSize': actual = detail.cup_size; break
          case 'bloodType': actual = detail.blood_type; break
          case 'zodiac': actual = detail.zodiac; break
          case 'nationality': actual = detail.nationality; break
          case 'profileSummary': actual = detail.profile_summary; break
          case 'aliases': actual = detail.aliases; break
          case 'measurements':
            actual =
              impact.part === 'bustCm'
                ? detail.bust_cm
                : impact.part === 'waistCm'
                  ? detail.waist_cm
                  : detail.hip_cm
            break
          default:
            continue
        }
        assert.deepEqual(actual, impact.nextValue, `${impact.field}/${impact.part ?? 'field'}`)
      }
    })
  }

  it('does not backfill gallery metadata while building a read-only plan', () => {
    setupDb()
    const db = getDb()
    writeTestAvatar('actress_gallery/complete.jpg')

    planActressScrapeResult(1, {}, null, [], ['gallery'], 'replaceIfPresent')

    assert.deepEqual(
      db
        .prepare(
          'SELECT width, height FROM actress_gallery_assets WHERE actress_id = ?'
        )
        .get(1),
      { width: null, height: null }
    )
  })

  it('plans and applies a fillEmpty avatar over a broken stored path consistently', () => {
    setupDb()
    const db = getDb()
    db.prepare('UPDATE actresses SET avatar_path = ? WHERE id = ?').run('avatars/missing.jpg', 1)
    writeTestAvatar('avatars/fill-broken.jpg')

    const plan = planActressScrapeResult(
      1,
      { avatarUrl: 'https://example.test/fill-broken.jpg' },
      'avatars/fill-broken.jpg',
      [],
      ['avatar'],
      'fillEmpty'
    )

    assert.deepEqual(plan.impacts, [
      {
        field: 'avatar',
        action: 'set',
        currentValue: null,
        nextValue: 'avatars/fill-broken.jpg',
        reason: 'fillEmpty'
      }
    ])
    assert.equal(
      (db.prepare('SELECT avatar_path FROM actresses WHERE id = ?').get(1) as { avatar_path: string })
        .avatar_path,
      'avatars/missing.jpg'
    )

    const outcome = applyActressScrapeResult(
      1,
      { avatarUrl: 'https://example.test/fill-broken.jpg' },
      'avatars/fill-broken.jpg',
      [],
      ['avatar'],
      'fillEmpty'
    )

    assert.equal(outcome.avatarApplied, true)
    const avatarPath = (
      db.prepare('SELECT avatar_path FROM actresses WHERE id = ?').get(1) as {
        avatar_path: string | null
      }
    ).avatar_path
    assert.ok(avatarPath)
    assert.notEqual(avatarPath, 'avatars/missing.jpg')
    assert.equal(assetExists(avatarPath), true)
  })

  it('previews replace clears without changing the actress or deleting assets', () => {
    setupDb()
    const before = getActressDetail(1)

    const plan = planActressScrapeResult(
      1,
      {},
      null,
      [],
      ['avatar', 'birthDate', 'measurements'],
      'replace'
    )

    assert.deepEqual(
      plan.impacts.map(({ field, part, action, currentValue, nextValue, reason }) => ({
        field,
        part,
        action,
        currentValue,
        nextValue,
        reason
      })),
      [
        {
          field: 'avatar',
          part: undefined,
          action: 'clear',
          currentValue: 'avatars/complete.jpg',
          nextValue: null,
          reason: 'replace'
        },
        {
          field: 'birthDate',
          part: undefined,
          action: 'clear',
          currentValue: '1990-01-01',
          nextValue: null,
          reason: 'replace'
        },
        {
          field: 'measurements',
          part: 'bustCm',
          action: 'clear',
          currentValue: 90,
          nextValue: null,
          reason: 'replace'
        },
        {
          field: 'measurements',
          part: 'waistCm',
          action: 'clear',
          currentValue: 60,
          nextValue: null,
          reason: 'replace'
        },
        {
          field: 'measurements',
          part: 'hipCm',
          action: 'clear',
          currentValue: 88,
          nextValue: null,
          reason: 'replace'
        }
      ]
    )
    assert.deepEqual(getActressDetail(1), before)
    assert.equal(assetExists('avatars/complete.jpg'), true)
  })

  it('does not claim a scrape was applied when every returned alias is unusable', () => {
    setupDb()

    const outcome = applyActressScrapeResult(
      2,
      { aliases: ['Missing Female', 'watch online'] },
      null,
      [],
      ['aliases'],
      'replace'
    )

    const detail = getActressDetail(2)
    assert.equal(outcome.applied, false)
    assert.deepEqual(detail?.aliases, [])
    assert.equal(detail?.scraped_status, 0)
    assert.equal(detail?.last_scraped_at, null)
  })

  it('rolls back profile data and cumulative success when gallery persistence fails', () => {
    setupDb()
    getDb().exec(`
      CREATE TRIGGER fail_scraped_gallery_insert
      BEFORE INSERT ON actress_gallery_assets
      BEGIN
        SELECT RAISE(ABORT, 'gallery persistence failed');
      END;
    `)

    assert.throws(
      () =>
        applyActressScrapeResult(
          2,
          {
            birthDate: '2001-02-03',
            galleryImageUrls: ['https://example.test/new-gallery.jpg']
          },
          null,
          [{ remoteUrl: 'https://example.test/new-gallery.jpg' }],
          ['birthDate', 'gallery'],
          'replace'
        ),
      /gallery persistence failed/
    )

    const detail = getActressDetail(2)
    assert.equal(detail?.birth_date, null)
    assert.equal(detail?.scraped_status, 0)
    assert.equal(detail?.last_scraped_at, null)
    assert.deepEqual(detail?.gallery, [])
  })

  it('skips invalid downloaded avatars while applying other profile fields', () => {
    setupDb()
    const db = getDb()
    writeTestAsset('avatars/not-image.jpg', '<html>not an image</html>')

    const { applied, warnings, avatarApplied } = applyActressScrapeResult(
      2,
      { birthDate: '2000-02-03' },
      'avatars/not-image.jpg',
      [],
      ['avatar', 'birthDate'],
      'replace'
    )

    assert.equal(applied, true)
    assert.equal(avatarApplied, false)
    assert.equal(warnings.some((warning) => warning.includes('头像未应用')), true)
    const row = db
      .prepare('SELECT birth_date, avatar_path FROM actresses WHERE id = ?')
      .get(2) as { birth_date: string | null; avatar_path: string | null }
    assert.equal(row.birth_date, '2000-02-03')
    assert.equal(row.avatar_path, null)
    assert.equal(assetExists('avatars/not-image.jpg'), false)
  })

  it('replace keeps manual crop when scraped avatar bytes match existing source', () => {
    setupDb()
    const db = getDb()
    const sourceFingerprint = mediaAssetStore.fingerprint(MINIMAL_JPEG)
    setActressAvatarBundle(1, 'Complete', {
      displayImageBase64: MINIMAL_JPEG.toString('base64'),
      sourceImageBase64: MINIMAL_JPEG.toString('base64'),
      crop: createAvatarCropV1({
        sourceFingerprint,
        zoom: 1.8,
        offsetX: -12,
        offsetY: 4
      })
    })
    const before = db
      .prepare(
        'SELECT avatar_path, avatar_source_path, avatar_crop_json FROM actresses WHERE id = ?'
      )
      .get(1) as {
      avatar_path: string
      avatar_source_path: string
      avatar_crop_json: string
    }

    writeTestAvatar('avatars/same-source-again.jpg')
    const plan = planActressScrapeResult(
      1,
      { birthDate: '1991-02-03' },
      'avatars/same-source-again.jpg',
      [],
      ['avatar', 'birthDate'],
      'replace'
    )
    assert.deepEqual(
      plan.impacts.find((impact) => impact.field === 'avatar'),
      {
        field: 'avatar',
        action: 'preserve',
        currentValue: before.avatar_path,
        nextValue: before.avatar_path,
        reason: 'replace'
      }
    )
    const { applied, avatarApplied } = applyActressScrapeResult(
      1,
      { birthDate: '1991-02-03' },
      'avatars/same-source-again.jpg',
      [],
      ['avatar', 'birthDate'],
      'replace'
    )

    assert.equal(applied, true)
    assert.equal(avatarApplied, true)
    const after = db
      .prepare(
        'SELECT birth_date, avatar_path, avatar_source_path, avatar_crop_json FROM actresses WHERE id = ?'
      )
      .get(1) as {
      birth_date: string | null
      avatar_path: string
      avatar_source_path: string
      avatar_crop_json: string
    }
    assert.equal(after.birth_date, '1991-02-03')
    assert.equal(after.avatar_path, before.avatar_path)
    assert.equal(after.avatar_source_path, before.avatar_source_path)
    assert.equal(after.avatar_crop_json, before.avatar_crop_json)
    assert.equal(parseAvatarCrop(after.avatar_crop_json, sourceFingerprint)?.zoom, 1.8)
    assert.equal(assetExists('avatars/same-source-again.jpg'), false)
  })

  it('replace adopts a new avatar when scraped bytes differ from existing source', () => {
    setupDb()
    const db = getDb()
    const sourceFingerprint = mediaAssetStore.fingerprint(MINIMAL_JPEG)
    setActressAvatarBundle(1, 'Complete', {
      displayImageBase64: MINIMAL_JPEG.toString('base64'),
      sourceImageBase64: MINIMAL_JPEG.toString('base64'),
      crop: createAvatarCropV1({
        sourceFingerprint,
        zoom: 1.8,
        offsetX: -12,
        offsetY: 4
      })
    })
    const before = db
      .prepare('SELECT avatar_path, avatar_crop_json FROM actresses WHERE id = ?')
      .get(1) as { avatar_path: string; avatar_crop_json: string }

    // Minimal valid 1x1 PNG — different fingerprint from MINIMAL_JPEG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    writeTestAsset('avatars/different-source.png', png)
    const { applied, avatarApplied } = applyActressScrapeResult(
      1,
      {},
      'avatars/different-source.png',
      [],
      ['avatar'],
      'replace'
    )

    assert.equal(applied, true)
    assert.equal(avatarApplied, true)
    const after = db
      .prepare('SELECT avatar_path, avatar_crop_json FROM actresses WHERE id = ?')
      .get(1) as { avatar_path: string; avatar_crop_json: string }
    assert.notEqual(after.avatar_path, before.avatar_path)
    assert.notEqual(after.avatar_crop_json, before.avatar_crop_json)
    assert.equal(parseAvatarCrop(after.avatar_crop_json)?.zoom, 1)
  })

  it('replace clears an existing avatar when the source returns no avatar', () => {
    setupDb()

    const { applied, avatarApplied, fileChanges } = applyActressScrapeResult(
      1,
      {},
      null,
      [],
      ['avatar'],
      'replace'
    )

    const row = getDb()
      .prepare('SELECT avatar_path, avatar_source_path, avatar_crop_json FROM actresses WHERE id = ?')
      .get(1) as {
      avatar_path: string | null
      avatar_source_path: string | null
      avatar_crop_json: string | null
    }
    assert.equal(applied, true)
    assert.equal(avatarApplied, false)
    assert.equal(row.avatar_path, null)
    assert.equal(row.avatar_source_path, null)
    assert.equal(row.avatar_crop_json, null)
    assert.ok(fileChanges?.obsoletePaths.includes('avatars/complete.jpg'))
    assert.equal(assetExists('avatars/complete.jpg'), false)
  })

  it('replace preserves an existing avatar when a returned avatar fails to download', () => {
    setupDb()

    const { applied } = applyActressScrapeResult(
      1,
      { avatarUrl: 'https://example.test/unavailable.jpg' },
      null,
      [],
      ['avatar'],
      'replace'
    )

    assert.equal(applied, false)
    assert.equal(getActressDetail(1)?.avatar_path, 'avatars/complete.jpg')
    assert.equal(assetExists('avatars/complete.jpg'), true)
  })

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

  it('replace clears every selected non-avatar field when the matched source returns no values', () => {
    setupDb()
    editActress(1, {
      name_zh: '测试中文名',
      name_en: 'Test English Name',
      cup_size: 'E'
    })

    const { applied } = applyActressScrapeResult(
      1,
      {},
      null,
      [],
      [
        'gallery',
        'birthDate',
        'nameZh',
        'nameEn',
        'debutDate',
        'heightCm',
        'measurements',
        'cupSize',
        'bloodType',
        'zodiac',
        'nationality',
        'profileSummary',
        'aliases'
      ],
      'replace'
    )

    const detail = getActressDetail(1)
    assert.equal(applied, true)
    assert.equal(detail?.birth_date, null)
    assert.equal(detail?.name_zh, null)
    assert.equal(detail?.name_en, null)
    assert.equal(detail?.debut_date, null)
    assert.equal(detail?.height_cm, null)
    assert.equal(detail?.bust_cm, null)
    assert.equal(detail?.waist_cm, null)
    assert.equal(detail?.hip_cm, null)
    assert.equal(detail?.cup_size, null)
    assert.equal(detail?.blood_type, null)
    assert.equal(detail?.zodiac, null)
    assert.equal(detail?.nationality, null)
    assert.equal(detail?.profile_summary, null)
    assert.deepEqual(detail?.gallery, [])
    assert.deepEqual(detail?.aliases, [])
  })

  it('replaceIfPresent rejects all fields when every returned alias conflicts', () => {
    setupDb()

    assert.throws(
      () =>
        applyActressScrapeResult(
          1,
          { birthDate: '1995-03-04', aliases: ['Missing Female'] },
          null,
          [],
          ['birthDate', 'aliases'],
          'replaceIfPresent'
        ),
      /名称「Missing Female」已被其他演员使用/
    )

    assert.equal(getActressDetail(1)?.birth_date, '1990-01-01')
    assert.deepEqual(getActressDetail(1)?.aliases, ['Complete Alias'])
  })

  it('fillEmpty does not report success when measurements only repeat a filled component', () => {
    setupDb()
    getDb()
      .prepare('UPDATE actresses SET waist_cm = NULL, hip_cm = NULL WHERE id = ?')
      .run(1)

    const { applied } = applyActressScrapeResult(
      1,
      { bustCm: 99 },
      null,
      [],
      ['measurements'],
      'fillEmpty'
    )

    const row = getDb()
      .prepare('SELECT bust_cm, waist_cm, hip_cm FROM actresses WHERE id = ?')
      .get(1) as { bust_cm: number | null; waist_cm: number | null; hip_cm: number | null }
    assert.equal(applied, false)
    assert.deepEqual(row, { bust_cm: 90, waist_cm: null, hip_cm: null })
  })

  it('rejects the whole scraped result when any alias has another owner', () => {
    setupDb()
    assert.throws(
      () =>
        applyActressScrapeResult(
          2,
          {
            birthDate: '1995-03-04',
            aliases: ['Complete Alias', 'Safe Alias']
          },
          null,
          [],
          ['birthDate', 'aliases'],
          'replace'
        ),
      /名称「Complete Alias」已被其他演员使用/
    )

    const row = getDb().prepare('SELECT birth_date FROM actresses WHERE id = ?').get(2) as {
      birth_date: string | null
    }
    assert.equal(row.birth_date, null)
    assert.deepEqual(getActressDetail(2)?.aliases, [])
  })

  it('treats canonically equivalent scraped aliases as conflicts', () => {
    setupDb()

    assert.throws(
      () =>
        applyActressScrapeResult(
          2,
          {
            birthDate: '1995-03-04',
            aliases: ['Ｃｏｍｐｌｅｔｅ']
          },
          null,
          [],
          ['birthDate', 'aliases'],
          'replaceIfPresent'
        ),
      /名称「Ｃｏｍｐｌｅｔｅ」已被其他演员使用/
    )

    assert.equal(getActressDetail(2)?.birth_date, null)
    assert.deepEqual(getActressDetail(2)?.aliases, [])
  })
})
