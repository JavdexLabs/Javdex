import { getActressMetadata, getActressProfile } from './actressRepo'
import { resolveActressDetailDisplayBackgroundPath } from '@shared/detailDisplayBackground'
import { createActressQueryService } from '../../../../apps/desktop/src/main/services/actressQueryService'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { ActressGalleryAsset } from '@shared/actressTypes'
import { prepareActressGalleryForDisplay } from '@shared/mediaGalleryDisplay'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { listActressGalleryPage } from './actressGalleryPageRepo'

let root: string
let previous: string | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-gallery-page-'))
  previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
    initDatabaseAtPath(path.join(root, 'catalog.db'))
  getDb().exec("INSERT INTO actresses(id,main_name) VALUES(1,'Actor'),(2,'Empty')")
})
afterEach(() => {
  closeDatabase();   if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previous
  fs.rmSync(root, { recursive: true, force: true })
})

it('matches the complete renderer gallery order across source, ratio and nullable-position boundaries', () => {
  const db = getDb()
  const paths = [null, '', ' ', '\t\r\n', '\u00a0\ufeff\u3000', '\u200b', '\0tail', ' \0tail ', 'path.jpg']
  const dimensions = [[null,null],[0,1],[-1,1],[1,0],[1,2],[2,1],[1,1],[Infinity,1],[1,Infinity],[Infinity,Infinity],[1e308,1e-308]]
  const insert = db.prepare('INSERT INTO actress_gallery_assets(actress_id,local_path,remote_url,width,height,position) VALUES(1,?,?,?,?,?)')
  let index = 0
  db.transaction(() => {
    for (const local of paths) for (const remote of paths) for (const [width,height] of dimensions) {
      insert.run(local, remote, width, height, [null, -1, 0, 1, 1][index++ % 5])
    }
  })()
  const all = db.prepare('SELECT * FROM actress_gallery_assets WHERE actress_id=1 ORDER BY position,id').all() as ActressGalleryAsset[]
  const expected = prepareActressGalleryForDisplay(all)
  const actual: ActressGalleryAsset[] = []
  for (let offset = 0; offset < expected.length; offset += 60) {
    const page = listActressGalleryPage(1, { offset })!
    assert.equal(page.total, expected.length)
    assert.ok(page.items.length <= 60)
    actual.push(...page.items)
  }
  assert.deepEqual(actual, expected)
  const localExpected = expected.filter(asset => Boolean(asset.local_path))
  const localActual: ActressGalleryAsset[] = []
  for (let offset = 0; offset < localExpected.length; offset += 60) {
    const localPage = listActressGalleryPage(1, { offset, localOnly: true })!
    assert.equal(localPage.total, localExpected.length)
    localActual.push(...localPage.items)
  }
  assert.deepEqual(localActual, localExpected)
  assert.deepEqual(listActressGalleryPage(1, { limit: 1 })!.items, expected.slice(0, 1))
  assert.equal(listActressGalleryPage(1, { limit: 100 })!.items.length, 100)
})

it('returns empty versus missing actors and validates finite safe page bounds', () => {
  assert.deepEqual(listActressGalleryPage(2), { items: [], total: 0, limit: 60, offset: 0 })
  assert.equal(listActressGalleryPage(999), null)
  for (const id of [0,-1,1.5,Infinity]) assert.throws(() => listActressGalleryPage(id), /Invalid/)
  for (const limit of [0,101,1.5,Infinity,NaN]) assert.throws(() => listActressGalleryPage(1, { limit }), /Invalid/)
  for (const offset of [-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1]) assert.throws(() => listActressGalleryPage(1, { offset }), /Invalid/)
})

it('keeps count and ordered page together while another connection removes a display source', () => {
  const db = getDb()
  db.exec("INSERT INTO actress_gallery_assets(id,actress_id,local_path,width,height) VALUES(1,1,'image.jpg',2,1)")
  const other = new Database(path.join(root, 'catalog.db'))
  const prepare = db.prepare.bind(db)
  let changed = false
  db.prepare = ((sql: string) => {
    const statement = prepare(sql)
    if (sql.includes('SELECT COUNT(*) AS n FROM actress_gallery_assets')) {
      const get = statement.get.bind(statement)
      statement.get = ((...args: unknown[]) => {
        const value = get(...args)
        if (!changed) { changed = true; other.exec("UPDATE actress_gallery_assets SET local_path='' WHERE id=1") }
        return value
      }) as typeof statement.get
    }
    return statement
  }) as typeof db.prepare
  try {
    const before = listActressGalleryPage(1)!
    assert.equal(before.total, 1)
    assert.equal(before.items[0].local_path, 'image.jpg')
    const after = listActressGalleryPage(1)!
    assert.equal(after.total, 0)
    assert.deepEqual(after.items, [])
    assert.equal(changed, true)
  } finally { db.prepare = prepare; other.close() }
})

