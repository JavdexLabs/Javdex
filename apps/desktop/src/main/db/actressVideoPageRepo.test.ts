import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { editActress, getActressDetail } from './actressRepo'
import { listActressVideoPage } from './actressVideoPageRepo'
import { insertTestVideoWithFile } from './testVideoFixtures'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { createActressQueryService } from '../services/actressQueryService'

let root: string
let previous: string | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-actress-works-'))
  previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
  resetSettingsCacheForTests()
  initDatabaseAtPath(path.join(root, 'catalog.db'))
  getDb().exec("INSERT INTO actresses(id,main_name) VALUES(1,'Actor'),(2,'Empty'); INSERT OR IGNORE INTO media_libraries(id,name) VALUES(1,'One'),(2,'Two'),(3,'Archived')")
})
afterEach(() => {
  closeDatabase()
  resetSettingsCacheForTests()
  if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previous
  fs.rmSync(root, { recursive: true, force: true })
})

it('pages the same visible works once across libraries with stable date ties and narrow cards', () => {
  const db = getDb()
  db.transaction(() => {
    for (let n = 1; n <= 265; n++) {
      const { videoId } = insertTestVideoWithFile(db, {
        code: `WORK-${n}`, filePath: `/synthetic/${n}.mp4`, libraryId: n === 265 ? 3 : 1,
        summary: 'x'.repeat(4096), releaseDate: n % 5 === 0 ? '' : n % 3 ? '2026-01-01' : null,
        addTime: n % 2 ? '2026-01-02 00:00:00' : '2026-01-01 00:00:00'
      })
      db.prepare('INSERT INTO video_actress(video_id,actress_id) VALUES(?,1)').run(videoId)
      if (n <= 10) db.prepare('INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES(2,?,?)').run(videoId, n)
      if (n === 263) db.prepare('UPDATE library_video_memberships SET is_hidden=1 WHERE video_id=?').run(videoId)
      if (n === 264) db.prepare('DELETE FROM library_video_memberships WHERE video_id=?').run(videoId)
    }
    db.exec("UPDATE media_libraries SET status='archived' WHERE id=3")
  })()
  db.exec(`INSERT INTO video_resources(library_id,video_id,kind,locator,resource_key,add_time)
    VALUES(1,1,'web','https://example.test/work','web:1','2026-01-01'),
          (1,1,'magnet','magnet:?xt=urn:btih:synthetic','magnet:1','2026-01-02');
    INSERT INTO pending_video_scrapes(video_id,selected_fields_json,applicable_fields_json,update_mode,request_json,warnings_json,created_at,updated_at)
      VALUES(1,'[]','[]','replace','{}','[]','2026-01-01','2026-01-01');`)
  const old = getActressDetail(1)!.videos
  assert.equal(old.length, 262)
  const descendingText = (a: string | null, b: string | null): number => a === b ? 0 : a === null ? 1 : b === null ? -1 : Buffer.compare(Buffer.from(b), Buffer.from(a))
  const expected = old.sort((a, b) => descendingText(a.release_date, b.release_date) || descendingText(a.add_time, b.add_time) || a.id - b.id)
    .map(({ id, code, title, cover_path, scraped_status, has_pending_scrape, resource_kinds }) => ({ id, code, title, cover_path, scraped_status, has_pending_scrape, resource_kinds }))
  const service = createActressQueryService({ getActress: () => { throw new Error('Full actress detail forbidden') } })
  const pages = [0, 60, 120, 180, 240].map(offset => service.listVideos(1, { offset })!)
  assert.deepEqual(pages.flatMap(page => page.videos), expected)
  assert.equal(expected.find(video => video.id === 1)!.has_pending_scrape, true)
  assert.deepEqual(expected.find(video => video.id === 1)!.resource_kinds, ['local', 'web', 'magnet'])
  for (const page of pages) {
    assert.equal(page.total, 262)
    assert.ok(page.videos.length <= 60)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 20000)
    for (const card of page.videos) assert.ok(!('summary' in card))
  }
  assert.equal(listActressVideoPage(1, { limit: 240 })!.videos.length, 240)
  assert.deepEqual(listActressVideoPage(1, { offset: 1000 })!.videos, [])
})

it('distinguishes missing and empty actors and rejects unbounded or invalid page arguments', () => {
  assert.equal(listActressVideoPage(999), null)
  assert.deepEqual(listActressVideoPage(2), { videos: [], total: 0, offset: 0, limit: 60 })
  for (const id of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => listActressVideoPage(id), /Invalid/)
  for (const limit of [0, -1, 241, NaN, Infinity, 1.5]) assert.throws(() => listActressVideoPage(1, { limit }), /Invalid/)
  for (const offset of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => listActressVideoPage(1, { offset }), /Invalid/)
})

