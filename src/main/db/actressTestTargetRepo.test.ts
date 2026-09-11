import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { editActress, getActressTestTargetName, listActresses, listActressTestTargetPage } from './actressRepo'
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

import { createActressQueryService } from '../services/actressQueryService'

it('pages female test choices by full name and retains owned alias search without wide data', () => {
  const db=getDb()
  const insert=db.prepare('INSERT INTO actresses(id,main_name,gender,profile_summary) VALUES(?,?,?,?)')
  for(let id=1;id<=205;id++){insert.run(id,`Actor-${String(id).padStart(3,'0')}`,id%3===0?'male':id%7===0?null:'female','x'.repeat(4096));editActress(id,{main_name:`Actor-${String(id).padStart(3,'0')}`})}
  editActress(2,{aliases:['Alias%_Name']})
  for(const search of ['', '%_', 'Actor-19', 'not present']) {
    const expected=listActresses(search,'female').sort((a,b)=>Buffer.compare(Buffer.from(a.main_name),Buffer.from(b.main_name))).map(a=>a.id)
    const actual:number[]=[]
    for(let offset=0;;offset+=40){const page=listActressTestTargetPage({search,offset});actual.push(...page.items.map(item=>item.id));if(!page.hasMore)break}
    assert.deepEqual(actual,expected)
  }
  const prepare=db.prepare.bind(db),queries:string[]=[]
  db.prepare=((sql:string)=>{queries.push(sql);return prepare(sql)}) as typeof db.prepare
  try {const result=listActressTestTargetPage({limit:100});assert.equal(result.items.length,100);for(const sql of queries)assert.doesNotMatch(sql,/video_actress|gallery|profile_summary|a\.\*/i)}finally{db.prepare=prepare}
  assert.equal(getActressTestTargetName(3),null)
  assert.equal(getActressTestTargetName(7),null)
  assert.equal(getActressTestTargetName(9999),null)
  assert.throws(()=>getActressTestTargetName(0),/Invalid/)
})
it('resolves the complete current runtime identity rather than its shortened display label', () => {
  const db=getDb(),service=createActressQueryService()
  const original='A'.repeat(150)
  db.prepare("INSERT INTO actresses(id,main_name,gender) VALUES(1,?,'female')").run(original)
  assert.equal(service.listTestTargets().items[0].main_name,'A'.repeat(128)+'…')
  assert.equal(service.getTestTarget(1),original)
  db.prepare('UPDATE actresses SET main_name=? WHERE id=1').run(' '.repeat(5000)+'Ａｌｉｃｅ  Example'+' '.repeat(5000))
  assert.equal(service.getTestTarget(1),'Alice Example')
  for(const value of ['A'.repeat(161),'https://example.com','Name\u0000Suffix']) {
    db.prepare('UPDATE actresses SET main_name=? WHERE id=1').run(value)
    assert.throws(()=>service.getTestTarget(1),/160|URL|控制字符/)
  }
  db.exec("UPDATE actresses SET gender='male' WHERE id=1")
  assert.equal(service.getTestTarget(1),null)
})
