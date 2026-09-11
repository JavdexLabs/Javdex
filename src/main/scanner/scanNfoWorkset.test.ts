import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import Database from 'better-sqlite3'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import { summarizeDirectoryVideoCodes } from '../nfo/directoryVideoIdentity'
import { createScanNfoWorkset, createMemoryScanNfoWorkset, ScanNfoWorksetError,
  SCAN_NFO_WORKSET_MAX_BYTES, type ScanNfoWorkset, type ScanNfoPreflight } from './scanNfoWorkset'

let db: Database.Database
beforeEach(() => { db = new Database(':memory:') })
afterEach(() => { if (db.open) db.close() })
function root(id = 1): MediaLibraryRoot {
  return { id, libraryId: 1, path: '/dir', normalizedPath: '/dir', realPath: null,
    normalizedRealPath: null, deviceId: null, inode: null, position: id, state: 'active', createdAt: '', updatedAt: '' }
}
function table(suffix: string) {
  return (db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' AND name LIKE ?").get(`scan_nfo_workset_%_${suffix}`) as {name: string}).name
}
function noTables() {
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'scan_nfo_workset_%'").all(), [])
}
function fails(fn: () => unknown, message: RegExp) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ScanNfoWorksetError)
    assert.ok(error.cause instanceof Error)
    assert.match(error.cause.message, message)
    return true
  })
}
function preflight(store: ScanNfoWorkset, file = '/dir/a', rootId = 1): ScanNfoPreflight {
  return { anchor: { root: root(rootId), anchorPath: file, directoryVideoCodes: store.getDirectoryIdentity('/dir')!, directorySidecars: store.getSidecars('/dir') },
    filenameCode: 'abc', nfoCode: 'ABC', effectiveCode: 'ABC', identityConflict: false,
    inspection: { status: 'found', code: ' ABC ', warnings: ['warning\0\ud800', 'x'.repeat(3000)] } }
}
function directories(store: ScanNfoWorkset) {
  store.setSidecars('/dir', new Map([['A.NFO', 'A.NFO'], ['a.nfo', 'A.NFO'], ['movie.nfo', 'movie.nfo']]))
  store.setDirectoryIdentity('/dir', summarizeDirectoryVideoCodes(['abc', 'ABC']))
  store.sealDirectories()
}

it('matches the memory oracle for exact strings, ordered maps, overwrites and first-video/duplicate-anchor order', () => {
  const sql = createScanNfoWorkset(db, [root(), root(2)]), memory = createMemoryScanNfoWorkset([root(), root(2)])
  const outputs = []
  for (const store of [sql, memory]) {
    const names = new Map([['\ud800', '\0'], ['\ud801', '�'], ['a\0b', '"\\'], ['ABC', 'abc']])
    store.setSidecars('dir\ud800', names)
    assert.equal(store.hasSidecars('dir\ud801'), false)
    const old = store.getSidecars('dir\ud800')!
    assert.deepEqual([...old], [...names])
    assert.deepEqual([...old.keys()], [...names.keys()])
    assert.deepEqual([...old.values()], [...names.values()])
    assert.equal(old.size, 4)
    assert.equal(old.get('\ud800'), '\0')
    assert.equal(old.has('missing'), false)
    const visited: string[] = []
    old.forEach(function (this: string[], value, key, map) { assert.equal(map, old); this.push(key + value) }, visited)
    assert.deepEqual(visited, [...names].map(([key, value]) => key + value))
    store.setSidecars('dir\ud800', new Map())
    assert.equal(store.getSidecars('dir\ud800')!.size, 0)
    assert.deepEqual([...old], [...names])
    directories(store)
    const first = preflight(store)
    store.setPreflight('key\ud800', first)
    store.setPreflight('key\ud800', { ...first, anchor: { ...first.anchor, root: root(2), anchorPath: '/dir/changed' }, effectiveCode: null })
    store.setPreflight('key\ud800', { ...first, inspection: { status: 'missing', code: null, warnings: [] } })
    assert.deepEqual(store.getEffectiveCode('key\ud800'), { effectiveCode: null })
    assert.equal(store.getEffectiveCode('key\ud801'), undefined)
    const fetched = store.getPreflight('key\ud800')!
    assert.equal(fetched.anchor.root.id, 2)
    assert.equal(fetched.anchor.anchorPath, '/dir/changed')
    fetched.inspection.warnings.length = 0
    assert.equal(store.getPreflight('key\ud800')!.inspection.warnings.length, 2)
    store.setPreflight('second', preflight(store, '/dir/b'))
    store.setPreflight('conflict', { ...first, identityConflict: true })
    store.sealPreflights()
    store.enqueue(8, 'first', 'key\ud800'); store.enqueue(2, 'second', 'second')
    store.enqueue(8, 'ignored later code', 'key\ud800'); store.enqueue(9, 'x', 'missing'); store.enqueue(9, 'x', 'conflict')
    store.sealQueue()
    const batches = [...store.batches()]
    assert.deepEqual(batches.map(([id, batch]) => [id, batch.code, batch.anchors.length]), [[8, 'first', 2], [2, 'second', 1]])
    assert.equal(batches[0][1].anchors[0].directoryVideoCodes, batches[0][1].anchors[1].directoryVideoCodes)
    assert.equal(batches[0][1].anchors[0].directorySidecars, batches[0][1].anchors[1].directorySidecars)
    outputs.push(batches.map(([id, batch]) => [id, batch.code, batch.anchors.map(anchor => ({ ...anchor, directorySidecars: [...anchor.directorySidecars!] }))]))
    assert.equal([...store.batches()].length, 2)
    store.dispose(); store.dispose()
  }
  assert.deepEqual(outputs[0], outputs[1]); noTables()
})

