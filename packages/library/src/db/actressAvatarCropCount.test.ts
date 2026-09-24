import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { countActressAvatarCropTargets, listActresses } from './actressRepo'

let root: string
let previous: string | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-picker-'))
  previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
    initDatabaseAtPath(path.join(root, 'catalog.db'))
})
afterEach(() => {
  closeDatabase();   if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previous
  fs.rmSync(root, { recursive: true, force: true })
})

it('counts the same all-gender avatar targets without projecting profiles or joining works', () => {
  const db = getDb()
  const insert = db.prepare('INSERT INTO actresses(main_name,gender,avatar_path,avatar_source_path,profile_summary) VALUES(?,?,?,?,?)')
  const paths: Array<string | null> = [null, '', ' ', '\u0000', 'avatar.jpg']
  let id = 0
  for (const gender of ['female', 'male', null]) {
    for (const display of paths) for (const source of paths) {
      insert.run(`Actor-${++id}`, gender, display, source, 'x'.repeat(4096))
    }
  }
  const expected = listActresses(undefined, 'all').filter(row => Boolean(row.avatar_source_path || row.avatar_path)).length
  const prepare = db.prepare.bind(db)
  const statements: string[] = []
  db.prepare = ((sql: string) => { statements.push(sql); return prepare(sql) }) as typeof db.prepare
  try {
    assert.equal(countActressAvatarCropTargets(), expected)
    assert.equal(statements.length, 1)
    assert.match(statements[0], /COUNT\(\*\)/i)
    assert.doesNotMatch(statements[0], /video_actress|gallery|profile_summary|ORDER BY/i)
    db.exec('DELETE FROM actresses')
    assert.equal(countActressAvatarCropTargets(), 0)
  } finally { db.prepare = prepare }
})
