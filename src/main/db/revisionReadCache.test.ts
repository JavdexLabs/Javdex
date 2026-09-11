import assert from 'node:assert/strict'
import { it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createRevisionReadCache } from './revisionReadCache'

it('bounds entries and encoded bytes, rejects oversize without truncation and isolates mutation', () => {
  const db = new Database(':memory:')
  try {
    const cache = createRevisionReadCache(db, { pages: { maxEntries: 2, maxBytes: 64 } })
    let loads = 0
    const read = (key: string, value = 'ok') => cache.read(memo => memo.get('pages', key, () => { loads++; return { values: [value] } }))
    read('a').values[0] = 'mutated'
    assert.deepEqual(read('a'), { values: ['ok'] })
    read('b'); read('c'); read('a')
    assert.equal(loads, 4)
    assert.equal(read('large', '字'.repeat(100)).values[0].length, 100)
    read('large', '字'.repeat(100))
    assert.equal(loads, 6)
    const byBytes = createRevisionReadCache(db, { tiny: { maxEntries: 99, maxBytes: 10 } })
    let byteLoads = 0
    const tiny = (key: string) => byBytes.read(m => m.get('tiny', key, () => { byteLoads++; return '字' }))
    tiny('a'); tiny('b'); tiny('a')
    assert.equal(byteLoads, 3) // Each entry is 1 + 5 encoded UTF-8 bytes.
    const fresh = createRevisionReadCache(db, { pages: { maxEntries: 2, maxBytes: 64 } })
    fresh.read(m => m.get('pages', 'a', () => { loads++; return 'fresh instance' }))
    assert.equal(loads, 7)
  } finally { db.close() }
})

it('bypasses outer transactions and never publishes failed or rolled-back reads', () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE data(value); INSERT INTO data VALUES(1)')
    const cache = createRevisionReadCache(db, { data: { maxEntries: 2, maxBytes: 1024 } })
    let loads = 0
    const read = () => cache.read(m => m.get('data', 'key', () => { loads++; return db.prepare('SELECT value FROM data').get() }))
    assert.deepEqual(read(), { value: 1 }); read(); assert.equal(loads, 1)
    assert.throws(() => db.transaction(() => {
      db.exec('UPDATE data SET value=2')
      assert.deepEqual(read(), { value: 2 }); read()
      throw new Error('rollback')
    })(), /rollback/)
    assert.deepEqual(read(), { value: 1 }); assert.equal(loads, 4)
    assert.throws(() => cache.read(m => {
      m.get('data', 'failed', () => 'must not publish')
      throw new Error('reader failure')
    }), /reader failure/)
    assert.equal(cache.read(m => m.get('data', 'failed', () => 'fresh')), 'fresh')
    db.exec('UPDATE data SET value=3')
    assert.deepEqual(read(), { value: 3 })
  } finally { db.close() }
})

it('invalidates external writes/schema and pins cached count with fresh page to one WAL snapshot', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-read-cache-'))
  const db = new Database(path.join(directory, 'catalog.db'))
  db.pragma('journal_mode=WAL')
  db.exec('CREATE TABLE data(value); INSERT INTO data VALUES(1)')
  const other = new Database(db.name)
  try {
    const cache = createRevisionReadCache(db, { data: { maxEntries: 8, maxBytes: 2048 } })
    let loads = 0
    const read = () => cache.read(m => m.get('data', 'count', () => { loads++; return db.prepare('SELECT COUNT(*) AS n FROM data').get() as {n: number} }))
    assert.equal(read().n, 1); read(); assert.equal(loads, 1)
    other.exec('INSERT INTO data VALUES(2)')
    assert.equal(read().n, 2)
    other.exec('ALTER TABLE data ADD COLUMN extra TEXT')
    assert.equal(read().n, 2); assert.equal(loads, 3)
    const during = cache.read(m => {
      const count = m.get('data', 'count', () => { throw new Error('expected warm count') })
      other.exec('INSERT INTO data(value) VALUES(3)')
      const rows = db.prepare('SELECT value FROM data').all()
      m.get('data', 'race', () => 'old snapshot')
      return { count, rows }
    })
    assert.deepEqual(during, { count: { n: 2 }, rows: [{value: 1}, {value: 2}] })
    assert.equal(read().n, 3)
    assert.equal(cache.read(m => m.get('data', 'race', () => 'new snapshot')), 'new snapshot')
  } finally { other.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})


it('preserves own undefined fields and other non-JSON shapes by bypassing admission', () => {
  const db = new Database(':memory:')
  try {
    const cache = createRevisionReadCache(db, { data: { maxEntries: 8, maxBytes: 1024 } })
    for (const value of [{ optional: undefined }, [undefined], { n: NaN }, { n: -0 }]) {
      let loads = 0
      const read = () => cache.read(m => m.get('data', 'shape', () => { loads++; return value }))
      assert.deepEqual(read(), value)
      assert.deepEqual(read(), value)
      assert.equal(loads, 2)
    }
  } finally { db.close() }
})
