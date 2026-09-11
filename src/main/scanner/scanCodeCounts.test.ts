import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import Database from 'better-sqlite3'
import { createScanCodeCounts, createMemoryScanCodeCounts, ScanCodeCountsError,
  SCAN_CODE_COUNTS_MAX_BYTES } from './scanCodeCounts'

let db: Database.Database
beforeEach(() => { db = new Database(':memory:') })
afterEach(() => { if (db.open) db.close() })
function table(): string {
  return (db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' AND name LIKE 'scan_code_counts_%'").get() as { name: string }).name
}
function noTables() {
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' AND name LIKE 'scan_code_counts_%'").all(), [])
}
function failure(operation: () => unknown, message: RegExp): ScanCodeCountsError {
  let caught: ScanCodeCountsError | undefined
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof ScanCodeCountsError)
    assert.ok(error.cause instanceof Error)
    assert.match(error.cause.message, message)
    caught = error
    return true
  })
  return caught!
}

it('matches exact JS Map keys and occurrence counts across multiple flushes', () => {
  const sql = createScanCodeCounts(db), memory = createMemoryScanCodeCounts()
  const codes = ['', 'abc', 'ABC', ' abc ', '\0', 'a\0b', '\ud800', '\ud801', '\udc00', '�', '😀', 'é', 'é', '"', '\\']
  let flushes = 0
  for (let index = 0; index < 900; index++) {
    if (sql.add(codes[index % codes.length])) flushes++
    memory.add(codes[index % codes.length])
  }
  assert.equal(flushes, 3)
  sql.finishCounting(); memory.finishCounting()
  for (const code of codes) assert.equal(sql.get(code), memory.get(code))
  for (const counter of [sql, memory]) {
    for (let index = 0; index < 100; index++) counter.decrement('\ud800')
    counter.decrement('missing')
    assert.equal(counter.get('\ud800'), 0)
    assert.equal(counter.get('missing'), 0)
    assert.equal(counter.get('\ud801'), 60)
    counter.freeze()
    assert.equal(counter.get('a\0b'), 60)
    counter.dispose(); counter.dispose()
  }
  noTables()
})

it('bounds occurrence batches and encoded key bytes including escaped surrogates', () => {
  const original = db.prepare, prepare = db.prepare.bind(db)
  let inserts = 0, bytes = 0
  db.prepare = ((sql: string) => {
    const statement = prepare(sql)
    if (sql.startsWith('INSERT INTO temp.scan_code_counts_')) {
      inserts = 0; bytes = 0
      const run = statement.run.bind(statement)
      statement.run = ((key: string) => {
        inserts++; bytes += Buffer.byteLength(key)
        assert.ok(inserts <= 256)
        assert.ok(bytes <= SCAN_CODE_COUNTS_MAX_BYTES)
        return run(key)
      }) as typeof statement.run
    }
    return statement
  }) as typeof db.prepare
  const counter = createScanCodeCounts(db)
  try {
    const code = '\ud800'.repeat(100000)
    assert.equal(counter.add(code), false)
    assert.equal(counter.add(code), true)
    assert.equal(inserts, 1)
    inserts = 0; bytes = 0
    counter.finishCounting()
    assert.equal(inserts, 1)
    assert.equal(counter.get(code), 2)
    failure(() => counter.get('x'.repeat(SCAN_CODE_COUNTS_MAX_BYTES)), /1 MiB/)
  } finally { db.prepare = original }
  counter.dispose()
})

it('rejects oversized add without accepting it and accepts the exact byte boundary', () => {
  const counter = createScanCodeCounts(db), code = 'x'.repeat(SCAN_CODE_COUNTS_MAX_BYTES - 2)
  failure(() => counter.add(code + 'x'), /1 MiB/)
  assert.equal(counter.add(code), true)
  counter.finishCounting()
  assert.equal(counter.get(code), 1)
  counter.dispose()
})

