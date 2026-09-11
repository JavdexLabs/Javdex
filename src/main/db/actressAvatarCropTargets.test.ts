import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { listActressAvatarCropTargets, listActresses } from './actressRepo'
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

import { insertTestVideoWithFile } from './testVideoFixtures'

it('returns only target identity in ID order without counting works with all path and gender semantics', () => {
  const db = getDb()
  const insert = db.prepare('INSERT INTO actresses(id,main_name,gender,avatar_path,avatar_source_path,profile_summary) VALUES(?,?,?,?,?,?)')
  insert.run(1, 'Alpha', 'female', null, null, 'x'.repeat(4096))
  insert.run(2, 'Beta', 'male', '', '\u0000', 'x'.repeat(4096))
  insert.run(3, 'Zulu', null, ' ', null, 'x'.repeat(4096))
  insert.run(4, '😀'.repeat(200), 'female', 'avatar.jpg', '', 'x'.repeat(4096))
  db.exec("INSERT INTO media_libraries(id,name,status) VALUES(2,'Overlap','active'),(3,'Archived','active')")
  const video = (code: string, libraryId = 1) => insertTestVideoWithFile(db, {code,filePath:code+'.mp4',libraryId}).videoId
  const first=video('FIRST'), second=video('SECOND'), hidden=video('HIDDEN'), archived=video('ARCHIVED',3)
  db.exec("UPDATE media_libraries SET status='archived' WHERE id=3")
  db.prepare('INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES(2,?,123)').run(first)
  db.prepare('UPDATE library_video_memberships SET is_hidden=1 WHERE video_id=?').run(hidden)
  for (const [vid,actor] of [[first,3],[second,3],[first,2],[hidden,2],[archived,2]]) db.prepare('INSERT INTO video_actress(video_id,actress_id) VALUES(?,?)').run(vid,actor)
  const expected = listActresses(undefined,'all').filter(a=>Boolean(a.avatar_source_path||a.avatar_path)).sort((a,b)=>a.id-b.id).map(a=>({actressId:a.id,mainName:a.main_name}))
  const prepare=db.prepare.bind(db), statements:string[]=[]
  db.prepare=((sql:string)=>{statements.push(sql);return prepare(sql)}) as typeof db.prepare
  try {
    assert.deepEqual(listActressAvatarCropTargets(),expected)
    assert.deepEqual(expected.map(a=>a.actressId),[2,3,4])
    assert.equal(expected[2].mainName,'😀'.repeat(200))
    assert.equal(statements.length,1)
    assert.doesNotMatch(statements[0],/a\.\*|profile_summary|actress_gallery_assets|video_actress|library_video_memberships|video_count/i)
    db.exec('DELETE FROM actresses')
    assert.deepEqual(listActressAvatarCropTargets(),[])
  } finally {db.prepare=prepare}
})