it('keeps only a last-directory identity snapshot and preserves frozen roots against external mutation', () => {
  const mutable = root(), store = createScanNfoWorkset(db, [mutable])
  const summary = summarizeDirectoryVideoCodes(['ABC'])
  store.setDirectoryIdentity('/dir', summary)
  const first = store.getDirectoryIdentity('/dir')!
  assert.equal(first, store.getDirectoryIdentity('/dir'))
  store.setDirectoryIdentity('/dir', summarizeDirectoryVideoCodes(['ABC', null]))
  assert.equal(first.count, 1)
  assert.notEqual(first, store.getDirectoryIdentity('/dir'))
  store.sealDirectories()
  store.setPreflight('a', preflight(store))
  mutable.path = '/changed'
  assert.equal(store.getPreflight('a')!.anchor.root.path, '/dir')
  assert.ok(Object.isFrozen(store.getPreflight('a')!.anchor.root))
  store.dispose()
})

it('supports paused sidecar/batch iterators and nested writes, without all-row queries or active cursors', () => {
  const original = db.prepare, prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => {
    const statement = prepare(sql)
    statement.all = (() => { throw new Error('unbounded all forbidden') }) as typeof statement.all
    statement.iterate = (() => { throw new Error('active iterator forbidden') }) as typeof statement.iterate
    return statement
  }) as typeof db.prepare
  try {
    const store = createScanNfoWorkset(db, [root()])
    directories(store)
    const cursor = store.getSidecars('/dir')!.entries()
    assert.equal(cursor.next().value?.[0], 'A.NFO')
    db.exec('CREATE TABLE business(value INTEGER)')
    db.transaction(() => db.transaction(() => db.prepare('INSERT INTO business VALUES(1)').run())())()
    assert.equal(cursor.next().value?.[0], 'a.nfo')
    store.setPreflight('a', preflight(store)); store.sealPreflights()
    store.enqueue(1, 'a', 'a'); store.enqueue(2, 'b', 'a'); store.sealQueue()
    const batches = store.batches()[Symbol.iterator]()
    assert.equal(batches.next().value?.[0], 1)
    db.transaction(() => {
      assert.equal(store.getPreflight('a')!.anchor.directorySidecars!.get('movie.nfo'), 'movie.nfo')
      db.prepare('INSERT INTO business VALUES(2)').run()
    })()
    assert.equal(batches.next().value?.[0], 2)
    store.dispose()
  } finally { db.prepare = original }
})