it('native INSERT failure rolls back the batch and failed add retries exactly once', () => {
  const counter = createScanCodeCounts(db), name = table()
  db.exec(`CREATE TEMP TRIGGER fail_counts BEFORE INSERT ON ${name}
    WHEN NEW.code='"last"' BEGIN SELECT RAISE(ABORT,'insert fault'); END`)
  for (let index = 0; index < 255; index++) counter.add('same')
  failure(() => counter.add('last'), /insert fault/)
  assert.deepEqual(db.prepare(`SELECT * FROM ${name}`).all(), [])
  db.exec('DROP TRIGGER fail_counts')
  assert.equal(counter.add('last'), true)
  counter.finishCounting()
  assert.equal(counter.get('same'), 255)
  assert.equal(counter.get('last'), 1)
  counter.dispose()
})

it('native UPDATE failure during flush preserves buffer and counting state for finish retry', () => {
  const counter = createScanCodeCounts(db), name = table()
  counter.add('same'); counter.add('same')
  db.exec(`CREATE TEMP TRIGGER fail_counts BEFORE UPDATE ON ${name}
    BEGIN SELECT RAISE(ABORT,'update fault'); END`)
  failure(() => counter.finishCounting(), /update fault/)
  assert.deepEqual(db.prepare(`SELECT * FROM ${name}`).all(), [])
  db.exec('DROP TRIGGER fail_counts')
  counter.finishCounting()
  assert.equal(counter.get('same'), 2)
  db.exec(`CREATE TEMP TRIGGER fail_counts AFTER UPDATE ON ${name}
    BEGIN SELECT RAISE(ABORT,'decrement fault'); END`)
  failure(() => counter.decrement('same'), /decrement fault/)
  assert.equal(counter.get('same'), 2)
  db.exec('DROP TRIGGER fail_counts')
  counter.decrement('same')
  assert.equal(counter.get('same'), 1)
  counter.dispose()
})

it('preserves native SELECT cause and remains readable after the fault is removed', () => {
  const counter = createScanCodeCounts(db), name = table()
  counter.add('code'); counter.finishCounting()
  db.exec(`ALTER TABLE ${name} RENAME TO hidden_counts`)
  const error = failure(() => counter.get('code'), /no such table/)
  assert.equal((error.cause as { code?: string }).code, 'SQLITE_ERROR')
  db.exec(`ALTER TABLE hidden_counts RENAME TO ${name}`)
  assert.equal(counter.get('code'), 1)
  counter.dispose()
})

it('native DROP lock failure can be retried and closed database disposal is safe', () => {
  const counter = createScanCodeCounts(db)
  counter.add('a'); counter.finishCounting()
  db.exec('CREATE TEMP TABLE lock_source(value); INSERT INTO lock_source VALUES(1),(2)')
  const cursor = db.prepare('SELECT * FROM lock_source').iterate()
  cursor.next()
  failure(() => counter.dispose(), /locked|busy/)
  cursor.return?.()
  counter.dispose(); counter.dispose(); noTables()
  const closed = createScanCodeCounts(db)
  db.close()
  failure(() => closed.add('x'), /closed/)
  closed.dispose(); closed.dispose()
})

it('guards lifecycle for both implementations', () => {
  for (const counter of [createScanCodeCounts(db), createMemoryScanCodeCounts()]) {
    failure(() => counter.get('x'), /counting|readable/)
    failure(() => counter.decrement('x'), /adjusting/)
    failure(() => counter.freeze(), /adjusting/)
    counter.add('x'); counter.finishCounting()
    failure(() => counter.add('x'), /counting/)
    failure(() => counter.finishCounting(), /counting/)
    counter.freeze()
    failure(() => counter.decrement('x'), /adjusting/)
    assert.equal(counter.get('x'), 1)
    counter.dispose()
    failure(() => counter.get('x'), /closed|readable/)
  }
})

