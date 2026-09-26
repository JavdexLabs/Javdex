import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { schemaDeclaration } from './catalogSchema'
import { copyAttachedCatalog } from './catalogSnapshot'

test('schema comparison ignores whitespace and migrated column order but retains constraints and literal spaces', () => {
  assert.equal(schemaDeclaration('CREATE TABLE "test" (id INTEGER PRIMARY KEY, value TEXT DEFAULT \'a b\')'), schemaDeclaration('CREATE TABLE test ( value TEXT DEFAULT \'a b\', id INTEGER PRIMARY KEY )'))
  assert.notEqual(schemaDeclaration("CREATE TABLE t (value TEXT DEFAULT 'a b')"), schemaDeclaration("CREATE TABLE t (value TEXT DEFAULT 'ab')"))
  assert.notEqual(schemaDeclaration('CREATE TABLE t (v INTEGER CHECK(v > 0))'), schemaDeclaration('CREATE TABLE t (v INTEGER CHECK(v >= 0))'))
  assert.notEqual(schemaDeclaration('CREATE INDEX i ON t(a,b)'), schemaDeclaration('CREATE INDEX i ON t(b,a)'))
})
test('catalog copy matches columns by name across different source and target column orders', () => {
  const db = new Database(':memory:')
  try {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, title TEXT, rating INTEGER); ATTACH DATABASE ':memory:' AS source; CREATE TABLE source.t (rating INTEGER, id INTEGER PRIMARY KEY, title TEXT); INSERT INTO source.t VALUES (5, 42, 'kept')")
    db.transaction(() => copyAttachedCatalog(db, 'source'))()
    assert.deepEqual(db.prepare('SELECT * FROM t').get(), { id: 42, title: 'kept', rating: 5 })
  } finally { db.close() }
})
