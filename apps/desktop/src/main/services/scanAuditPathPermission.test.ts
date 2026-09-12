import {beforeEach,afterEach,it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type {LibraryScanAudit} from '@shared/libraryTypes'
import {normalizeLocalPathIdentity} from '@library/localPathIdentity'
import {initDatabaseAtPath,closeDatabase,openReadOnlyDatabaseAtPath} from '@library/db/database'
import {createMediaLibrary} from '@library/db/mediaLibraryRepo'
import {libraryScanAuditContainsPath} from '../scanner/libraryScanAuditStore'
import {normalizeAudit} from '@library/scan/libraryScanAuditValidation'
import {createScanAuditPathPermissionReader} from './scanAuditPathPermission'
let root:string,writer:Database.Database,reader:Database.Database,audit:LibraryScanAudit,rootId:number,read:ReturnType<typeof createScanAuditPathPermissionReader>
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-audit-path-'));const filename=path.join(root,'db.sqlite');writer=initDatabaseAtPath(filename)
 const media=path.join(root,'media');fs.mkdirSync(media);const library=createMediaLibrary({name:'Paths',roots:[{path:media}]});rootId=library.roots[0].id
 audit={schemaVersion:2,libraryId:library.id,runId:'one',configRevision:1,trigger:'manual',status:'success',startedAt:'before',finishedAt:'after',
  files:[{rootId,filePath:'/A.mp4',sourceKind:'local',outcome:'unrecognized'}],
  removedResources:[{resourceId:1,videoId:1,videoCode:'R',videoTitle:null,resourceKind:'local',sourcePath:'/REMOVED.mp4',displayName:null,reason:'missing'}],
  promotedResources:[{resourceId:2,videoId:2,videoCode:'P',videoTitle:null,resourceKind:'local',sourcePath:'/PROMOTED.mp4',displayName:null,reason:'promoted_after_removal'}],deletedVideos:[],pendingGroups:[]}
 writer.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES('one',?,1,'manual','completed','before',?)").run(library.id,JSON.stringify(audit))
 reader=openReadOnlyDatabaseAtPath(filename);read=createScanAuditPathPermissionReader(reader)
})
afterEach(()=>{reader?.close();closeDatabase();fs.rmSync(root,{recursive:true,force:true})})
function replace(value:unknown){writer.prepare("UPDATE library_scan_runs SET audit_json=? WHERE id='one'").run(JSON.stringify(value))}
it('matches legacy validation and folded path membership across all permitted sources',()=>{
 for(const candidate of ['/a.mp4','/removed.mp4','/promoted.mp4','/no.mp4'])assert.equal(read(audit.libraryId,candidate),libraryScanAuditContainsPath(audit,candidate))
 for(const change of [{schemaVersion:1},{schemaVersion:3},{schemaVersion:true},{configRevision:false},{startedAt:''},{files:[...audit.files,{...audit.files[0],rootId:0}]},{files:[...audit.files,{...audit.files[0],nfo:{disposition:'bad'}}]},{removedResources:[{...audit.removedResources[0],sourcePath:4}]},{promotedResources:{}},{pendingGroups:null},{deletedVideos:[null,1]}]){
  const value={...audit,...change};replace(value);const old=normalizeAudit(value)
  assert.equal(read(audit.libraryId,'/a.mp4'),Boolean(old&&libraryScanAuditContainsPath(old,'/a.mp4')),JSON.stringify(change))
 }
 replace({...audit,libraryId:1});assert.equal(read(audit.libraryId,'/a.mp4'),false)
 assert.equal(read(1,'/a.mp4'),false)
 assert.throws(()=>read(audit.libraryId,'relative.mp4'))
 assert.throws(()=>read(0,'/a.mp4'))
})
it('uses the latest non-null run, ignores summary identity and allows indexed unrecognized paths without parsing bad audit',()=>{
 writer.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES('two',?,1,'manual','completed','later','invalid')").run(audit.libraryId)
 assert.equal(read(audit.libraryId,'/a.mp4'),false)
 writer.prepare('INSERT INTO library_unrecognized_files(library_id,root_id,file_path,normalized_path,scan_run_id,last_seen_at) VALUES(?,?,?,?,?,?)').run(audit.libraryId,rootId,'/PENDING.mp4',normalizeLocalPathIdentity('/PENDING.mp4'),'one','now')
 assert.equal(read(audit.libraryId,'/PENDING.mp4'),true)
 writer.exec("UPDATE library_scan_runs SET audit_json=NULL WHERE id='two'")
 assert.equal(read(audit.libraryId,'/a.mp4'),true)
 writer.prepare('INSERT OR REPLACE INTO media_library_scan_state(library_id,last_summary_json) VALUES(?,?)').run(audit.libraryId,JSON.stringify({runId:'other'}))
 assert.equal(read(audit.libraryId,'/removed.mp4'),true)
 assert.equal(reader.pragma('query_only',{simple:true}),1)
 assert.throws(()=>reader.exec('DELETE FROM library_scan_runs'),/readonly/i)
})
it('never parses the complete body in JavaScript and validates later entries after an early path match',()=>{
 audit.files=Array.from({length:2000},(_,i)=>({...audit.files[0],filePath:`/media/${i}.mp4`}))
 replace(audit);const original=JSON.parse;let maxParsed=0,calls=0
 JSON.parse=((value,...args)=>{maxParsed=Math.max(maxParsed,value.length);calls++;return original(value,...args)}) as typeof JSON.parse
 try{assert.equal(read(audit.libraryId,'/media/0.mp4'),true);assert.equal(calls,2002);assert.ok(maxParsed<500)}finally{JSON.parse=original}
 replace({...audit,files:[...audit.files,{...audit.files[0],nfo:{disposition:'warning',warnings:Array(21).fill({code:'x',message:'x'})}}]})
 assert.equal(read(audit.libraryId,'/media/0.mp4'),false)
})
it('keeps authorization on one WAL snapshot when a writer replaces the audit during entry validation',()=>{
 const original=JSON.parse;let changed=false
 JSON.parse=((value,...args)=>{if(!changed){changed=true;replace({...audit,files:[],removedResources:[],promotedResources:[]})}return original(value,...args)}) as typeof JSON.parse
 try{assert.equal(read(audit.libraryId,'/removed.mp4'),true)}finally{JSON.parse=original}
 assert.equal(changed,true);assert.equal(read(audit.libraryId,'/removed.mp4'),false)
})
it('fails closed on duplicate known fields and object strings instead of object entries',()=>{
 for(const body of [JSON.stringify(audit).replace('"schemaVersion":2','"schemaVersion":1,"schemaVersion":2'),JSON.stringify({...audit,files:[JSON.stringify(audit.files[0])]}),'null','[]']){
  writer.prepare("UPDATE library_scan_runs SET audit_json=? WHERE id='one'").run(body)
  assert.equal(read(audit.libraryId,'/a.mp4'),false)
 }
})
for(const format of ['json','entries'])it(`checks the trusted source cap before parsing ${format} JSON`,()=>{
 if(format==='entries')storeEntries(audit)
 const prepare=reader.prepare.bind(reader);let capped=false
 reader.prepare=((sql:string)=>{
  if(/length\s*\(CAST\((?:r\.)?audit_json AS BLOB\)\)/i.test(sql)){
   const statement=prepare(sql),get=statement.get.bind(statement)
   statement.get=((...parameters:unknown[])=>{capped=true;return{...get(...parameters) as Record<string,unknown>,bytes:128*1024*1024+1}}) as typeof statement.get
   return statement
  }
  assert.doesNotMatch(sql,/json_valid|json_each|json_type|scan_audit_path_entry_check/,'over-budget body must never reach JSON parsing')
  return prepare(sql)
 }) as typeof reader.prepare
 try{assert.throws(()=>read(audit.libraryId,'/a.mp4'),/source exceeds byte budget/);assert.equal(capped,true)}finally{reader.prepare=prepare}
})

