import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initDatabaseAtPath, closeDatabase } from '../db/database'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { WebCatalogQueryReader } from './catalogQueryReader'
import { WebCatalog } from './catalog'

let root: string
let previous: string | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-web-query-'))
  previous = process.env.JAVDEX_TEST_USER_DATA; process.env.JAVDEX_TEST_USER_DATA = root
})
afterEach(() => {
  closeDatabase()
  if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previous
  fs.rmSync(root, { recursive: true, force: true })
})
function setup(count = 75) {
  const db = initDatabaseAtPath(path.join(root, 'catalog.db'))
  for (let i = 0; i < count; i++) insertTestVideoWithFile(db, { code: `WEB-${i}`, filePath: `/synthetic/${i}.mp4` })
  db.exec("INSERT INTO playlists(id,name) VALUES(1,'List'); INSERT INTO playlist_video(playlist_id,video_id) VALUES(1,1)")
  return { db, reader: new WebCatalogQueryReader(db) }
}
it('reuses count across pages, caches bounded pages/collections and isolates returned objects', t => {
  const { db, reader } = setup()
  const sql: string[] = [], prepare = db.prepare.bind(db)
  t.mock.method(db, 'prepare', (query: string) => { sql.push(query); return prepare(query) })
  const first = reader.browse({})
  const second = reader.browse({ page: 2 })
  assert.equal(first.total, 75); assert.equal(second.items.length, 36)
  assert.equal(sql.filter(query => query.startsWith('SELECT COUNT(*) AS count FROM videos')).length, 1)
  const before = sql.length
  first.items[0].title = 'mutated'
  assert.notEqual(reader.browse({}).items[0].title, 'mutated')
  assert.equal(sql.length, before)
  const collection = reader.collections(), after = sql.length
  collection.libraries[0].name = 'mutated'
  assert.notEqual(reader.collections().libraries[0].name, 'mutated')
  assert.equal(sql.length, after)
  // Eviction is bounded to eight page keys; a ninth distinct page evicts the oldest.
  for (let page = 3; page <= 9; page++) reader.browse({ page })
  const evicted = sql.length
  reader.browse({})
  assert.ok(sql.length > evicted)
})
it('pins count and cards to one snapshot when another WAL connection commits after count', t => {
  const { db, reader } = setup(1), external = new Database(db.name)
  const prepare = db.prepare.bind(db)
  let committed = false
  t.mock.method(db, 'prepare', (query: string) => {
    if (!committed && query.startsWith('SELECT v.* FROM videos')) {
      committed = true
      external.exec('UPDATE library_video_memberships SET is_hidden=1')
    }
    return prepare(query)
  })
  try {
    const current = reader.browse({})
    assert.equal(committed, true)
    assert.equal(current.total, 1); assert.equal(current.items.length, 1)
    const next = reader.browse({})
    assert.equal(next.total, 0); assert.equal(next.items.length, 0)
  } finally { external.close() }
})
it('pins both collection queries and invalidates external writes on the following request', t => {
  const { db, reader } = setup(1), external = new Database(db.name)
  const prepare = db.prepare.bind(db)
  let committed = false
  t.mock.method(db, 'prepare', (query: string) => {
    if (!committed && query.includes('SELECT p.id, p.name, COUNT(v.id)')) {
      committed = true; external.exec('UPDATE library_video_memberships SET is_hidden=1')
    }
    return prepare(query)
  })
  try {
    const current = reader.collections()
    assert.equal(committed, true)
    assert.equal(current.libraries[0].count, 1); assert.equal(current.playlists[0].count, 1)
    const next = reader.collections()
    assert.equal(next.libraries[0].count, 0); assert.deepEqual(next.playlists, [])
  } finally { external.close() }
})
it('bypasses cache inside caller transactions without publishing rolled-back state', () => {
  const { db, reader } = setup(1)
  assert.equal(reader.browse({}).total, 1)
  assert.throws(() => db.transaction(() => {
    db.exec('UPDATE library_video_memberships SET is_hidden=1')
    assert.equal(reader.browse({}).total, 0)
    throw new Error('rollback')
  })(), /rollback/)
  assert.deepEqual(reader.browse({}), new WebCatalog(db).browse(new URLSearchParams()))
})
