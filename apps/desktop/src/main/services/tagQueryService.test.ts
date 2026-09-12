import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { closeDatabase, getDatabaseReadRevision, initDatabaseAtPath, openReadOnlyDatabaseAtPath } from '@library/db/database'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { createTagFilterOptionsReader, tagQueryService } from './tagQueryService'

let root: string | undefined
function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-tag-cache-'))
  const filename = path.join(root, 'library.db')
  const db = initDatabaseAtPath(filename)
  insertTestVideoWithFile(db, { code: 'CACHE-1', filePath: 'fixture.mp4', scrapedStatus: 0 })
  db.exec("INSERT INTO tags(id,name) VALUES(1,'Linked'); INSERT INTO video_tag(video_id,tag_id) VALUES(1,1)")
  return { db, filename }
}
afterEach(() => { closeDatabase(); if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined })

it('reuses canonical query pages, isolates caller mutations, and invalidates local and external writes', (t) => {
  const { db, filename } = setup()
  const prepare = db.prepare.bind(db)
  let reads = 0
  t.mock.method(db, 'prepare', (sql: string) => { if (sql.includes('FROM tags ')) reads++; return prepare(sql) })
  const original = tagQueryService.filterOptions({ search: ' LINKED ' })
  original.items[0].label = 'caller mutation'
  assert.equal(tagQueryService.filterOptions({ search: 'linked', offset: 0, limit: 100 }).items[0].label, 'Linked')
  assert.equal(reads, 1)
  db.exec('UPDATE library_video_memberships SET is_hidden=1')
  assert.equal(tagQueryService.filterOptions({ search: 'linked' }).items[0].video_count, 0)
  assert.equal(reads, 2)
  const external = new Database(filename)
  try { external.exec('UPDATE library_video_memberships SET is_hidden=0') } finally { external.close() }
  assert.equal(tagQueryService.filterOptions({ search: 'linked' }).items[0].video_count, 1)
  assert.equal(reads, 3)
  db.exec('CREATE INDEX cache_schema_probe ON tags(name,id)')
  tagQueryService.filterOptions({ search: 'linked' })
  assert.equal(reads, 4, 'same-connection DDL invalidates even without total_changes advancing')
  closeDatabase()
  const replacement = initDatabaseAtPath(filename)
  replacement.exec("UPDATE tags SET name='Changed' WHERE id=1")
  assert.deepEqual(tagQueryService.filterOptions({ search: 'linked' }), { items: [], hasMore: false })
})

it('bypasses cached pages inside transactions and never publishes data that is rolled back', () => {
  const { db } = setup()
  assert.equal(tagQueryService.filterOptions({}).items[0].video_count, 1)
  assert.throws(() => db.transaction(() => {
    db.exec('UPDATE library_video_memberships SET is_hidden=1')
    assert.equal(tagQueryService.filterOptions({}).items[0].video_count, 0)
    throw new Error('rollback')
  })(), /rollback/)
  assert.equal(tagQueryService.filterOptions({}).items[0].video_count, 1)
  db.transaction(() => {
    db.exec('UPDATE library_video_memberships SET is_hidden=1')
    assert.equal(tagQueryService.filterOptions({}).items[0].video_count, 0)
  })()
  assert.equal(tagQueryService.filterOptions({}).items[0].video_count, 0)
})

it('evicts least recently used pages and validates raw search before cache lookup', (t) => {
  const { db } = setup()
  const prepare = db.prepare.bind(db)
  let reads = 0
  t.mock.method(db, 'prepare', (sql: string) => { if (sql.includes('FROM tags ')) reads++; return prepare(sql) })
  for (let offset = 0; offset < 8; offset++) tagQueryService.filterOptions({ offset, limit: 1 })
  tagQueryService.filterOptions({ offset: 0, limit: 1 })
  assert.equal(reads, 8)
  tagQueryService.filterOptions({ offset: 8, limit: 1 })
  tagQueryService.filterOptions({ offset: 0, limit: 1 })
  assert.equal(reads, 9)
  tagQueryService.filterOptions({ offset: 1, limit: 1 })
  assert.equal(reads, 10)
  assert.throws(() => tagQueryService.filterOptions({ search: ' '.repeat(501) }))
  assert.equal(reads, 10)
  assert.deepEqual(tagQueryService.filterOptions({ search: 'İ'.repeat(500) }), { items: [], hasMore: false })
})