it('native sidecar and preflight writes roll back and retry without losing the old snapshot', () => {
  const store = createScanNfoWorkset(db, [root()])
  store.setSidecars('/dir', new Map([['old', 'old']]))
  const s = table('sidecars')
  db.exec(`CREATE TEMP TRIGGER sidecar_fault BEFORE INSERT ON ${s} WHEN NEW.ordinal=2 BEGIN SELECT RAISE(ABORT,'sidecar fault'); END`)
  fails(() => store.setSidecars('/dir', new Map([['a', 'a'], ['b', 'b']])), /sidecar fault/)
  assert.deepEqual([...store.getSidecars('/dir')!], [['old', 'old']])
  db.exec('DROP TRIGGER sidecar_fault')
  directories(store)
  store.setPreflight('a', preflight(store))
  const p = table('preflights')
  db.exec(`CREATE TEMP TRIGGER preflight_fault AFTER UPDATE ON ${p} BEGIN SELECT RAISE(ABORT,'preflight fault'); END`)
  fails(() => store.setPreflight('a', { ...preflight(store), effectiveCode: 'changed' }), /preflight fault/)
  assert.deepEqual(store.getEffectiveCode('a'), { effectiveCode: 'ABC' })
  db.exec('DROP TRIGGER preflight_fault')
  store.setPreflight('a', { ...preflight(store), effectiveCode: 'changed' })
  assert.deepEqual(store.getEffectiveCode('a'), { effectiveCode: 'changed' })
  store.dispose()
})

it('native queue failure rolls back first-video insertion and duplicate retry order', () => {
  const store = createScanNfoWorkset(db, [root()]); directories(store)
  store.setPreflight('a', preflight(store)); store.sealPreflights()
  const q = table('queue')
  db.exec(`CREATE TEMP TRIGGER queue_fault BEFORE INSERT ON ${q} BEGIN SELECT RAISE(ABORT,'queue fault'); END`)
  fails(() => store.enqueue(3, 'failed', 'a'), /queue fault/)
  db.exec('DROP TRIGGER queue_fault')
  store.enqueue(2, 'first', 'a'); store.enqueue(3, 'retry', 'a'); store.sealQueue()
  assert.deepEqual([...store.batches()].map(([id, batch]) => [id, batch.code]), [[2, 'first'], [3, 'retry']])
  store.dispose()
})

it('enforces budgets without truncation, lifecycle and external transaction guards', () => {
  fails(() => db.transaction(() => createScanNfoWorkset(db, [root()]))(), /caller transaction/)
  const store = createScanNfoWorkset(db, [root()])
  fails(() => store.setSidecars('/dir', new Map([['a', 'x'.repeat(SCAN_NFO_WORKSET_MAX_BYTES)]])), /1 MiB/)
  assert.equal(store.hasSidecars('/dir'), false)
  db.transaction(() => {
    fails(() => store.setSidecars('/dir', new Map()), /caller transaction/)
    fails(() => store.sealDirectories(), /caller transaction/)
    fails(() => store.dispose(), /caller transaction/)
  })()
  directories(store)
  fails(() => store.setSidecars('/dir', new Map()), /directories/)
  fails(() => store.setPreflight('a', { ...preflight(store), inspection: { status: 'found', code: 'ABC', warnings: ['x'.repeat(SCAN_NFO_WORKSET_MAX_BYTES)] } }), /1 MiB/)
  assert.equal(store.getPreflight('a'), undefined)
  store.setPreflight('a', preflight(store)); store.sealPreflights()
  fails(() => store.setPreflight('a', preflight(store)), /preflights/)
  fails(() => store.batches(), /sealed/)
  store.sealQueue(); fails(() => store.enqueue(1, 'x', 'a'), /queue/)
  store.dispose(); fails(() => store.hasSidecars('/dir'), /closed/)
})

it('wraps native reads and rolls all-table cleanup back for retry; closed database is safe', () => {
  const store = createScanNfoWorkset(db, [root()]); directories(store)
  const s = table('sidecars'), map = store.getSidecars('/dir')!
  db.exec(`ALTER TABLE ${s} RENAME TO hidden_sidecars`)
  fails(() => map.get('a'), /no such table/)
  db.exec(`ALTER TABLE hidden_sidecars RENAME TO ${s}`)
  assert.equal(map.size, 3)
  const original = db.exec, exec = db.exec.bind(db)
  let drops = 0
  db.exec = ((sql: string) => { if (sql.startsWith('DROP TABLE') && ++drops === 2) throw new Error('drop fault'); return exec(sql) }) as typeof db.exec
  try { fails(() => store.dispose(), /drop fault/) } finally { db.exec = original }
  assert.equal(drops, 2)
  assert.deepEqual(db.prepare("SELECT count(*) AS count FROM sqlite_temp_master WHERE type='table' AND name LIKE 'scan_nfo_workset_%'").get(), { count: 5 })
  store.dispose(); noTables()
  const closed = createScanNfoWorkset(db, [root()]); db.close(); closed.dispose()
})