const sections=['files','removedResources','promotedResources','deletedVideos','pendingGroups'] as const
let entryRunSequence=0
function storeEntries(value:LibraryScanAudit, options:{state?:'collecting'|'sealed'|'published'|'abandoned';meta?:(meta:Record<string,unknown>)=>string;fileKey?:string}={}) {
 const runId=`entries-${++entryRunSequence}`
 const current={...value,runId},meta:Record<string,unknown>={...current}
 for(const section of sections)delete meta[section]
 writer.transaction(()=>{
  writer.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at) VALUES(?,?,1,'manual','running',?)").run(runId,audit.libraryId,`z${String(entryRunSequence).padStart(8,'0')}`)
  writer.prepare('INSERT INTO library_scan_audit_manifests(run_id,meta_json) VALUES(?,?)').run(runId,options.meta?.(meta)??JSON.stringify(meta))
  const insert=writer.prepare('INSERT INTO library_scan_audit_entries(run_id,section,ordinal,entry_key,entry_json,entry_bytes) VALUES(?,?,?,?,?,?)')
  for(const section of sections)for(const [ordinal,entry] of current[section].entries()){
   const raw=JSON.stringify(entry)
   insert.run(runId,section,ordinal,section==='files'?(options.fileKey??(entry as {filePath:string}).filePath):null,raw,Buffer.byteLength(raw))
  }
  const state=options.state??'published'
  if(state==='abandoned')writer.prepare("UPDATE library_scan_audit_manifests SET state='abandoned' WHERE run_id=?").run(runId)
  if(state==='sealed'||state==='published')writer.prepare("UPDATE library_scan_audit_manifests SET state='sealed',sealed_at='sealed' WHERE run_id=?").run(runId)
  if(state==='published'){
   writer.prepare("UPDATE library_scan_runs SET status='completed',finished_at=? WHERE id=?").run(value.finishedAt,runId)
   writer.prepare("UPDATE library_scan_audit_manifests SET state='published',published_at='published' WHERE run_id=?").run(runId)
  }
 })()
 return current
}

