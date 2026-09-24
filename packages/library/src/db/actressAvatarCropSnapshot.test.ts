import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { createActressAvatarCropSnapshot } from './actressAvatarCropSnapshot'

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

it('pages a fixed target set and bounds labels after live insert, delete and rename', () => {
  const db=getDb()
  db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001)
    INSERT INTO actresses(id,main_name,avatar_path,profile_summary) SELECT x,printf('Actor-%05d',x),'avatar.jpg',hex(zeroblob(2048)) FROM n`)
  db.prepare('UPDATE actresses SET main_name=? WHERE id=101').run('😀'.repeat(10000))
  const snapshot=createActressAvatarCropSnapshot()
  try {
    const first=snapshot.page(0)
    assert.equal(first.total,10001);assert.equal(first.items.length,100);assert.equal(first.nextAfterId,100)
    db.exec("DELETE FROM actresses WHERE id=101; UPDATE actresses SET main_name='Changed' WHERE id=102; INSERT INTO actresses(id,main_name,avatar_path) VALUES(10002,'New','new.jpg')")
    const second=snapshot.page(first.nextAfterId!)
    assert.equal(second.items[0].actressId,101)
    assert.equal(second.items[0].mainName,'😀'.repeat(128)+'…')
    assert.equal(second.items[1].mainName,'Actor-00102')
    const ids=first.items.map(item=>item.actressId)
    let cursor: number | null=first.nextAfterId
    while(cursor!==null){const page=snapshot.page(cursor);assert.ok(page.items.length<=100);assert.ok(Buffer.byteLength(JSON.stringify(page))<100000);ids.push(...page.items.map(item=>item.actressId));cursor=page.nextAfterId}
    assert.deepEqual(ids,Array.from({length:10001},(_,i)=>i+1))
    assert.equal(snapshot.page(10001).nextAfterId,null)
    assert.throws(()=>snapshot.page(-1),/游标/)
    assert.throws(()=>snapshot.page(1.5),/游标/)
  }finally{snapshot.dispose();snapshot.dispose()}
  assert.throws(()=>snapshot.page(0),/失效/)
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_temp_master WHERE name LIKE 'avatar_crop_%'").get() as {count:number}).count,0)
})
it('handles empty sets and connection closure without recreating a database', () => {
  const snapshot=createActressAvatarCropSnapshot()
  assert.deepEqual(snapshot.page(0),{items:[],total:0,nextAfterId:null})
  closeDatabase()
  assert.throws(()=>snapshot.page(0),/失效/)
  snapshot.dispose()
})
it('rolls back the temporary table if snapshot population fails', () => {
  const db=getDb(),exec=db.exec.bind(db)
  db.exec=((sql:string)=>{if(sql.startsWith('INSERT INTO avatar_crop_'))throw new Error('Injected snapshot failure');return exec(sql)}) as typeof db.exec
  try{assert.throws(()=>createActressAvatarCropSnapshot(),/Injected snapshot failure/)}finally{db.exec=exec}
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_temp_master WHERE name LIKE 'avatar_crop_%'").get() as {count:number}).count,0)
})
