import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { LibraryScanSummary } from '@shared/libraryTypes'
import { initDatabaseAtPath, closeDatabase } from './database'
import { createScanAuditWriter, type ScanAuditMetadata } from './scanAuditWriter'
import { beginLibraryScanRun, finishLibraryScanEntriesRun, type LibraryUnrecognizedFileInput } from './libraryScanRepo'
import { iterateScanAuditUnrecognizedPaths } from './scanAuditUnrecognizedPaths'

let db:Database.Database,directory:string,writer:ReturnType<typeof createScanAuditWriter>
const scope={libraryId:1,runId:'paths'}
const meta:ScanAuditMetadata={schemaVersion:2,...scope,configRevision:1,trigger:'manual',startedAt:'start',finishedAt:'finish',status:'success'}
const summary:LibraryScanSummary={...scope,configRevision:1,trigger:'manual',startedAt:'start',finishedAt:'finish',status:'success',
  scannedFiles:3,resourcesAdded:0,resourcesUpdated:0,resourcesRemoved:0,primaryResourcesPromoted:0,videosDeleted:0,
  skippedFiles:1,failedFiles:2,pendingScanGroups:0,pendingScanResources:0,offlineFolders:[],errorSummary:null}
beforeEach(()=>{
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-unrecognized-paths-'))
  db=initDatabaseAtPath(path.join(directory,'catalog.db'))
  db.exec(`INSERT INTO media_library_roots(id,library_id,path,normalized_path) VALUES(1,1,'/fixture','/fixture');
    INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES('old',1,1,'manual','completed','old','{}');
    INSERT INTO library_unrecognized_files(library_id,root_id,file_path,normalized_path,scan_run_id,last_seen_at) VALUES(1,1,'/fixture/old','/fixture/old','old','old');`)
  beginLibraryScanRun({...scope,configRevision:1,trigger:'manual',startedAt:'start'})
  writer=createScanAuditWriter(db,scope);writer.start(meta)
  writer.writeBatch('files',['/fixture/z','/fixture/recognized','/fixture/a'].map(filePath=>({rootId:1,filePath,sourceKind:'local' as const,outcome:'unrecognized' as const})))
  writer.writeBatch('files',[
    {rootId:1,filePath:'/fixture/recognized',sourceKind:'local',outcome:'skipped',skipReason:'unchanged'},
    {rootId:1,filePath:'/fixture/z',sourceKind:'local',outcome:'unrecognized'}
  ])
})
afterEach(()=>{closeDatabase();fs.rmSync(directory,{recursive:true,force:true})})
function snapshot(){return {
  runs:db.prepare('SELECT * FROM library_scan_runs ORDER BY id').all(),
  state:db.prepare('SELECT * FROM media_library_scan_state ORDER BY library_id').all(),
  unrecognized:db.prepare('SELECT * FROM library_unrecognized_files ORDER BY normalized_path').all(),
  manifest:db.prepare('SELECT * FROM library_scan_audit_manifests ORDER BY run_id').all(),
  entries:db.prepare('SELECT * FROM library_scan_audit_entries ORDER BY section,ordinal').all()
}}
function finish(unrecognizedFiles:Iterable<LibraryUnrecognizedFileInput>){
  finishLibraryScanEntriesRun({...scope,status:'completed',summary,replaceUnrecognizedRootIds:[1],unrecognizedFiles})
}
function mapped(failSecond=false){
  const iterator=iterateScanAuditUnrecognizedPaths(db,{...scope})
  const originalReturn=iterator.return!.bind(iterator)
  let returned=0,closed=false,count=0
  iterator.return=(value?:unknown)=>{returned++;return originalReturn(value)}
  const input=(function*(){
    try{
      for(const filePath of iterator){
        assert.equal(db.inTransaction,true)
        if(++count===2){
          assert.equal((db.prepare("SELECT COUNT(*) AS n FROM library_unrecognized_files WHERE scan_run_id='paths'").get() as {n:number}).n,1)
          if(failSecond)throw new Error('second path authorization/map failed')
        }
        yield {rootId:1,filePath,normalizedPath:filePath}
      }
    }finally{closed=true}
  })()
  return {input,iterator,get returned(){return returned},get closed(){return closed}}
}

it('uses final upsert outcomes and original ordinal order without full-entry hydration or all()',t=>{
  writer.seal(meta)
  const prepare=db.prepare
  let keysetGets=0
  const spy=t.mock.method(db,'prepare',function(sql:string){
    const statement=prepare.call(db,sql)
    statement.all=(()=>{assert.fail('path iterator must not materialize an all() array')}) as typeof statement.all
    if(sql.includes('FROM library_scan_audit_entries')){
      assert.match(sql,/ordinal\s*>\s*\?/);assert.match(sql,/ORDER BY ordinal LIMIT 1/i)
      const projection=sql.slice(0,sql.indexOf('FROM'))
      assert.doesNotMatch(projection,/entry_json|\*/i)
      const get=statement.get.bind(statement)
      statement.get=((...args:unknown[])=>{keysetGets++;const row=Reflect.apply(get,statement,args) as Record<string,unknown>|undefined;if(row)assert.equal(Object.hasOwn(row,'entry_json'),false);return row}) as typeof statement.get
    }
    return statement
  })
  try{assert.deepEqual(db.transaction(()=>Array.from(iterateScanAuditUnrecognizedPaths(db,scope)))(),['/fixture/z','/fixture/a'])}
  finally{spy.mock.restore()}
  assert.equal(keysetGets,3)
})

