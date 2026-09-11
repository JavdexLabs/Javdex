import {afterEach,beforeEach,it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {initDatabaseAtPath,closeDatabase,getDb} from '../db/database'
import {createScanAuditReadIndex,type ScanAuditSnapshotIdentity,type ScanAuditSection} from './scanAuditReadIndex'
let root:string
const identity:ScanAuditSnapshotIdentity={libraryId:1,runId:'index-test',finishedAt:'2026-09-11T00:00:00Z'}
const limits={sourceBytes:8*1024*1024,indexBytes:16*1024*1024,pageBytes:1024*1024}
const sections:ScanAuditSection[]=['files','removedResources','promotedResources','deletedVideos','pendingGroups']
function fixture(){
 return {...identity,schemaVersion:2,
  files:Array.from({length:325},(_,i)=>({rootId:1,filePath:`/media/${i}.mp4`,sourceKind:'local',outcome:['added','updated','pending','skipped','unrecognized','strm_failure','processing_failure'][i%7],...(i%3===0?{nfo:{disposition:['imported','skipped','warning','identity-conflict','pending-candidate'][i%5]}}:{})})),
  removedResources:Array.from({length:125},(_,i)=>({resourceId:i+1,videoId:i+1,videoCode:`REM-${i}`,sourcePath:null})),
  promotedResources:[{resourceId:1000,videoId:1,videoCode:'PROM',sourcePath:'/media/promoted'}],
  deletedVideos:[{videoId:2,videoCode:'DEL',reason:'resource_less'}],pendingGroups:[{groupId:1,normalizedCode:'PENDING',resourceCount:4}]
 }
}
function persist(value:unknown){getDb().prepare('UPDATE library_scan_runs SET audit_json=? WHERE id=?').run(JSON.stringify(value),identity.runId)}
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-audit-index-'));const db=initDatabaseAtPath(path.join(root,'catalog.db'))
 db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES(?,1,1,'manual','completed','2026-09-11',?)").run(identity.runId,JSON.stringify(fixture()))
})
afterEach(()=>{closeDatabase();fs.rmSync(root,{recursive:true,force:true})})
it('pages every section with stable ordinal, filtered totals and independent results',()=>{
 const expected=fixture(),input={...identity},budget={...limits}
 const index=createScanAuditReadIndex(path.join(root,'catalog.db'),input,budget)
 input.libraryId=999;budget.pageBytes=1
 try{
  for(const section of sections){
   const actual=[]
   for(let offset=0;offset<=expected[section].length;offset+=100){
    const page=index.readPage({section,offset});assert.equal(page.total,expected[section].length);assert.deepEqual(page.snapshot,identity)
    assert.deepEqual(page.items.map(item=>item.ordinal),Array.from({length:page.items.length},(_,i)=>offset+i));actual.push(...page.items.map(item=>item.entry))
   }
   assert.deepEqual(actual,expected[section])
  }
  for(const outcome of [undefined,'skipped','unrecognized'] as const)for(const attention of [undefined,true,false]){
   const selected=expected.files.map((entry,ordinal)=>({entry,ordinal})).filter(({entry})=>(outcome===undefined||entry.outcome===outcome)&&(attention===undefined||(['unrecognized','strm_failure','processing_failure'].includes(entry.outcome)||['warning','identity-conflict','pending-candidate'].includes(entry.nfo?.disposition??''))===attention))
   const actual=[]
   for(let offset=0;offset<=selected.length;offset+=100){const page=index.readPage({section:'files',outcome,attention,offset});assert.equal(page.total,selected.length);actual.push(...page.items)}
   assert.deepEqual(actual,selected)
  }
  const changed=index.readPage({section:'files'});changed.items[0].entry.filePath='mutated';changed.snapshot.runId='mutated'
  assert.equal(index.readPage({section:'files'}).items[0].entry.filePath,expected.files[0].filePath)
  assert.equal(index.getInfo().snapshot.runId,identity.runId)
  assert.ok(index.getInfo().indexBytes<=limits.indexBytes)
 }finally{index.dispose();index.dispose()}
 assert.throws(()=>index.readPage({section:'files'}),/closed/)
})
it('holds an immutable copied snapshot across writer changes and leaves main schema/data unchanged',()=>{
 const db=getDb(),schema=db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),version=db.pragma('user_version',{simple:true})
 const index=createScanAuditReadIndex(path.join(root,'catalog.db'),identity,limits)
 try{
  persist({...fixture(),files:[]})
  assert.equal(index.readPage({section:'files'}).total,325)
  const fresh=createScanAuditReadIndex(path.join(root,'catalog.db'),identity,limits)
  try{assert.equal(fresh.readPage({section:'files'}).total,0)}finally{fresh.dispose()}
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),schema)
  assert.equal(db.pragma('user_version',{simple:true}),version)
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE name='scan_audit_entries'").get() as {n:number}).n,0)
  assert.equal(db.inTransaction,false)
 }finally{index.dispose()}
})
it('rejects source/index/page budget overflows without truncation and can rebuild after failure',()=>{
 const file=path.join(root,'catalog.db')
 for(const value of [0,-1,Infinity,0.5]) assert.throws(()=>createScanAuditReadIndex(file,identity,{...limits,sourceBytes:value}),/Invalid/)
 assert.throws(()=>createScanAuditReadIndex(file,identity,{...limits,sourceBytes:100}),/source exceeds/)
 assert.throws(()=>createScanAuditReadIndex(file,identity,{...limits,indexBytes:4096}),/full|space budget/)
 const index=createScanAuditReadIndex(file,identity,{...limits,pageBytes:1000})
 try{
  assert.throws(()=>index.readPage({section:'files'}),/page exceeds/)
  assert.equal(index.readPage({section:'files',limit:1}).items.length,1)
  assert.throws(()=>index.readPage({section:'files',limit:101}),/Invalid/)
  assert.throws(()=>index.readPage({section:'pendingGroups',attention:true}),/Invalid/)
  assert.throws(()=>index.readPage({section:'files',offset:-1}),/Invalid/)
 }finally{index.dispose()}
 const wrapped=createScanAuditReadIndex(file,identity,{...limits,pageBytes:Buffer.byteLength(JSON.stringify(fixture().files[0]))+1})
 try{assert.throws(()=>wrapped.readPage({section:'files',limit:1}),/page exceeds/)}finally{wrapped.dispose()}
 const fresh=createScanAuditReadIndex(file,identity,limits);fresh.dispose()
 assert.equal(JSON.parse((getDb().prepare('SELECT audit_json FROM library_scan_runs WHERE id=?').get(identity.runId) as {audit_json:string}).audit_json).files.length,325)
})
it('rejects wrong scope, mismatched versions/identity, malformed collections and non-object entries',()=>{
 const file=path.join(root,'catalog.db')
 assert.throws(()=>createScanAuditReadIndex(file,{...identity,libraryId:2},limits),/unavailable/)
 for(const value of [{...fixture(),schemaVersion:3},{...fixture(),runId:'other'},{...fixture(),finishedAt:'other'},{...fixture(),files:{}},{...fixture(),files:[null]},{...fixture(),files:[{outcome:'unknown'}]}]){
  persist(value);assert.throws(()=>createScanAuditReadIndex(file,identity,limits))
 }
 for(const section of sections){persist({...fixture(),[section]:[JSON.stringify(fixture()[section][0])]});assert.throws(()=>createScanAuditReadIndex(file,identity,limits))}
 getDb().prepare('UPDATE library_scan_runs SET audit_json=? WHERE id=?').run('{bad',identity.runId)
 assert.throws(()=>createScanAuditReadIndex(file,identity,limits),/Invalid audit JSON/)
 persist({...fixture(),schemaVersion:1});const fresh=createScanAuditReadIndex(file,identity,limits);fresh.dispose()
})

