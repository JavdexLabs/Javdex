import assert from 'node:assert/strict'
import {beforeEach,afterEach,it} from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {getDb,initDatabaseAtPath,closeDatabase} from '../db/database'
import {classificationQueryService as read} from './classificationQueryService'
import {appIpcSchemas} from '../ipc/ipcCommandSchemas'
import {IPC} from '@shared/ipc-channels'
let root:string
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-image-page-'));initDatabaseAtPath(path.join(root,'catalog.db'));getDb().exec("INSERT INTO organizations(id,main_name) VALUES(1,'Org');INSERT INTO directors(id,main_name) VALUES(1,'Director');INSERT INTO series(id,main_name) VALUES(1,'Series')")})
afterEach(()=>{closeDatabase();fs.rmSync(root,{recursive:true,force:true})})
it('matches all candidate fields/order and deduplicates dual-role organization links before LIMIT',()=>{
 const db=getDb(),paths=[null,'',' ','\t','\0tail',' cover.jpg ','cover.jpg'],dates=[null,'',' ','2024-01-01','2020-01-01']
 let n=0
 const insert=db.prepare('INSERT INTO videos(code,title,cover_path,release_date,add_time,maker_organization_id,publisher_organization_id,director_id,series_id) VALUES(?,?,?,?,?,?,?,?,?)')
 for(let repeat=0;repeat<5;repeat++)for(const cover of paths)for(const date of dates){n++;insert.run(`CODE-${n}`,`Title-${n}`,cover,date,n%2?'2021-01-01':'2020-01-01',n%3?1:null,n%2?1:null,1,1)}
 for(const kind of ['organization','director','series'] as const){const entity={kind,id:1},expected=read.listImageCandidates(entity),actual=[]
  for(let offset=0;offset<=expected.length;offset+=60){const page=read.listImageCandidatesPage(entity,{offset});assert.equal(page.total,expected.length);assert.ok(page.items.length<=60);actual.push(...page.items)}
  assert.deepEqual(actual,expected)
  assert.equal(new Set(actual.map(item=>item.videoId)).size,actual.length)
  assert.equal(read.listImageCandidatesPage({kind,id:999}).total,0)
 }
})
it('holds count and candidate rows in the same snapshot across a cover removal',()=>{
 const db=getDb();db.exec("INSERT INTO videos(code,cover_path,director_id) VALUES('ONE','one.jpg',1)")
 const other=new Database(path.join(root,'catalog.db')),prepare=db.prepare.bind(db);let fired=false
 db.prepare=((sql:string)=>{const stmt=prepare(sql);if(sql.startsWith('SELECT COUNT(*) AS n FROM videos')){const get=stmt.get.bind(stmt);stmt.get=((...args:unknown[])=>{const result=get(...args);if(!fired){fired=true;other.exec('UPDATE videos SET cover_path=NULL')}return result}) as typeof stmt.get}return stmt}) as typeof db.prepare
 try {const page=read.listImageCandidatesPage({kind:'director',id:1});assert.equal(page.total,1);assert.equal(page.items[0].coverPath,'one.jpg');assert.equal(read.listImageCandidatesPage({kind:'director',id:1}).total,0)}finally{db.prepare=prepare;other.close()}
})
it('rejects unsafe entity IDs, unsupported page flags and excessive pages',()=>{
 const schema=appIpcSchemas[IPC.CLASSIFICATION_IMAGE_PAGE],entity={kind:'series' as const,id:1}
 assert.equal(schema.safeParse([entity]).success,true)
 assert.deepEqual(read.listImageCandidatesPage(entity),{items:[],total:0,limit:60,offset:0})
 for(const id of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1]){assert.throws(()=>read.listImageCandidatesPage({...entity,id}));assert.equal(schema.safeParse([{...entity,id}]).success,false)}
 for(const q of [{limit:0},{limit:101},{offset:-1},{offset:0.5},{offset:Number.MAX_SAFE_INTEGER+1}]){assert.throws(()=>read.listImageCandidatesPage(entity,q));assert.equal(schema.safeParse([entity,q]).success,false)}
 assert.equal(schema.safeParse([entity,{sort:'code'}]).success,false)
})