it('rejects wrong identity/state and checks transaction and sealed state on every resume',()=>{
  assert.throws(()=>iterateScanAuditUnrecognizedPaths(db,{libraryId:0,runId:'paths'}))
  assert.throws(()=>db.transaction(()=>iterateScanAuditUnrecognizedPaths(db,scope).next())(),/sealed/i)
  writer.seal(meta)
  assert.throws(()=>iterateScanAuditUnrecognizedPaths(db,scope).next(),/transaction/i)
  for(const bad of [{libraryId:2,runId:'paths'},{libraryId:1,runId:'missing'}])assert.throws(()=>db.transaction(()=>iterateScanAuditUnrecognizedPaths(db,bad).next())(),/scoped|sealed/i)
  const outside=iterateScanAuditUnrecognizedPaths(db,scope)
  db.transaction(()=>assert.equal(outside.next().value,'/fixture/z'))()
  assert.throws(()=>outside.next(),/transaction/i)
  db.transaction(()=>{
    const changing=iterateScanAuditUnrecognizedPaths(db,scope)
    assert.equal(changing.next().value,'/fixture/z')
    db.prepare("UPDATE library_scan_audit_manifests SET state='abandoned' WHERE run_id='paths'").run()
    assert.throws(()=>changing.next(),/sealed/i)
  })()
})

it('captures identity before first consumption and does not normalize returned path strings',()=>{
  writer.writeBatch('files',[{rootId:1,filePath:'/fixture/sub/../MiXeD',sourceKind:'local',outcome:'unrecognized'}]);writer.seal(meta)
  const mutable={...scope},iterator=iterateScanAuditUnrecognizedPaths(db,mutable)
  mutable.libraryId=999;mutable.runId='other'
  assert.deepEqual(db.transaction(()=>Array.from(iterator))(),['/fixture/z','/fixture/a','/fixture/sub/../MiXeD'])
})

it('rejects failed/cancelled or deleted runs on resume instead of reporting normal EOF',()=>{
  writer.seal(meta)
  const restore=new Error('restore fixture transaction')
  for(const mutation of [
    "UPDATE library_scan_runs SET status='failed',finished_at='stopped' WHERE id='paths'",
    "UPDATE library_scan_runs SET status='cancelled',finished_at='stopped' WHERE id='paths'",
    "DELETE FROM library_scan_runs WHERE id='paths'"
  ]){
    assert.throws(()=>db.transaction(()=>{
      const iterator=iterateScanAuditUnrecognizedPaths(db,scope)
      assert.equal(iterator.next().value,'/fixture/z')
      db.exec(mutation)
      assert.throws(()=>iterator.next(),/sealed|scope|running|completed/i)
      throw restore
    })(),error=>error===restore)
  }
})

it('publishes on the same connection while mapping lazy paths without a busy cursor',()=>{
  writer.seal(meta);const mapping=mapped()
  finish(mapping.input)
  assert.equal(mapping.closed,true)
  assert.deepEqual(db.prepare('SELECT file_path,scan_run_id FROM library_unrecognized_files ORDER BY normalized_path').all(),[
    {file_path:'/fixture/a',scan_run_id:'paths'},{file_path:'/fixture/z',scan_run_id:'paths'}
  ])
  assert.equal((db.prepare("SELECT state FROM library_scan_audit_manifests WHERE run_id='paths'").get() as {state:string}).state,'published')
  assert.equal((db.prepare("SELECT status FROM library_scan_runs WHERE id='paths'").get() as {status:string}).status,'completed')
  assert.deepEqual(db.pragma('foreign_key_check'),[])
})

for(const failure of ['mapping','native-write'] as const)it(`closes the path iterator and rolls back publication on second ${failure} failure, then retries`,()=>{
  writer.seal(meta);const before=snapshot(),mapping=mapped(failure==='mapping')
  if(failure==='native-write')db.exec(`CREATE TEMP TRIGGER fail_second_path BEFORE INSERT ON library_unrecognized_files
    WHEN NEW.file_path='/fixture/a' BEGIN SELECT RAISE(ABORT,'second path native write failed');END;`)
  assert.throws(()=>finish(mapping.input),failure==='mapping'?/authorization\/map failed/:/native write failed/)
  assert.equal(mapping.closed,true);assert.equal(mapping.returned,1)
  assert.deepEqual(mapping.iterator.next(),{value:undefined,done:true})
  assert.equal(db.inTransaction,false);assert.deepEqual(snapshot(),before)
  if(failure==='native-write')db.exec('DROP TRIGGER fail_second_path')
  const retry=mapped();finish(retry.input);assert.equal(retry.closed,true)
  assert.equal((db.prepare("SELECT state FROM library_scan_audit_manifests WHERE run_id='paths'").get() as {state:string}).state,'published')
  assert.deepEqual(db.pragma('foreign_key_check'),[])
})