it('returns profile counts and the global first picture without loading complete works or gallery rows', () => {
  const db = getDb()
  db.exec(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001)
    INSERT INTO actress_gallery_assets(id,actress_id,position,local_path,width,height)
    SELECT x,1,x,CASE WHEN x%5=0 THEN ' ' ELSE 'gallery/'||x||'.jpg' END,CASE WHEN x%2=0 THEN 2 ELSE 1 END,1 FROM n;`)
  const legacy = getActressMetadata(1)!
  const { gallery, ...fields } = legacy
  const expected = prepareActressGalleryForDisplay(gallery)
  const prepare = db.prepare.bind(db)
  let galleryReads = 0
  db.prepare = ((sql: string) => {
    assert.doesNotMatch(sql, /video_actress|video_resources|FROM videos/i)
    const statement = prepare(sql)
    if (/SELECT \* FROM actress_gallery_assets/.test(sql)) {
      assert.match(sql, /LIMIT/)
      const all = statement.all.bind(statement)
      statement.all = ((...args: unknown[]) => {
        const rows = all(...args)
        galleryReads++
        assert.ok(rows.length <= 1)
        return rows
      }) as typeof statement.all
    }
    return statement
  }) as typeof db.prepare
  try {
    const service = createActressQueryService({ getMetadata: () => { throw new Error('Full gallery metadata forbidden') } })
    const profile = service.getProfile(1)!
    assert.deepEqual(profile, { ...fields, gallery_count: gallery.length, display_gallery_count: expected.length, first_gallery: expected[0] })
    assert.equal(galleryReads, 1)
    assert.ok(!('gallery' in profile) && !('videos' in profile))
    assert.equal(resolveActressDetailDisplayBackgroundPath(profile, true), resolveActressDetailDisplayBackgroundPath(legacy, true))
    assert.equal(resolveActressDetailDisplayBackgroundPath(profile, false), null)
    assert.equal(resolveActressDetailDisplayBackgroundPath({ ...profile, poster_path: ' explicit.jpg ' }, true), 'explicit.jpg')
    assert.equal(service.getProfile(999), null)
    const empty = service.getProfile(2)!
    assert.equal(empty.gallery_count, 0)
    assert.equal(empty.display_gallery_count, 0)
    assert.equal(empty.first_gallery, null)
  } finally { db.prepare = prepare }
  for (const id of [0,-1,NaN,1.5,Infinity]) assert.throws(() => getActressProfile(id), /Invalid/)
})

it('keeps profile fields, physical/display counts and first picture on one read snapshot', () => {
  const db = getDb()
  db.exec("INSERT INTO actress_gallery_assets(id,actress_id,local_path,width,height) VALUES(1,1,'old.jpg',1,2)")
  const other = new Database(path.join(root, 'catalog.db'))
  const prepare = db.prepare.bind(db)
  let changed = false
  db.prepare = ((sql: string) => {
    const statement = prepare(sql)
    if (sql === 'SELECT * FROM actresses WHERE id = ?') {
      const get = statement.get.bind(statement)
      statement.get = ((...args: unknown[]) => {
        const row = get(...args)
        if (!changed) { changed = true; other.exec("INSERT INTO actress_gallery_assets(id,actress_id,local_path,width,height) VALUES(2,1,'new.jpg',2,1)") }
        return row
      }) as typeof statement.get
    }
    return statement
  }) as typeof db.prepare
  try {
    const old = getActressProfile(1)!
    assert.equal(old.gallery_count, 1)
    assert.equal(old.display_gallery_count, 1)
    assert.equal(old.first_gallery!.id, 1)
    const next = getActressProfile(1)!
    assert.equal(next.gallery_count, 2)
    assert.equal(next.display_gallery_count, 2)
    assert.equal(next.first_gallery!.id, 2)
    assert.equal(changed, true)
  } finally { db.prepare = prepare; other.close() }
})

it('locates a stable photo after reordering, before paging and within the requested actor/source scope', () => {
  const db = getDb()
  const insert = db.prepare('INSERT INTO actress_gallery_assets(actress_id,local_path,position) VALUES(1,?,?)')
  for (let n = 0; n < 125; n++) insert.run(`photo-${n}.jpg`, n)
  const id = (db.prepare('SELECT id FROM actress_gallery_assets WHERE position=70').get() as {id:number}).id
  let page = listActressGalleryPage(1, { anchorId: id })!
  assert.equal(page.offset, 60)
  assert.equal(page.anchorIndex, 10)
  assert.equal(page.items[page.anchorIndex!].id, id)
  db.prepare('UPDATE actress_gallery_assets SET position=-1 WHERE id=?').run(id)
  page = listActressGalleryPage(1, { offset: 60, anchorId: id })!
  assert.equal(page.offset, 0)
  assert.equal(page.anchorIndex, 0)
  assert.equal(page.items[0].id, id)
  assert.equal(listActressGalleryPage(2, { anchorId: id })!.anchorIndex, null)
  db.prepare("UPDATE actress_gallery_assets SET local_path=NULL,remote_url='https://example.test/photo' WHERE id=?").run(id)
  assert.equal(listActressGalleryPage(1, { anchorId: id, localOnly: true })!.anchorIndex, null)
  db.prepare('DELETE FROM actress_gallery_assets WHERE id=?').run(id)
  assert.equal(listActressGalleryPage(1, { anchorId: id })!.anchorIndex, null)
  for (const anchorId of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER+1]) assert.throws(() => listActressGalleryPage(1, { anchorId }))
})
