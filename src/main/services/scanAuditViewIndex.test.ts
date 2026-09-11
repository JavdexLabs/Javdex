import {it,beforeEach,afterEach} from 'node:test'
import Database from 'better-sqlite3'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {LibraryScanAudit,LibraryScanFileAuditEntry} from '@shared/libraryTypes'
import type {ScanAuditViewQuery} from '@shared/scanAuditReadTypes'
import {SCAN_AUDIT_OUTCOMES} from '@shared/scanAuditReadTypes'
import {buildScanAuditViewItems,isAttentionFile} from '@shared/scanAuditView'
import {createScanAuditReadIndex} from './scanAuditReadIndex'
import {initDatabaseAtPath,getDb,closeDatabase} from '../db/database'
import {createMediaLibrary} from '../db/mediaLibraryRepo'
let root:string,filename:string,audit:LibraryScanAudit,unrecognized:Array<{rootId:number;filePath:string}>
const budgets={sourceBytes:16*1024*1024,indexBytes:32*1024*1024,pageBytes:1024*1024}
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-audit-view-'));filename=path.join(root,'catalog.db');const db=initDatabaseAtPath(filename)
 const directory=path.join(root,'media');fs.mkdirSync(directory);const library=createMediaLibrary({name:'Audit view',roots:[{path:directory}]})
 const files=Array.from({length:225},(_,i)=>({rootId:library.roots[0].id,filePath:path.join(directory,`${i%13===0?'Iİ':'MOV'}-${i}.mp4`),sourceKind:'local',outcome:SCAN_AUDIT_OUTCOMES[i%7],videoId:i+1,videoCode:`CODE-${i}`,resourceId:i+1,resourceKind:'local',createdVideo:i%2===0,updateKind:'metadata_refreshed',normalizedCode:`CODE-${i}`,groupId:i+1,addedToQueue:true,skipReason:'unchanged',failureCode:'empty_target',message:'failure %_ quote',...(i%4===0?{nfo:{disposition:['imported','skipped','warning','identity-conflict','pending-candidate'][i%5],pendingIdentityId:i+1,pendingScrapeId:i+1,warnings:[{code:'notice',message:'消息'}]}}:{})})) as LibraryScanFileAuditEntry[]
 audit={schemaVersion:2,libraryId:library.id,runId:'view-run',finishedAt:'now',startedAt:'before',configRevision:1,trigger:'manual',status:'success',files,
  removedResources:Array.from({length:50},(_,i)=>({resourceId:i+1,videoId:i+1,videoCode:`R-${i}`,videoTitle:null,resourceKind:'local',sourcePath:files[i].filePath,displayName:null,reason:'missing'})),
  promotedResources:Array.from({length:20},(_,i)=>({resourceId:1000+i,videoId:i+1,videoCode:`P-${i}`,videoTitle:'title',resourceKind:'web',sourcePath:null,displayName:null,reason:'promoted_after_removal'})),
  deletedVideos:Array.from({length:25},(_,i)=>({videoId:i+1,videoCode:`D-${i}`,videoTitle:null,reason:'resource_less'})),
  pendingGroups:Array.from({length:15},(_,i)=>({groupId:i+1,normalizedCode:`GROUP-${i}`,resourceCount:i+1}))}
 db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES(?, ?,1,'manual','completed','before',?)").run(audit.runId,library.id,JSON.stringify(audit))
 unrecognized=Array.from({length:150},(_,i)=>({rootId:library.roots[0].id,filePath:i<100?files[i].filePath:path.join(directory,`EXTRA-${i}.mp4`)}))
 const insert=db.prepare('INSERT INTO library_unrecognized_files(library_id,root_id,file_path,normalized_path,scan_run_id,last_seen_at) VALUES(?,?,?,?,?,?)')
 unrecognized.forEach((item,i)=>insert.run(library.id,item.rootId,item.filePath,String(i).padStart(5,'0'),audit.runId,'now'))
 insert.run(library.id,library.roots[0].id,unrecognized[0].filePath,'zz-duplicate',audit.runId,'now');unrecognized.push(unrecognized[0])
})
afterEach(()=>{closeDatabase();fs.rmSync(root,{recursive:true,force:true})})
function expected(query:ScanAuditViewQuery){const items=buildScanAuditViewItems({audit,unrecognized,activeTab:query.tab,outcome:query.outcome??'all',changesFilter:query.changesFilter??'all'}),needle=query.tab==='all'?(query.search??'').trim().toLocaleLowerCase(query.locale??'en-US'):'';return needle?items.filter(item=>`${item.title} ${item.detail} ${item.path??''}`.toLocaleLowerCase(query.locale??'en-US').includes(needle)):items}
it('matches every historical view field/order across combined filters, Unicode search and pages',()=>{
 const index=createScanAuditReadIndex(filename,audit,budgets,{views:true})
 try{
  const queries:ScanAuditViewQuery[]=[{tab:'failed'},{tab:'added_updated'},{tab:'skipped'},...(['all','removed','promoted','deleted'] as const).map(changesFilter=>({tab:'changes' as const,changesFilter}))]
  for(const outcome of ['all',...SCAN_AUDIT_OUTCOMES] as const)for(const search of ['', 'nfo','%_', 'ı'])for(const locale of ['en-US','tr'])queries.push({tab:'all',outcome,search,locale})
  const unique=[...new Map(unrecognized.map(item=>[item.filePath,item])).values()],unrecAudit=new Set(audit.files.filter(file=>file.outcome==='unrecognized').map(file=>file.filePath))
  const badge=audit.files.filter(isAttentionFile).length+audit.pendingGroups.length+unique.filter(item=>!unrecAudit.has(item.filePath)).length
  for(const query of queries){const oracle=expected(query),actual=[]
   for(let offset=0;offset<Math.max(1,oracle.length);offset+=37){const page=index.readViewPage({...query,locale:query.locale??'en-US',offset,limit:37});assert.equal(page.total,oracle.length);assert.equal(page.attentionBadgeCount,badge);actual.push(...page.items)}
   assert.deepEqual(actual,oracle,JSON.stringify(query))
  }
 }finally{index.dispose()}
})
it('locates failed-view anchors, clamps shrink/overflow, and keeps copied pending-path state',()=>{
 const index=createScanAuditReadIndex(filename,audit,budgets,{views:true})
 try{
  const items=expected({tab:'failed'})
  for(const anchor of [{kind:'path' as const,value:unrecognized[149].filePath},{kind:'group' as const,id:15}]){
   const position=items.findIndex(item=>item.groupId?anchor.kind==='group'&&item.groupId===anchor.id:anchor.kind==='path'&&item.path===anchor.value)
   assert.ok(position>=0);const page=index.readViewPage({tab:'failed',anchor,limit:37});assert.equal(page.anchorOffset,Math.floor(position/37)*37);assert.deepEqual(page.items,items.slice(page.offset,page.offset+37))
  }
  const beyond=index.readViewPage({tab:'failed',offset:999999,limit:37});assert.equal(beyond.offset,Math.floor((items.length-1)/37)*37)
  assert.equal(index.readViewPage({tab:'failed',anchor:{kind:'path',value:'/missing'}}).anchorOffset,null)
  getDb().prepare('DELETE FROM library_unrecognized_files WHERE library_id=?').run(audit.libraryId)
  assert.deepEqual(index.readViewPage({tab:'failed',limit:100}).items,items.slice(0,100))
  const fresh=createScanAuditReadIndex(filename,audit,budgets,{views:true})
  try{unrecognized=[];assert.deepEqual(fresh.readViewPage({tab:'failed'}).items,expected({tab:'failed'}).slice(0,100))}finally{fresh.dispose()}
 }finally{index.dispose()}
})
it('rejects invalid view inputs and oversized output without mutating the source',()=>{
 const index=createScanAuditReadIndex(filename,audit,{...budgets,pageBytes:1000},{views:true})
 try{
  assert.throws(()=>index.readViewPage({tab:'all'}),/byte budget/)
  assert.equal(index.readViewPage({tab:'all',limit:1}).items.length,1)
  for(const query of [{tab:'all',limit:101},{tab:'all',offset:-1},{tab:'all',search:'x'.repeat(501)},{tab:'all',locale:'not_valid'},{tab:'all',anchor:{kind:'group',id:1}}])assert.throws(()=>index.readViewPage(query as ScanAuditViewQuery))
 }finally{index.dispose()}
 assert.equal(JSON.parse((getDb().prepare('SELECT audit_json FROM library_scan_runs WHERE id=?').get(audit.runId) as {audit_json:string}).audit_json).files.length,225)
})

