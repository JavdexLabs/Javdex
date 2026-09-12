import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import Database from 'better-sqlite3'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import { createMemoryScanFileInventory, createScanFileSpool, SCAN_FILE_INVENTORY_MAX_BYTES } from './scanFileInventory'

let db: Database.Database
beforeEach(() => { db = new Database(':memory:') })
afterEach(() => { if (db.open) db.close() })
function root(id: number): MediaLibraryRoot {
  return { id, libraryId: 1, path: `/root${id}`, normalizedPath: `/root${id}`, realPath: null,
    normalizedRealPath: null, deviceId: null, inode: null, position: id, state: 'active', createdAt: '', updatedAt: '' }
}
function table(): string {
  return (db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' AND name LIKE 'scan_file_inventory_%'").get() as { name: string }).name
}
function noTables() {
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' AND name LIKE 'scan_file_inventory_%'").all(), [])
}

it('matches memory over three pages, duplicates and root order, with reusable immutable root snapshots', () => {
  const mutable = root(1), frozen = Object.freeze(root(2)), roots = [mutable, frozen]
  const spool = createScanFileSpool(db, roots), memory = createMemoryScanFileInventory(roots)
  let flushes = 0
  for (let index = 0; index < 777; index++) {
    const file = `/exact/../Case/${index % 13}`
    if (spool.append(file, index % 2 + 1)) flushes++
    memory.append(file, index % 2 + 1)
  }
  assert.equal(flushes, 3)
  mutable.path = '/mutated'
  spool.seal(); memory.seal(); spool.seal()
  assert.deepEqual([...spool], [...memory])
  assert.deepEqual([...spool], [...memory])
  assert.equal([...spool][0].root.path, '/root1')
  assert.equal([...spool][1].root, frozen)
  spool.dispose(); spool.dispose(); memory.dispose(); noTables()
})

it('projects paths only after row and byte-limited narrow preflight, including UTF8', () => {
  const spool = createScanFileSpool(db, [root(1)])
  const file = '界'.repeat(150000)
  for (let index = 0; index < 7; index++) spool.append(file, 1)
  spool.seal()
  const original = db.prepare, prepare = db.prepare.bind(db)
  const payloadPages: number[] = []
  db.prepare = ((sql: string) => {
    const statement = prepare(sql), all = statement.all.bind(statement)
    if (sql.includes('FROM temp.scan_file_inventory_')) {
      assert.match(sql, /LIMIT 256/)
      statement.all = ((...args: unknown[]) => {
        const rows = all(...args)
        assert.ok(rows.length <= 256)
        if (sql.startsWith('SELECT ordinal,root_id,path')) {
          assert.match(sql, /ordinal<=\?/)
          const bytes = rows.reduce<number>((sum, row) => sum + Buffer.byteLength((row as {path: string}).path), 0)
          assert.ok(bytes <= SCAN_FILE_INVENTORY_MAX_BYTES)
          payloadPages.push(rows.length)
        } else assert.match(sql, /^SELECT ordinal,path_bytes /)
        return rows
      }) as typeof statement.all
    }
    return statement
  }) as typeof db.prepare
  try { assert.equal([...spool].length, 7) } finally { db.prepare = original }
  assert.deepEqual(payloadPages, [2, 2, 2, 1])
  spool.dispose()
})

it('allows nested business transactions while readers are paused without a live SQLite cursor', () => {
  const spool = createScanFileSpool(db, [root(1)])
  for (let index = 0; index < 600; index++) spool.append(String(index), 1)
  spool.seal()
  db.exec('CREATE TABLE business(value INTEGER)')
  const reader = spool[Symbol.iterator]()
  assert.equal(reader.next().value.filePath, '0')
  db.transaction(() => {
    db.transaction(() => db.prepare('INSERT INTO business VALUES(1)').run())()
  })()
  assert.equal(reader.next().value.filePath, '1')
  assert.equal([...spool].length, 600)
  reader.return?.()
  spool.dispose()
})

it('native flush failure rolls back the batch; retry accepts the failed append once', () => {
  const spool = createScanFileSpool(db, [root(1)]), name = table()
  db.exec(`CREATE TEMP TRIGGER fail_inventory BEFORE INSERT ON ${name}
    WHEN NEW.ordinal=100 BEGIN SELECT RAISE(ABORT,'native inventory fault'); END`)
  for (let index = 0; index < 255; index++) assert.equal(spool.append(String(index), 1), false)
  assert.throws(() => spool.append('255', 1), /native inventory fault/)
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get(), { count: 0 })
  db.exec('DROP TRIGGER fail_inventory')
  assert.equal(spool.append('255', 1), true)
  spool.seal()
  assert.deepEqual([...spool].map(row => row.filePath), Array.from({ length: 256 }, (_, index) => String(index)))
  spool.dispose()
})