it('rejects caller transaction mutations before state changes while permitting reads', () => {
  db.transaction(() => failure(() => createScanCodeCounts(db), /caller transaction/))()
  noTables()
  const counter = createScanCodeCounts(db)
  counter.add('original')
  for (const operation of [() => counter.add('rejected'), () => counter.finishCounting(), () => counter.dispose()]) {
    assert.throws(() => db.transaction(() => {
      failure(operation, /caller transaction/)
      throw new Error('outer rollback')
    })(), /outer rollback/)
  }
  counter.finishCounting()
  db.transaction(() => {
    assert.equal(counter.get('original'), 1)
    for (const operation of [() => counter.decrement('original'), () => counter.freeze(), () => counter.dispose()]) {
      failure(operation, /caller transaction/)
    }
  })()
  counter.decrement('original'); counter.freeze()
  assert.equal(counter.get('original'), 0)
  assert.equal(counter.get('rejected'), 0)
  counter.dispose(); noTables()
})

it('never silently saturates counts beyond the exact safe integer range', () => {
  const counter = createScanCodeCounts(db), name = table()
  db.prepare(`INSERT INTO ${name} VALUES(?,?)`).run(JSON.stringify('max'), Number.MAX_SAFE_INTEGER)
  counter.add('max')
  failure(() => counter.finishCounting(), /CHECK constraint/)
  db.prepare(`UPDATE ${name} SET count=?`).run(Number.MAX_SAFE_INTEGER - 1)
  counter.finishCounting()
  assert.equal(counter.get('max'), Number.MAX_SAFE_INTEGER)
  counter.decrement('max')
  assert.equal(counter.get('max'), Number.MAX_SAFE_INTEGER - 1)
  counter.dispose()
})


it('rejects huge raw input before JSON encoding and leaves the counter usable', (t) => {
  const counter = createScanCodeCounts(db), oversized = 'x'.repeat(SCAN_CODE_COUNTS_MAX_BYTES + 1)
  const original = JSON.stringify
  let encoded = false
  t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
    if (args[0] === oversized) encoded = true
    return Reflect.apply(original, JSON, args)
  })
  try {
    failure(() => counter.add(oversized), /1 MiB/)
    assert.equal(encoded, false)
    counter.add('valid'); counter.finishCounting()
    assert.equal(counter.get('valid'), 1)
  } finally { t.mock.restoreAll(); counter.dispose() }
})

it('wraps factory failure with its original cause and rolls back already-created DDL', () => {
  const original = db.exec, exec = db.exec.bind(db), fault = new Error('factory fault')
  db.exec = ((sql: string) => {
    const result = exec(sql)
    if (sql.startsWith('CREATE TEMP TABLE scan_code_counts_')) throw fault
    return result
  }) as typeof db.exec
  try { assert.equal(failure(() => createScanCodeCounts(db), /factory fault/).cause, fault) }
  finally { db.exec = original }
  noTables()
  assert.equal(db.inTransaction, false)
})


it('prepares three statements once for many flushes, reads and corrections', () => {
  const original = db.prepare, prepare = db.prepare.bind(db)
  const prepared: string[] = []
  db.prepare = ((sql: string) => { prepared.push(sql); return prepare(sql) }) as typeof db.prepare
  try {
    const counter = createScanCodeCounts(db)
    assert.equal(prepared.length, 3)
    for (let index = 0; index < 800; index++) counter.add(String(index % 20))
    counter.finishCounting()
    for (let index = 0; index < 600; index++) {
      counter.decrement(String(index % 20))
      assert.ok(counter.get(String(index % 20)) >= 10)
    }
    counter.freeze()
    assert.equal(counter.get('0'), 10)
    counter.dispose()
    assert.equal(prepared.length, 3)
  } finally { db.prepare = original }
})

it('rolls back TEMP creation if statement preparation fails', () => {
  const original = db.prepare, prepare = db.prepare.bind(db), fault = new Error('prepare fault')
  db.prepare = ((sql: string) => {
    if (sql.startsWith('SELECT count FROM temp.scan_code_counts_')) throw fault
    return prepare(sql)
  }) as typeof db.prepare
  try { assert.equal(failure(() => createScanCodeCounts(db), /prepare fault/).cause, fault) }
  finally { db.prepare = original }
  noTables()
  assert.equal(db.inTransaction, false)
  const retry = createScanCodeCounts(db)
  retry.add('a'); retry.finishCounting()
  assert.equal(retry.get('a'), 1)
  retry.dispose()
})