it('keeps count and cards on the same read snapshot during an external visibility change', () => {
  const db = getDb()
  const { videoId } = insertTestVideoWithFile(db, { code: 'SNAPSHOT', filePath: '/synthetic/snapshot.mp4', libraryId: 1 })
  db.prepare('INSERT INTO video_actress(video_id,actress_id) VALUES(?,1)').run(videoId)
  const other = new Database(path.join(root, 'catalog.db'))
  const prepare = db.prepare.bind(db)
  let changed = false
  db.prepare = ((sql: string) => {
    const statement = prepare(sql)
    if (sql.includes('SELECT COUNT(*) AS n FROM video_actress')) {
      const get = statement.get.bind(statement)
      statement.get = ((...params: unknown[]) => {
        const row = get(...params)
        if (!changed) {
          changed = true
          other.prepare('UPDATE library_video_memberships SET is_hidden=1 WHERE video_id=?').run(videoId)
        }
        return row
      }) as typeof statement.get
    }
    return statement
  }) as typeof db.prepare
  try {
    const before = listActressVideoPage(1)!
    assert.equal(changed, true)
    assert.equal(before.total, 1)
    assert.deepEqual(before.videos.map(video => video.id), [videoId])
    const after = listActressVideoPage(1)!
    assert.equal(after.total, 0)
    assert.deepEqual(after.videos, [])
  } finally {
    db.prepare = prepare
    other.close()
  }
})

it('reads complete profile metadata without querying any associated works', () => {
  const db = getDb()
  editActress(1, { main_name: 'Actor', name_zh: '中文名', aliases: ['Alias'], profile_summary: 'Profile text' })
  db.exec(`INSERT INTO actress_gallery_assets(actress_id,position,local_path) VALUES(1,2,'second.jpg'),(1,1,'first.jpg');
    INSERT INTO actress_links(actress_id,label,url,normalized_url) VALUES(1,'Official','https://example.test','https://example.test');
    INSERT INTO videos(id,code) VALUES(1,'WORK');
    INSERT INTO video_actress(video_id,actress_id) VALUES(1,1);`)
  const legacy = getActressDetail(1)!
  const { videos: _videos, ...expected } = legacy
  const prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => {
    assert.doesNotMatch(sql, /video_actress|video_resources|FROM videos|pending_video_scrapes/i)
    return prepare(sql)
  }) as typeof db.prepare
  try {
    const service = createActressQueryService({ getActress: () => { throw new Error('Full detail forbidden') } })
    const metadata = service.getMetadata(1)!
    assert.deepEqual(metadata, expected)
    assert.equal(metadata.profile_summary, 'Profile text')
    assert.equal(metadata.name_zh, '中文名')
    assert.ok(metadata.aliases.includes('Alias'))
    assert.deepEqual(metadata.gallery.map(item => item.local_path), ['first.jpg', 'second.jpg'])
    assert.equal(metadata.links[0].label, 'Official')
    assert.ok(!('videos' in metadata))
    assert.equal(service.getMetadata(999), null)
  } finally { db.prepare = prepare }
})

it('filters covers before counting and paging, retaining the old truthy-path semantics', () => {
  const db = getDb()
  const paths = [null, '', 'cover.jpg', ' ', '\0suffix', 'other.jpg']
  for (let n = 0; n < paths.length; n++) {
    const { videoId } = insertTestVideoWithFile(db, { code: `COVER-${n}`, filePath: `/synthetic/cover-${n}.mp4`, libraryId: 1, addTime: '2026-01-01' })
    db.prepare('UPDATE videos SET cover_path=? WHERE id=?').run(paths[n], videoId)
    db.prepare('INSERT INTO video_actress(video_id,actress_id) VALUES(?,1)').run(videoId)
  }
  const expected = getActressDetail(1)!.videos.filter(video => Boolean(video.cover_path)).map(video => video.id).sort((a,b) => a-b)
  const pages = [0,2].map(offset => listActressVideoPage(1, { withCover: true, limit: 2, offset })!)
  assert.deepEqual(pages.flatMap(page => page.videos.map(video => video.id)), expected)
  assert.equal(pages[0].total, 4)
  assert.equal(pages[1].total, 4)
  assert.equal(listActressVideoPage(1, { withCover: false })!.total, 6)
})