it('copies all collections from one read snapshot when the writer commits during construction',()=>{
 const original=Database.prototype.prepare,expected=fixture();let changed=false
 Database.prototype.prepare=function(this:Database.Database,sql:string){
  const statement=original.call(this,sql)
  if(sql.includes('INSERT INTO temp.scan_audit_entries')){
   const run=statement.run.bind(statement) as (...args:unknown[])=>Database.RunResult
   statement.run=((...args:unknown[])=>{
    const result=run(...args)
    if(!changed){changed=true;persist({...fixture(),files:[],removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[]})}
    return result
   }) as typeof statement.run
  }
  return statement
 } as typeof Database.prototype.prepare
 let index:ReturnType<typeof createScanAuditReadIndex>|undefined
 try{
  index=createScanAuditReadIndex(path.join(root,'catalog.db'),identity,limits)
  assert.equal(changed,true)
  for(const section of sections){const page=index.readPage({section});assert.equal(page.total,expected[section].length);assert.deepEqual(page.items.map(item=>item.entry),expected[section].slice(0,100))}
 }finally{Database.prototype.prepare=original;index?.dispose()}
 const fresh=createScanAuditReadIndex(path.join(root,'catalog.db'),identity,limits)
 try{for(const section of sections)assert.equal(fresh.readPage({section}).total,0)}finally{fresh.dispose()}
})
