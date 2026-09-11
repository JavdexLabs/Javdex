import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createRevisionReadCache } from './revisionReadCache'
import { createScopedVideoCatalogRepo } from './scopedVideoCatalogRepo'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { getActressMetadata, listActressPage } from './actressRepo'
import { toActressCardPage, toScopedVideoCardPage } from '@shared/cardProjection'
import { createActressQueryService } from '../services/actressQueryService'
import { resetSettingsCacheForTests } from '../settings/settingsStore'

test('memo revisions preserve hits, distinguish same-total reorder, WAL snapshots, rollback and reopen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-list-revision-'))
  const filename = path.join(root, 'test.db')
  const db = new Database(filename)
  db.pragma('journal_mode=WAL')
  db.exec('CREATE TABLE data(id INTEGER PRIMARY KEY, rank INTEGER); INSERT INTO data VALUES(1,1),(2,2)')
  const other = new Database(filename)
  try {
    const cache = createRevisionReadCache(db, { page: { maxEntries: 4, maxBytes: 1024 } })
    let loads = 0
    const read = () => cache.read(memo => ({
      revision: memo.revision,
      rows: memo.get('page', 'all', () => { loads++; return db.prepare('SELECT id FROM data ORDER BY rank').all() })
    }))
    const initial = read()
    assert.deepEqual(read(), initial); assert.equal(loads, 1)
    other.exec('UPDATE data SET rank=3-rank')
    const reordered = read()
    assert.notEqual(reordered.revision, initial.revision)
    assert.deepEqual(reordered.rows, [{ id: 2 }, { id: 1 }])
    const pinned = cache.read(memo => {
      other.exec('UPDATE data SET rank=3-rank')
      return { revision: memo.revision, rows: db.prepare('SELECT id FROM data ORDER BY rank').all() }
    })
    assert.deepEqual(pinned, reordered)
    assert.notEqual(read().revision, pinned.revision)
    let rolledBackRevision = ''
    assert.throws(() => db.transaction(() => {
      db.exec('UPDATE data SET rank=3-rank')
      rolledBackRevision = read().revision
      throw new Error('rollback')
    })(), /rollback/)
    assert.notEqual(read().revision, rolledBackRevision)
    const beforeSchema = read().revision
    other.exec('ALTER TABLE data ADD COLUMN extra TEXT')
    assert.notEqual(read().revision, beforeSchema)
    const reopened = new Database(filename)
    try {
      const fresh = createRevisionReadCache(reopened, {}).read(memo => memo.revision)
      assert.notEqual(fresh, read().revision)
    } finally { reopened.close() }
  } finally { other.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('native video and actress pages expose snapshot identity; avatar snapshots retain their own identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-native-list-revision-'))
  const previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
  resetSettingsCacheForTests()
  let other: Database.Database | undefined
  try {
    initDatabaseAtPath(path.join(root, 'catalog.db'))
    const db = getDb()
    db.exec(`INSERT INTO actresses(id,main_name,gender) VALUES(1,'A','female'),(2,'B','female');
      INSERT INTO videos(id,code,title) VALUES(1,'AA-1','A'),(2,'AA-2','B');
      INSERT INTO library_video_memberships(library_id,video_id,added_at,updated_at,added_via,discovery_key)
      VALUES(1,1,'now','now','scan',1),(1,2,'now','now','scan',2)`)
    const repo = createScopedVideoCatalogRepo(db)
    const first = repo.list({ kind: 'all' }, { limit: 1 })
    const second = repo.list({ kind: 'all' }, { limit: 1, offset: 1 })
    assert.equal(typeof first.readRevision, 'string')
    assert.equal(first.readRevision, second.readRevision)
    db.exec("UPDATE videos SET title='changed' WHERE id=1")
    assert.notEqual(repo.list({ kind: 'all' }).readRevision, first.readRevision)
    const actor = listActressPage({ limit: 1 })
    assert.equal(actor.readRevision, listActressPage({ limit: 1, offset: 1 }).readRevision)
    other = new Database(db.name)
    other.exec("UPDATE actresses SET main_name='Z' WHERE id=1")
    assert.notEqual(listActressPage({ limit: 1 }).readRevision, actor.readRevision)
    const service = createActressQueryService({ inspectImage: () => ({ usable: true, fingerprint: 'fp' }) })
    const avatar = service.listActresses({ avatar: 'with', limit: 1 })
    assert.equal(service.listActresses({ avatar: 'with', limit: 1, offset: 1 }).readRevision, avatar.readRevision)
    assert.notEqual(service.listActresses({ avatar: 'with', limit: 1 }).readRevision, avatar.readRevision)
    const long = 'metadata'.repeat(200_000)
    db.prepare('UPDATE videos SET summary=?, original_title=? WHERE id=1').run(long, long)
    db.prepare('UPDATE actresses SET profile_summary=?, avatar_crop_json=? WHERE id=1').run(long, long)
    const wideVideos = repo.list({ kind: 'all' })
    const cards = toScopedVideoCardPage(wideVideos)
    assert.equal(cards.readRevision, wideVideos.readRevision)
    assert.ok(Buffer.byteLength(JSON.stringify(cards)) < 4096)
    assert.equal(repo.get({ kind: 'all' }, 1)?.summary, long)
    const wideActors = listActressPage()
    const actorCards = toActressCardPage(wideActors)
    assert.equal(actorCards.readRevision, wideActors.readRevision)
    assert.ok(Buffer.byteLength(JSON.stringify(actorCards)) < 4096)
    assert.equal(getActressMetadata(1)?.profile_summary, long)
    assert.equal(wideActors.items.find(row => row.id === 1)?.avatar_crop_json, long)
  } finally {
    other?.close(); closeDatabase(); resetSettingsCacheForTests()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