it('matches the legacy permission oracle for published entries and ignores unpublished manifests',()=>{
 const value={...audit,files:[{...audit.files[0],filePath:'/ENTRIES.mp4'}]}
 for(const state of ['collecting','sealed','abandoned'] as const){
  storeEntries(value,{state})
  assert.equal(read(audit.libraryId,'/entries.mp4'),false)
  assert.equal(read(audit.libraryId,'/a.mp4'),true)
 }
 const current=storeEntries(value)
 for(const candidate of ['/entries.mp4','/a.mp4','/removed.mp4','/promoted.mp4','/missing.mp4']){
  assert.equal(read(audit.libraryId,candidate),libraryScanAuditContainsPath(current,candidate))
 }
 assert.equal(read(1,'/entries.mp4'),false)
 assert.equal(reader.pragma('query_only',{simple:true}),1)
 assert.throws(()=>reader.exec('DELETE FROM library_scan_audit_entries'),/readonly/i)
})

it('rejects invalid entry metadata, hidden collections, duplicate identity and mismatched published identity',()=>{
 const changes=[
  (meta:Record<string,unknown>)=>JSON.stringify({...meta,libraryId:1}),
  (meta:Record<string,unknown>)=>JSON.stringify({...meta,runId:'wrong'}),
  (meta:Record<string,unknown>)=>JSON.stringify({...meta,finishedAt:'wrong'}),
  (meta:Record<string,unknown>)=>JSON.stringify({...meta,schemaVersion:3}),
  (meta:Record<string,unknown>)=>JSON.stringify({...meta,startedAt:{hidden:'before'}}),
  (meta:Record<string,unknown>)=>JSON.stringify(meta).replace('"schemaVersion":2','"schemaVersion":1,"schemaVersion":2'),
  ...sections.flatMap(section=>[[],null,{hidden:[audit.files[0]]}].map(hidden=>(meta:Record<string,unknown>)=>JSON.stringify({...meta,[section]:hidden})))
 ]
 for(const meta of changes){
  storeEntries(audit,{meta})
  assert.equal(read(audit.libraryId,'/a.mp4'),false)
 }
 writer.prepare('INSERT INTO library_unrecognized_files(library_id,root_id,file_path,normalized_path,scan_run_id,last_seen_at) VALUES(?,?,?,?,?,?)').run(audit.libraryId,rootId,'/PENDING.mp4',normalizeLocalPathIdentity('/PENDING.mp4'),'one','now')
 assert.equal(read(audit.libraryId,'/PENDING.mp4'),true,'indexed fastpath must not parse invalid metadata')
})

it('validates every entry after a match and checks file key identity without weakening legacy validators',()=>{
 for(const change of [
  {files:[...audit.files,{...audit.files[0],filePath:'/late.mp4',rootId:0}]},
  {files:[...audit.files,{...audit.files[0],filePath:'/late.mp4',nfo:{disposition:'bad'}}]},
  {removedResources:[{...audit.removedResources[0],sourcePath:4}]},
  {promotedResources:[{...audit.promotedResources[0],videoCode:''}]}
 ]){
  const value={...audit,...change} as LibraryScanAudit
  const current=storeEntries(value),old=normalizeAudit(current)
  assert.equal(read(audit.libraryId,'/a.mp4'),Boolean(old&&libraryScanAuditContainsPath(old,'/a.mp4')))
  assert.equal(read(audit.libraryId,'/a.mp4'),false)
 }
 storeEntries(audit,{fileKey:'/different.mp4'})
 assert.equal(read(audit.libraryId,'/a.mp4'),false)
 storeEntries(audit)
 assert.equal(read(audit.libraryId,'/a.mp4'),true)
})

it('streams published entries in ordinal order with small JS parses and one WAL snapshot',()=>{
 const value={...audit,files:Array.from({length:2000},(_,i)=>({...audit.files[0],filePath:`/entries/${i}.mp4`}))}
 const current=storeEntries(value)
 const original=JSON.parse;let calls=0,maxParsed=0,changed=false;const paths:string[]=[]
 JSON.parse=((raw,...args)=>{
  calls++;maxParsed=Math.max(maxParsed,raw.length)
  const parsed=original(raw,...args)
  if(parsed.filePath)paths.push(parsed.filePath)
  if(!changed){changed=true;writer.prepare('DELETE FROM library_scan_runs WHERE id=?').run(current.runId)}
  return parsed
 }) as typeof JSON.parse
 try{
  assert.equal(read(audit.libraryId,'/entries/0.mp4'),true)
  assert.equal(calls,2002);assert.ok(maxParsed<500)
  assert.deepEqual(paths,value.files.map(entry=>entry.filePath))
 }finally{JSON.parse=original}
 assert.equal(changed,true)
 assert.equal(read(audit.libraryId,'/entries/0.mp4'),false)
 assert.equal(read(audit.libraryId,'/a.mp4'),true,'next request selects remaining legacy source')
 assert.deepEqual(writer.pragma('foreign_key_check'),[])
})