it('factory invalid roots and prepare failures leave no TEMP objects', () => {
  fails(() => createScanNfoWorkset(db, [root(), root()]), /Invalid/); noTables()
  const original = db.prepare, prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => { if (sql.includes('SELECT body,effective')) throw new Error('prepare fault'); return prepare(sql) }) as typeof db.prepare
  try { fails(() => createScanNfoWorkset(db, [root()]), /prepare fault/) } finally { db.prepare = original }
  noTables()
})


it('summary enqueue joins the outer business transaction and retries with fresh first-code/order', () => {
  const store = createScanNfoWorkset(db, [root()]); directories(store)
  store.setPreflight('a', preflight(store)); store.sealPreflights()
  db.exec('CREATE TABLE business(value INTEGER)')
  assert.throws(() => db.transaction(() => {
    db.prepare('INSERT INTO business VALUES(1)').run()
    store.enqueue(9, 'rolled back', 'a')
    store.enqueue(9, 'duplicate', 'a')
    throw new Error('business rollback')
  })(), /business rollback/)
  assert.deepEqual(db.prepare('SELECT * FROM business').all(), [])
  db.transaction(() => {
    db.prepare('INSERT INTO business VALUES(2)').run()
    store.enqueue(2, 'first', 'a')
    store.enqueue(9, 'retry', 'a')
    store.enqueue(9, 'ignored later code', 'a')
  })()
  store.sealQueue()
  assert.deepEqual([...store.batches()].map(([id, batch]) => [id, batch.code, batch.anchors.length]), [[2, 'first', 1], [9, 'retry', 2]])
  store.dispose()
})

it('detailed materialized sidecar snapshots remain usable on returned anchors after disposal', () => {
  const store = createMemoryScanNfoWorkset([root()]); directories(store)
  store.setPreflight('a', preflight(store)); store.sealPreflights()
  store.enqueue(1, 'ABC', 'a'); store.sealQueue()
  const anchor = [...store.batches()][0][1].anchors[0]
  assert.ok(anchor.directorySidecars instanceof Map)
  store.dispose()
  assert.equal(anchor.directorySidecars.get('movie.nfo'), 'movie.nfo')
  assert.deepEqual([...anchor.directorySidecars], [['A.NFO', 'A.NFO'], ['a.nfo', 'A.NFO'], ['movie.nfo', 'movie.nfo']])
})


it('wraps lazy iterator decoding failures and permits reads to recover after raw storage repair', () => {
  const store = createScanNfoWorkset(db, [root()]); directories(store)
  const s = table('sidecars')
  db.prepare(`UPDATE ${s} SET value='invalid JSON' WHERE ordinal=1`).run()
  const map = store.getSidecars('/dir')!
  fails(() => map.entries().next(), /JSON|Unexpected/)
  db.prepare(`UPDATE ${s} SET value=? WHERE ordinal=1`).run(JSON.stringify('A.NFO'))
  assert.equal(map.entries().next().value?.[1], 'A.NFO')
  store.dispose()
})

it('memory oracle traverses large sidecar snapshots and many duplicate video queues in exact order', () => {
  const store = createMemoryScanNfoWorkset([root()])
  const pairs = Array.from({ length: 5000 }, (_, index) => [`${index}.nfo`, `file-${index}.nfo`] as [string, string])
  store.setSidecars('/dir', new Map(pairs))
  store.setDirectoryIdentity('/dir', summarizeDirectoryVideoCodes(['ABC']))
  assert.deepEqual([...store.getSidecars('/dir')!], pairs)
  store.sealDirectories()
  store.setPreflight('a', preflight(store)); store.sealPreflights()
  for (let repeat = 0; repeat < 3; repeat++) {
    for (let video = 600; video > 0; video--) store.enqueue(video, `code-${video}`, 'a')
  }
  store.sealQueue()
  let expected = 600
  for (const [video, batch] of store.batches()) {
    assert.equal(video, expected--)
    assert.equal(batch.code, `code-${video}`)
    assert.equal(batch.anchors.length, 3)
    assert.equal(batch.anchors[0].directorySidecars!.get('4999.nfo'), 'file-4999.nfo')
    assert.equal(batch.anchors[0].directorySidecars, batch.anchors[2].directorySidecars)
  }
  assert.equal(expected, 0)
  store.dispose()
})
