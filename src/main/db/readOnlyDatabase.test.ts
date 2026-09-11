import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { CURRENT_SCHEMA_VERSION } from './migrations'
import { closeDatabase, getDb, initDatabaseAtPath, openReadOnlyDatabaseAtPath } from './database'

let root: string | undefined
function filename(name = 'library.db') {
  root ??= fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-reader-'))
  return path.join(root, name)
}
afterEach(() => { closeDatabase(); if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined })

it('opens a separate read-only WAL connection with matching SQL functions and no migration', () => {
  const file = filename()
  const writer = initDatabaseAtPath(file)
  writer.exec("INSERT INTO tags(id,name) VALUES(1,'École')")
  const schemaBefore = writer.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()
  const reader = openReadOnlyDatabaseAtPath(file)
  try {
    assert.notEqual(reader, writer)
    assert.equal(getDb(), writer)
    assert.equal(reader.readonly, true)
    assert.equal(reader.pragma('query_only', { simple: true }), 1)
    const sql = "SELECT tag_name_contains_folded(name,'éco') AS matches, normalize_actress_name(name) AS normalized FROM tags"
    assert.deepEqual(reader.prepare(sql).all(), writer.prepare(sql).all())
    for (const sql of ["INSERT INTO tags(name) VALUES('forbidden')", 'DELETE FROM tags', 'CREATE TABLE forbidden(id)', 'PRAGMA user_version=0']) {
      assert.throws(() => reader.exec(sql), /readonly|read-only/i)
    }
    assert.deepEqual(writer.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(), schemaBefore)
    assert.deepEqual(reader.prepare('SELECT id,name FROM tags').all(), [{ id: 1, name: 'École' }])
  } finally { reader.close() }
  assert.equal(writer.prepare('SELECT 1 AS n').get() && getDb(), writer)
})

it('keeps a read snapshot while the writer commits and observes it on the next transaction', () => {
  const file = filename()
  const writer = initDatabaseAtPath(file)
  writer.exec("INSERT INTO tags(id,name) VALUES(1,'before')")
  const reader = openReadOnlyDatabaseAtPath(file)
  const names = () => reader.prepare('SELECT name FROM tags ORDER BY id').all()
  try {
    reader.transaction(() => {
      assert.deepEqual(names(), [{ name: 'before' }])
      writer.exec("UPDATE tags SET name='after' WHERE id=1")
      assert.deepEqual(names(), [{ name: 'before' }])
    })()
    assert.deepEqual(names(), [{ name: 'after' }])
    assert.throws(() => reader.transaction(() => { names(); throw new Error('read failed') })(), /read failed/)
    assert.equal(reader.inTransaction, false)
    assert.deepEqual(names(), [{ name: 'after' }])
  } finally { reader.close() }
})

it('rejects missing, old, newer and non-WAL catalogs without initializing or migrating them', () => {
  const missing = filename('missing.db')
  assert.throws(() => openReadOnlyDatabaseAtPath(missing))
  assert.equal(fs.existsSync(missing), false)
  for (const version of [0, CURRENT_SCHEMA_VERSION - 1, CURRENT_SCHEMA_VERSION + 1]) {
    const file = filename(`version-${version}.db`)
    const fixture = new Database(file)
    fixture.exec('CREATE TABLE sentinel(value TEXT)')
    fixture.pragma(`user_version=${version}`)
    try {
      assert.throws(() => openReadOnlyDatabaseAtPath(file), /requires schema/)
      assert.equal(fixture.pragma('user_version', { simple: true }), version)
      assert.deepEqual(fixture.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), [{ name: 'sentinel' }])
    } finally { fixture.close() }
  }
  const rollbackFile = filename('rollback.db')
  const rollback = new Database(rollbackFile)
  rollback.pragma(`user_version=${CURRENT_SCHEMA_VERSION}`)
  try {
    assert.throws(() => openReadOnlyDatabaseAtPath(rollbackFile), /requires WAL/)
    assert.equal(rollback.pragma('journal_mode', { simple: true }), 'delete')
  } finally { rollback.close() }
})

it('does not publish an unsuccessfully initialized writer and permits a subsequent valid initialization', () => {
  const invalid = filename('newer.db')
  const fixture = new Database(invalid)
  fixture.pragma(`user_version=${CURRENT_SCHEMA_VERSION + 1}`)
  fixture.close()
  assert.throws(() => initDatabaseAtPath(invalid), /no longer supported/)
  assert.throws(() => getDb(), /not initialised/)
  const writer = initDatabaseAtPath(filename())
  assert.equal(getDb(), writer)
  assert.equal(writer.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
})
