import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { editActress, getActressPickerIdentity, listActresses, listActressPickerPage } from './actressRepo'
import { resetSettingsCacheForTests } from '../settings/settingsStore'

let root: string
let previous: string | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-picker-'))
  previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
  resetSettingsCacheForTests()
  initDatabaseAtPath(path.join(root, 'catalog.db'))
})
afterEach(() => {
  closeDatabase(); resetSettingsCacheForTests()
  if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previous
  fs.rmSync(root, { recursive: true, force: true })
})

it('pages narrow labels from 10000 actors without catalog statistics or profile data', () => {
  const db = getDb()
  db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
    INSERT INTO actresses(id,main_name,profile_summary) SELECT x,printf('Actor-%05d',x),hex(zeroblob(2048)) FROM n`)
  const prepare = db.prepare.bind(db)
  const statements: string[] = []
  db.prepare = ((sql: string) => { statements.push(sql); return prepare(sql) }) as typeof db.prepare
  try {
    const first = listActressPickerPage()
    assert.equal(first.items.length, 40); assert.equal(first.hasMore, true)
    assert.deepEqual(Object.keys(first.items[0]).sort(), ['avatar_path', 'id', 'main_name'])
    const last = listActressPickerPage({ limit: 100, offset: 9900 })
    assert.deepEqual(last.items.map(row => row.id), Array.from({ length: 100 }, (_, i) => 9901 + i))
    assert.equal(last.hasMore, false)
    assert.deepEqual(listActressPickerPage({ offset: 10000 }), { items: [], hasMore: false, offset: 10000 })
    assert.equal(statements.length, 3)
    for (const sql of statements) assert.doesNotMatch(sql, /video_actress|library_video|gallery|profile_summary|COUNT\(\*\)|a\.\*/i)
  } finally { db.prepare = prepare }
})

it('preserves owned-name search matching and includes all genders', () => {
  const db = getDb()
  for (const [id, name, gender] of [[1, 'Ａｌｉｃｅ', 'female'], [2, 'Bob', 'male'], [3, 'Unknown', null]] as const) {
    db.prepare('INSERT INTO actresses(id,main_name,gender) VALUES(?,?,?)').run(id, name, gender)
    editActress(id, { main_name: name })
  }
  editActress(2, { aliases: ['Literal%_Alias'] })
  for (const search of ['alice', 'Ｂｏｂ', '%_', 'unknown', 'no match']) {
    assert.deepEqual(listActressPickerPage({ search }).items.map(row => row.id).sort(),
      listActresses(search, 'all').map(row => row.id).sort())
  }
  assert.equal(listActressPickerPage().items.length, 3)
})

it('sorts full names before shortening labels and bounds escaped JSON payloads', () => {
  const db = getDb()
  const insert = db.prepare('INSERT INTO actresses(id,main_name,avatar_path) VALUES(?,?,?)')
  const prefix = '😀'.repeat(129)
  db.transaction(() => {
    for (let id = 1; id <= 100; id++) insert.run(id, prefix + String(101-id).padStart(3, '0'), '\n'.repeat(4096))
  })()
  const page = listActressPickerPage({ limit: 100 })
  assert.deepEqual(page.items.map(row => row.id), Array.from({ length: 100 }, (_, i) => 100-i))
  assert.ok(page.items.every(row => row.main_name === '😀'.repeat(128) + '…' && row.avatar_path === null))
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 512 * 1024)
  db.prepare('UPDATE actresses SET avatar_path=? WHERE id=1').run('a'.repeat(4094))
  assert.equal(listActressPickerPage({ limit: 100 }).items[99].avatar_path?.length, 4094)
})

it('rejects invalid limits, offsets and overlong search before reading', () => {
  for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: Infinity }, { search: 'x'.repeat(257) }]) {
    assert.throws(() => listActressPickerPage(query), /Invalid actress picker/)
  }
  assert.deepEqual(listActressPickerPage({ offset: Number.MAX_SAFE_INTEGER }), { items: [], hasMore: false, offset: Number.MAX_SAFE_INTEGER })
})


it('bounds labels containing embedded NUL without losing the valid prefix', () => {
  const name = 'A\0' + 'x'.repeat(600000)
  getDb().prepare('INSERT INTO actresses(id,main_name) VALUES(1,?)').run(name)
  const page = listActressPickerPage()
  assert.equal(Array.from(page.items[0].main_name).length, 129)
  assert.equal(page.items[0].main_name, 'A\0' + 'x'.repeat(126) + '…')
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 512 * 1024)
})


it('keeps a full page below512KiB even with worst-case JSON escaping', () => {
  const insert = getDb().prepare('INSERT INTO actresses(id,main_name,avatar_path) VALUES(?,?,?)')
  const prefix = String.fromCharCode(1).repeat(128)
  const avatar = String.fromCharCode(92).repeat(2047)
  getDb().transaction(() => {
    for (let id=1; id<=100; id++) insert.run(id, prefix + id, avatar)
  })()
  const page = listActressPickerPage({ limit: 100 })
  assert.equal(page.items.length, 100)
  assert.ok(page.items.every(item => item.avatar_path === avatar && item.main_name === prefix + '…'))
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 512 * 1024)
})


it('reads current picker identity by ID without hydrating actor works or profile', () => {
  const db = getDb()
  db.prepare('INSERT INTO actresses(id,main_name,profile_summary,revision) VALUES(1,?,?,7)').run('Current name', 'x'.repeat(1000000))
  const prepare = db.prepare.bind(db)
  const statements: string[] = []
  db.prepare = ((sql: string) => { statements.push(sql); return prepare(sql) }) as typeof db.prepare
  try {
    assert.deepEqual(getActressPickerIdentity(1), { id: 1, main_name: 'Current name', avatar_path: null, revision: 7 })
    assert.equal(getActressPickerIdentity(2), null)
    assert.equal(statements.length, 2)
    assert.ok(statements.every(sql => !/profile_summary|video_actress|gallery|a\.\*/.test(sql)))
  } finally { db.prepare = prepare }
  db.prepare('UPDATE actresses SET revision=8, main_name=? WHERE id=1').run('A\0'+'😀'.repeat(10000))
  const result = getActressPickerIdentity(1)!
  assert.equal(result.revision, 8)
  assert.equal(Array.from(result.main_name).length, 129)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 5120)
  for (const id of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER+1]) assert.throws(() => getActressPickerIdentity(id))
})
