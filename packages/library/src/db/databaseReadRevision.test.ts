import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { closeDatabase, getDatabaseReadRevision, initDatabaseAtPath } from './database'

it('detects local writes, external commits and connection replacement without changing schema', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-read-revision-'))
  const dbPath = path.join(root, 'library.db')
  let other: Database.Database | undefined
  try {
    const db = initDatabaseAtPath(dbPath)
    db.exec('CREATE TABLE revision_probe (id INTEGER PRIMARY KEY, value TEXT)')
    const before = getDatabaseReadRevision()
    assert.deepEqual(getDatabaseReadRevision(), before)
    db.prepare('INSERT INTO revision_probe VALUES (1, ?)').run('local')
    const local = getDatabaseReadRevision()
    assert.ok(local.changes > before.changes)
    assert.equal(local.dataVersion, before.dataVersion)
    other = new Database(dbPath)
    other.prepare('UPDATE revision_probe SET value = ?').run('external')
    const external = getDatabaseReadRevision()
    assert.equal(external.changes, local.changes)
    assert.notEqual(external.dataVersion, local.dataVersion)
    other.close()
    other = undefined
    closeDatabase()
    initDatabaseAtPath(dbPath)
    assert.notEqual(getDatabaseReadRevision().connection, before.connection)
  } finally {
    other?.close()
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