it('seal flush failure retains buffered rows for retry', () => {
  const spool = createScanFileSpool(db, [root(1)]), name = table()
  spool.append('one', 1); spool.append('two', 1)
  db.exec(`CREATE TEMP TRIGGER fail_inventory BEFORE INSERT ON ${name}
    WHEN NEW.ordinal=2 BEGIN SELECT RAISE(ABORT,'seal fault'); END`)
  assert.throws(() => spool.seal(), /seal fault/)
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get(), { count: 0 })
  db.exec('DROP TRIGGER fail_inventory')
  spool.seal()
  assert.deepEqual([...spool].map(row => row.filePath), ['one', 'two'])
  spool.dispose()
})

it('enforces lifecycle, known roots and single path bounds in both inventories', () => {
  for (const inventory of [createScanFileSpool(db, [root(1)]), createMemoryScanFileInventory([root(1)])]) {
    assert.throws(() => [...inventory], /sealed/)
    assert.throws(() => inventory.append('path', 2), /Unknown/)
    assert.throws(() => inventory.append('x'.repeat(SCAN_FILE_INVENTORY_MAX_BYTES + 1), 1), /1 MiB/)
    inventory.append('valid', 1)
    inventory.seal()
    assert.throws(() => inventory.append('later', 1), /sealed/)
    assert.equal([...inventory].length, 1)
    inventory.dispose(); inventory.dispose()
    assert.throws(() => [...inventory], /closed/)
  }
  assert.throws(() => createScanFileSpool(db, [root(1), root(1)]), /Invalid/)
  noTables()
})

it('retries failed disposal and safely disposes after the database closes', () => {
  const spool = createScanFileSpool(db, [root(1)])
  spool.append('buffer', 1)
  const original = db.exec
  db.exec = (() => { throw new Error('drop failure') }) as typeof db.exec
  assert.throws(() => spool.dispose(), /drop failure/)
  assert.throws(() => spool.append('later', 1), /closed/)
  db.exec = original
  spool.dispose(); noTables()
  const closed = createScanFileSpool(db, [root(1)])
  db.close(); closed.dispose(); closed.dispose()
})

it('rejects creation inside a caller transaction without DDL or interfering with its rollback', () => {
  db.exec('CREATE TABLE business(value INTEGER)')
  assert.throws(() => db.transaction(() => {
    db.prepare('INSERT INTO business VALUES(1)').run()
    assert.throws(() => createScanFileSpool(db, [root(1)]), /caller transaction/)
    noTables()
    assert.equal(db.inTransaction, true)
    throw new Error('outer business failure')
  })(), /outer business failure/)
  assert.deepEqual(db.prepare('SELECT * FROM business').all(), [])
  noTables()
  const spool = createScanFileSpool(db, [root(1)])
  spool.dispose()
})

