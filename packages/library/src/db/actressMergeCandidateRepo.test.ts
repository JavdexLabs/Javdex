import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { editActress, listActresses, listActressMergeCandidates } from './actressRepo'
import { canMergeActressGenders } from '@shared/actressProfileOptions'
import { insertTestVideoWithFile } from './testVideoFixtures'
let root: string
let previous: string | undefined
beforeEach(() => {
  root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-merge-candidates-'))
  previous=process.env.JAVDEX_TEST_USER_DATA;process.env.JAVDEX_TEST_USER_DATA=root
  initDatabaseAtPath(path.join(root,'catalog.db'))
})
afterEach(() => {
  closeDatabase();  if(previous===undefined)delete process.env.JAVDEX_TEST_USER_DATA;else process.env.JAVDEX_TEST_USER_DATA=previous
  fs.rmSync(root,{recursive:true,force:true})
})
function actors() {
  const db=getDb()
  for(const [id,name,gender] of [[1,'Keep','female'],[2,'Alpha',null],[3,'Beta','male'],[4,'Zulu','female'],[5,'Male','male']] as const) {
    db.prepare('INSERT INTO actresses(id,main_name,gender) VALUES(?,?,?)').run(id,name,gender)
    editActress(id,{main_name:name})
  }
  editActress(2,{aliases:['Literal%_Alias']})
}
function video(code:string,libraryId=1):number {
  getDb().prepare('INSERT OR IGNORE INTO media_libraries(id,name) VALUES(?,?)').run(libraryId,`Library-${libraryId}`)
  return insertTestVideoWithFile(getDb(),{code,filePath:code+'.mp4',libraryId}).videoId
}
it('matches merge gender and owned search semantics while paging by full name',()=>{
  actors()
  for(const keepId of [1,2,3])for(const search of ['', 'alpha', '%_', 'Ｍａｌｅ', 'missing']) {
    const all=listActresses(search,'all')
    const keep=listActresses('','all').find(row=>row.id===keepId)!
    const expected=all.filter(row=>row.id!==keepId&&canMergeActressGenders(keep.gender,row.gender))
      .sort((a,b)=>Buffer.compare(Buffer.from(a.main_name),Buffer.from(b.main_name)))
      .map(({id,main_name,avatar_path,gender,video_count})=>({id,main_name,avatar_path,gender,video_count}))
    assert.deepEqual(listActressMergeCandidates({keepId,search,limit:1}),{items:expected.slice(0,1),hasMore:expected.length>1,offset:0})
    assert.deepEqual(listActressMergeCandidates({keepId,search,limit:1,offset:1}),{items:expected.slice(1,2),hasMore:expected.length>2,offset:1})
  }
})
it('counts each visible video once across overlapping libraries and excludes hidden/archived/orphaned videos',()=>{
  actors();const db=getDb()
  const visible=video('VISIBLE'),other=video('OTHER',2),hidden=video('HIDDEN'),archived=video('ARCHIVED',3),orphaned=video('ORPHANED')
  db.prepare('INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES(2,?,123)').run(visible)
  db.exec("UPDATE media_libraries SET status='archived' WHERE id=3")
  db.prepare('UPDATE library_video_memberships SET is_hidden=1 WHERE video_id=?').run(hidden)
  db.prepare('DELETE FROM library_video_memberships WHERE video_id=?').run(orphaned)
  for(const id of [visible,other,hidden,archived,orphaned])db.prepare('INSERT INTO video_actress(video_id,actress_id) VALUES(?,2)').run(id)
  assert.deepEqual(listActressMergeCandidates({keepId:1}).items.map(row=>[row.id,row.video_count]),[[2,2],[4,0]])
  assert.equal(listActresses('Alpha','all')[0].video_count,2)
})
it('counts only returned candidates, excluding lookahead, and skips counts for an empty page',()=>{
  actors();const db=getDb(),prepare=db.prepare.bind(db)
  const countInputs:string[]=[]
  db.prepare=((sql:string)=>{
    const statement=prepare(sql)
    if(sql.includes('FROM video_actress va')) {
      const all=statement.all.bind(statement)
      statement.all=((input:string)=>{countInputs.push(input);return all(input)}) as typeof statement.all
    }
    return statement
  }) as typeof db.prepare
  try {
    const page=listActressMergeCandidates({keepId:1,limit:1})
    assert.equal(page.hasMore,true);assert.deepEqual(countInputs,['[2]'])
    assert.deepEqual(listActressMergeCandidates({keepId:1,offset:100}),{items:[],hasMore:false,offset:100})
    assert.equal(countInputs.length,1)
  } finally {db.prepare=prepare}
})
it('keeps candidate rows and counts on the same snapshot when another connection writes',()=>{
  actors();const db=getDb(),id=video('SNAPSHOT')
  db.prepare('INSERT INTO video_actress(video_id,actress_id) VALUES(?,2)').run(id)
  const other=new Database(path.join(root,'catalog.db')),prepare=db.prepare.bind(db)
  let changed=false
  db.prepare=((sql:string)=>{
    const statement=prepare(sql)
    if(sql.includes('SELECT a.id,')&&sql.includes('a.gender')) {
      const all=statement.all.bind(statement)
      statement.all=((...params:unknown[])=>{
        const rows=all(...params)
        if(!changed){changed=true;other.prepare('UPDATE library_video_memberships SET is_hidden=1 WHERE video_id=?').run(id)}
        return rows
      }) as typeof statement.all
    }
    return statement
  }) as typeof db.prepare
  try {
    assert.equal(listActressMergeCandidates({keepId:1}).items[0].video_count,1)
    assert.equal(changed,true)
    assert.equal(listActressMergeCandidates({keepId:1}).items[0].video_count,0)
  } finally {db.prepare=prepare;other.close()}
})
it('bounds labels/avatars and validates inputs and missing keep actors',()=>{
  actors();const db=getDb()
  db.prepare('UPDATE actresses SET main_name=?,avatar_path=? WHERE id=2').run('A\0'+'😀'.repeat(100000),'\n'.repeat(4096))
  const item=listActressMergeCandidates({keepId:1,limit:1}).items[0]
  assert.equal(Array.from(item.main_name).length,129);assert.equal(item.avatar_path,null)
  assert.deepEqual(Object.keys(item).sort(),['avatar_path','gender','id','main_name','video_count'])
  assert.ok(Buffer.byteLength(JSON.stringify(item))<5120)
  for(const query of [{keepId:0},{keepId:1,limit:101},{keepId:1,limit:0},{keepId:1,offset:-1},{keepId:1,offset:Infinity},{keepId:1,search:'x'.repeat(257)}])assert.throws(()=>listActressMergeCandidates(query),/Invalid/)
  assert.throws(()=>listActressMergeCandidates({keepId:999}),/保留演员不存在/)
})