it('reuses one bounded search result across pages and restores read-only mode after TEMP exhaustion',()=>{
 const original=Database.prototype.function
 const connections:Database.Database[]=[]
 let calls=0
 Database.prototype.function=function(this:Database.Database,name,...args){
  if(name==='scan_audit_search_contains'){
   connections.push(this)
   const callback=args[args.length-1] as (...values:unknown[])=>unknown
   args[args.length-1]=(raw:unknown,needle:unknown,locale:unknown)=>{calls++;return callback(raw,needle,locale)}
  }
  return original.apply(this,[name,...args] as Parameters<typeof original>)
 } as typeof original
 let index:ReturnType<typeof createScanAuditReadIndex>|undefined
 try{
  index=createScanAuditReadIndex(filename,audit,budgets,{views:true})
  const connection=connections[0]
  assert.ok(connection)
  const first=index.readViewPage({tab:'all',search:'MOV',locale:'en-US',limit:20})
  assert.equal(calls,audit.files.length)
  const afterFirst=calls
  index.readViewPage({tab:'all',search:'MOV',locale:'en-US',limit:37,offset:37})
  assert.equal(calls,afterFirst,'page and limit changes must not recompute search')
  assert.equal(connection.pragma('query_only',{simple:true}),1)
  index.readViewPage({tab:'all',search:'no-match',locale:'en-US'})
  assert.equal(calls,afterFirst+audit.files.length)
  assert.equal((connection.prepare('SELECT COUNT(*) AS n FROM temp.scan_audit_view_matches').get() as {n:number}).n,0)
  // Remove the old result and cap TEMP at its occupied page count: rebuilding
  // larger pointer storage must fail without disabling readonly protection.
  connection.pragma('query_only = OFF')
  connection.exec('DROP TABLE temp.scan_audit_view_matches; VACUUM temp')
  const pages=Number(connection.pragma('temp.page_count',{simple:true}))
  connection.pragma(`temp.max_page_count = ${pages}`)
  connection.exec('CREATE TEMP TABLE reserve_space(payload BLOB)')
  const reserve=connection.prepare('INSERT INTO temp.reserve_space VALUES(zeroblob(4096))')
  assert.throws(()=>{for(let i=0;i<=pages;i++)reserve.run()},/full/i)
  connection.pragma('query_only = ON')
  assert.throws(()=>index!.readViewPage({tab:'all',search:'MOV',locale:'en-US'}),/full/i)
  assert.equal(connection.pragma('query_only',{simple:true}),1)
  assert.throws(()=>connection!.exec('DELETE FROM library_scan_runs'),/readonly/i)
  connection.pragma('query_only = OFF')
  connection.pragma(`temp.max_page_count = ${Math.floor(budgets.indexBytes/Number(connection.pragma('temp.page_size',{simple:true})))}`)
  connection.exec('DROP TABLE temp.reserve_space')
  connection.pragma('query_only = ON')
  assert.deepEqual(index.readViewPage({tab:'all',search:'MOV',locale:'en-US',limit:20}),first)
 }finally{Database.prototype.function=original;index?.dispose()}
})
it('preserves pending paths without an audit body only for the exact current summary',()=>{
 const db=getDb(),summary={libraryId:audit.libraryId,runId:audit.runId,status:'success',finishedAt:audit.finishedAt}
 db.prepare('INSERT OR REPLACE INTO media_library_scan_state(library_id,last_summary_json) VALUES(?,?)').run(audit.libraryId,JSON.stringify(summary))
 db.prepare('UPDATE library_scan_runs SET audit_json=NULL WHERE id=?').run(audit.runId)
 const index=createScanAuditReadIndex(filename,audit,budgets,{views:true})
 try{
  const oracle=buildScanAuditViewItems({audit:null,unrecognized,activeTab:'failed',outcome:'all',changesFilter:'all'})
  const first=index.readViewPage({tab:'failed'}),last=index.readViewPage({tab:'failed',offset:100})
  assert.equal(first.auditAvailable,false);assert.equal(first.total,150);assert.equal(first.attentionBadgeCount,150)
  assert.deepEqual([...first.items,...last.items],oracle)
  assert.equal(index.readViewPage({tab:'all'}).total,0)
  assert.equal(index.readViewPage({tab:'changes'}).auditAvailable,false)
  assert.equal(index.readViewPage({tab:'failed',anchor:{kind:'path',value:unrecognized[149].filePath}}).anchorOffset,100)
  assert.throws(()=>index.readPage({section:'files'}),/unavailable/)
  assert.throws(()=>createScanAuditReadIndex(filename,audit,budgets),/unavailable/)
  assert.throws(()=>createScanAuditReadIndex(filename,{...audit,finishedAt:'wrong'},budgets,{views:true}),/summary changed/)
  db.prepare('UPDATE media_library_scan_state SET last_summary_json=? WHERE library_id=?').run(JSON.stringify({...summary,runId:'next'}),audit.libraryId)
  db.prepare('DELETE FROM library_unrecognized_files WHERE library_id=?').run(audit.libraryId)
  assert.deepEqual(index.readViewPage({tab:'failed'}),first,'existing private index remains one immutable source snapshot')
  assert.throws(()=>createScanAuditReadIndex(filename,audit,budgets,{views:true}),/summary changed/)
 }finally{index.dispose()}
})
it('does not hide corrupt or over-budget audit bodies behind unrecognized-only fallback',()=>{
 const db=getDb()
 db.prepare('INSERT OR REPLACE INTO media_library_scan_state(library_id,last_summary_json) VALUES(?,?)').run(audit.libraryId,JSON.stringify({...audit,files:undefined,removedResources:undefined,promotedResources:undefined,deletedVideos:undefined,pendingGroups:undefined}))
 for(const body of ['invalid','{}']){
  db.prepare('UPDATE library_scan_runs SET audit_json=? WHERE id=?').run(body,audit.runId)
  assert.throws(()=>createScanAuditReadIndex(filename,audit,budgets,{views:true}),/JSON|structure/)
 }
 db.prepare('UPDATE library_scan_runs SET audit_json=? WHERE id=?').run(JSON.stringify(audit),audit.runId)
 assert.throws(()=>createScanAuditReadIndex(filename,audit,{...budgets,sourceBytes:1},{views:true}),/source exceeds/)
 const index=createScanAuditReadIndex(filename,audit,budgets,{views:true})
 try{assert.equal(index.readViewPage({tab:'all'}).auditAvailable,true)}finally{index.dispose()}
})