it('rolls factory DDL back if creation throws after SQLite creates the TEMP table', () => {
  const original = db.exec, exec = db.exec.bind(db)
  db.exec = ((sql: string) => {
    const result = exec(sql)
    if (sql.startsWith('CREATE TEMP TABLE scan_file_inventory_')) throw new Error('after DDL fault')
    return result
  }) as typeof db.exec
  try { assert.throws(() => createScanFileSpool(db, [root(1)]), /after DDL fault/) }
  finally { db.exec = original }
  assert.equal(db.inTransaction, false)
  noTables()
})

it('reports byte-triggered flushes and preserves committed ordinals when the next buffered flush fails', () => {
  const spool = createScanFileSpool(db, [root(1)]), name = table()
  const first = 'a'.repeat(SCAN_FILE_INVENTORY_MAX_BYTES - 1)
  assert.equal(spool.append(first, 1), false)
  assert.equal(spool.append('bb', 1), true)
  assert.deepEqual(db.prepare(`SELECT ordinal,path_bytes FROM ${name}`).all(),
    [{ ordinal: 1, path_bytes: SCAN_FILE_INVENTORY_MAX_BYTES - 1 }])
  db.exec(`CREATE TEMP TRIGGER fail_inventory BEFORE INSERT ON ${name}
    WHEN NEW.ordinal=3 BEGIN SELECT RAISE(ABORT,'second flush fault'); END`)
  assert.throws(() => spool.append('x'.repeat(SCAN_FILE_INVENTORY_MAX_BYTES), 1), /second flush fault/)
  assert.deepEqual(db.prepare(`SELECT ordinal,path_bytes FROM ${name} ORDER BY ordinal`).all(),
    [{ ordinal: 1, path_bytes: SCAN_FILE_INVENTORY_MAX_BYTES - 1 }, { ordinal: 2, path_bytes: 2 }])
  db.exec('DROP TRIGGER fail_inventory')
  assert.equal(spool.append('x'.repeat(SCAN_FILE_INVENTORY_MAX_BYTES), 1), true)
  spool.seal()
  assert.deepEqual([...spool].map(row => row.filePath.length), [first.length, 2, SCAN_FILE_INVENTORY_MAX_BYTES])
  spool.dispose()
})


it('rejects append, seal and dispose in caller transactions without altering buffered or sealed state', () => {
  const spool = createScanFileSpool(db, [root(1)]), name = table()
  spool.append('buffered', 1)
  for (const mutate of [
    () => spool.append('rejected', 1),
    () => spool.seal(),
    () => spool.dispose()
  ]) {
    assert.throws(() => db.transaction(() => {
      assert.throws(mutate, /caller transaction/)
      throw new Error('caller rollback')
    })(), /caller rollback/)
    assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get(), { count: 0 })
  }
  // All rejected operations leave the collecting inventory open and its buffer intact.
  spool.append('after rollback', 1)
  spool.seal()
  db.transaction(() => {
    assert.throws(() => spool.seal(), /caller transaction/)
    assert.throws(() => spool.dispose(), /caller transaction/)
    assert.deepEqual([...spool].map(row => row.filePath), ['buffered', 'after rollback'])
  })()
  assert.throws(() => db.transaction(() => {
    assert.throws(() => spool.dispose(), /caller transaction/)
    throw new Error('sealed rollback')
  })(), /sealed rollback/)
  assert.deepEqual([...spool].map(row => row.filePath), ['buffered', 'after rollback'])
  spool.dispose()
  noTables()
})

it('rejects a flush-triggering append inside a caller transaction without advancing ordinals', () => {
  const spool = createScanFileSpool(db, [root(1)]), name = table()
  for (let index = 0; index < 255; index++) spool.append(String(index), 1)
  assert.throws(() => db.transaction(() => spool.append('255', 1))(), /caller transaction/)
  assert.deepEqual(db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get(), { count: 0 })
  assert.equal(spool.append('255', 1), true)
  spool.seal()
  assert.deepEqual([...spool].map(row => row.filePath), Array.from({ length: 256 }, (_, index) => String(index)))
  spool.dispose()
})