it('evicts by serialized byte budget before eight large pages accumulate', (t) => {
  const { db } = setup()
  const insert = db.prepare('INSERT INTO tags(id,name) VALUES(?,?)')
  db.transaction(() => { for (let id = 2; id <= 801; id++) insert.run(id, '\u0001'.repeat(128) + String(id).padStart(4,'0')) })()
  const prepare = db.prepare.bind(db)
  let reads = 0
  t.mock.method(db, 'prepare', (sql: string) => { if (sql.includes('FROM tags ')) reads++; return prepare(sql) })
  for (let offset = 0; offset < 700; offset += 100) {
    const page = tagQueryService.filterOptions({ offset })
    assert.ok(Buffer.byteLength(JSON.stringify(page)) > 75 * 1024)
  }
  assert.equal(reads, 7)
  tagQueryService.filterOptions({ offset: 0 })
  assert.equal(reads, 8, 'old page must be evicted by bytes before reaching the eight-entry cap')
})

it('observes an external commit during a read and refreshes on the next call', (t) => {
  const { db, filename } = setup()
  const external = new Database(filename)
  const prepare = db.prepare.bind(db)
  let commitDuringRead = true
  let reads = 0
  t.mock.method(db, 'prepare', (sql: string) => {
    if (sql.includes('FROM tags ')) reads++
    if (commitDuringRead && sql.includes('FROM video_tag')) {
      commitDuringRead = false
      // The tag page has already established the main connection's read snapshot.
      external.exec('UPDATE library_video_memberships SET is_hidden=1')
    }
    return prepare(sql)
  })
  try {
    assert.equal(tagQueryService.filterOptions({}).items[0].video_count, 1, 'in-progress read keeps its snapshot')
    assert.equal(commitDuringRead, false)
    assert.equal(tagQueryService.filterOptions({}).items[0].video_count, 0)
    assert.equal(reads, 2)
    assert.equal(tagQueryService.filterOptions({}).items[0].video_count, 0)
    assert.equal(reads, 2)
  } finally { external.close() }
})

it('does not cache a failed read and allows the same query to retry', (t) => {
  const { db } = setup()
  const prepare = db.prepare.bind(db)
  let fail = true
  t.mock.method(db, 'prepare', (sql: string) => {
    if (fail && sql.includes('FROM tags ')) { fail = false; throw new Error('read interrupted') }
    return prepare(sql)
  })
  assert.throws(() => tagQueryService.filterOptions({}), /read interrupted/)
  assert.equal(tagQueryService.filterOptions({}).items[0].video_count, 1)
})


it('separates connections even when their revision counters match', () => {
  setup()
  const first = getDatabaseReadRevision()
  assert.equal(tagQueryService.filterOptions({}).items[0].label, 'Linked')
  closeDatabase()
  const secondDb = initDatabaseAtPath(path.join(root!, 'second.db'))
  insertTestVideoWithFile(secondDb, { code: 'CACHE-1', filePath: 'fixture.mp4', scrapedStatus: 0 })
  secondDb.exec("INSERT INTO tags(id,name) VALUES(1,'Different'); INSERT INTO video_tag(video_id,tag_id) VALUES(1,1)")
  const second = getDatabaseReadRevision()
  assert.equal(first.changes, second.changes)
  assert.equal(first.dataVersion, second.dataVersion)
  assert.notEqual(first.connection, second.connection)
  assert.equal(tagQueryService.filterOptions({}).items[0].label, 'Different')
})


it('binds a separate cache and repository to a readonly connection, without using the writer getter', (t) => {
  const { db, filename } = setup()
  const reader = openReadOnlyDatabaseAtPath(filename)
  const read = createTagFilterOptionsReader(() => reader)
  const prepare = reader.prepare.bind(reader)
  let reads = 0
  t.mock.method(reader, 'prepare', (sql: string) => { if (sql.includes('FROM tags ')) reads++; return prepare(sql) })
  try {
    assert.equal(read({}).items[0].video_count, 1)
    assert.equal(read({}).items[0].video_count, 1)
    assert.equal(reads, 1)
    db.exec('UPDATE library_video_memberships SET is_hidden=1')
    assert.equal(read({}).items[0].video_count, 0)
    assert.equal(reads, 2)
    closeDatabase()
    assert.equal(read({}).items[0].video_count, 0, 'reader stays usable without global writer')
  } finally { reader.close() }
})
