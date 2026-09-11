import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LibraryScanFileAuditEntry } from '@shared/libraryTypes'
import { closeDatabase, initDatabaseAtPath, openReadOnlyDatabaseAtPath } from '../db/database'
import { createMediaLibrary } from '../db/mediaLibraryRepo'
import { upsertPendingScanResources } from '../db/pendingScanRepo'
import { upsertPendingResourceIdentity } from '../db/pendingResourceIdentityRepo'
import { beginLibraryScanRun } from '../db/libraryScanRepo'
import { createScanAuditWriter, type ScanAuditMetadata } from '../db/scanAuditWriter'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import type { LocalNfoScanService } from '../services/localNfoScanService'
import { scanFolders, statFileFingerprint, ScanFoldersFailure, type ScanOptions } from './scanner'

let directory:string, media:string, sequence=0
let previousUserData:string|undefined
beforeEach(()=>{
  previousUserData=process.env.JAVDEX_TEST_USER_DATA
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-scanner-sink-'))
  media=path.join(directory,'media');fs.mkdirSync(media)
  process.env.JAVDEX_TEST_USER_DATA=directory
})
afterEach(()=>{
  closeDatabase();resetSettingsCacheForTests()
  if(previousUserData===undefined)delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA=previousUserData
  fs.rmSync(directory,{recursive:true,force:true})
})

function setup(names:string[]) {
  closeDatabase();resetSettingsCacheForTests()
  for(const name of names)fs.writeFileSync(path.join(media,name),'synthetic video')
  const db=initDatabaseAtPath(path.join(directory,`catalog-${++sequence}.db`))
  const library=createMediaLibrary({name:'Sink',roots:[{path:media}]})
  const request={libraryId:library.id,runId:'scan',roots:library.roots}
  beginLibraryScanRun({...request,configRevision:1,trigger:'manual',startedAt:'start'})
  const meta:ScanAuditMetadata={schemaVersion:2,libraryId:library.id,runId:'scan',configRevision:1,trigger:'manual',startedAt:'start',finishedAt:'pending',status:'success'}
  const writer=createScanAuditWriter(db,request)
  const rows=()=>db.prepare("SELECT ordinal,entry_key,entry_json FROM library_scan_audit_entries WHERE run_id='scan' AND section='files' ORDER BY ordinal").all() as {ordinal:number;entry_key:string;entry_json:string}[]
  const sink:NonNullable<ScanOptions['auditSink']>={
    recordFile:entry=>writer.writeBatch('files',[entry]),
    readFileNfo:filePath=>writer.readFileNfo(filePath),
    patchNfo:(filePath,nfo)=>writer.patchNfo(filePath,nfo)
  }
  const options:ScanOptions={yieldEvery:1,minImportDurationSeconds:1,autoMergeSameCodeResources:true,
    readDurationSeconds:async()=>{assert.equal(db.inTransaction,false);return 120},
    readDirectory:async dir=>(await fs.promises.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))}
  return {db,request,meta,writer,rows,sink,options}
}

function nfoService():LocalNfoScanService {
  return {
    inspectIdentity:anchor=>({status:'found',code:path.basename(anchor.anchorPath).replace(/\.[^.]+$/,''),warnings:['preflight warning']}),
    apply:async()=>({disposition:'imported',warnings:['apply warning']})
  }
}

it('matches final legacy callbacks on equivalent fresh catalogs including merged NFO and repeated paths',async()=>{
  const names=['SINK-001.mp4','SINK-002.mp4','unknown.mp4']
  const legacy=setup(names),expected:LibraryScanFileAuditEntry[]=[]
  const withDuplicate=(base:NonNullable<ScanOptions['readDirectory']>)=>async(dir:string)=>{
    const items=await base(dir);return [...items,items[0]]
  }
  const oldResult=await scanFolders(legacy.request,undefined,{...legacy.options,readDirectory:withDuplicate(legacy.options.readDirectory!),
    autoImportLocalNfo:true,localNfoService:nfoService(),onFileResult:entry=>expected.push(entry)})
  const current=setup(names);current.writer.start(current.meta)
  let deliveries=0,patches=0
  const newResult=await scanFolders(current.request,undefined,{...current.options,readDirectory:withDuplicate(current.options.readDirectory!),
    autoImportLocalNfo:true,localNfoService:nfoService(),auditSink:{...current.sink,
      recordFile:entry=>{deliveries++;current.sink.recordFile(entry)},
      patchNfo:(file,nfo)=>{patches++;return current.sink.patchNfo(file,nfo)}}})
  const rows=current.rows()
  assert.deepEqual(newResult,oldResult)
  assert.deepEqual(rows.map(row=>JSON.parse(row.entry_json)),expected)
  assert.equal(rows.length,names.length)
  assert.deepEqual(rows.map(row=>row.ordinal),[0,1,2])
  assert.equal(new Set(rows.map(row=>row.entry_key)).size,rows.length)
  assert.ok(deliveries>rows.length,'repeated paths update their original entry rather than append')
  assert.ok(patches>0)
  assert.ok(expected.some(entry=>entry.nfo?.warnings?.some(warning=>warning.message==='preflight warning')&&entry.nfo.warnings.some(warning=>warning.message==='apply warning')))
  const before=deliveries;await new Promise(resolve=>setImmediate(resolve));assert.equal(deliveries,before,'no deferred tail delivery')
})

it('commits singleton audit deliveries while the next duration probe is held, outside a database transaction',async()=>{
  const current=setup(['LIVE-001.mp4','LIVE-002.mp4']);current.writer.start(current.meta)
  let release!:()=>void,entered!:()=>void,calls=0,finished=false
  const gate=new Promise<void>(resolve=>{release=resolve}),waiting=new Promise<void>(resolve=>{entered=resolve})
  const scanning=scanFolders(current.request,undefined,{...current.options,auditSink:current.sink,
    readDurationSeconds:async()=>{assert.equal(current.db.inTransaction,false);if(++calls===2){entered();await gate}return 120}}).then(result=>{finished=true;return result})
  try{
    await Promise.race([waiting,scanning.then(()=>{throw new Error('Scan ended before the second duration probe')})])
    assert.equal(finished,false);assert.equal(current.rows().length,1)
    const reader=openReadOnlyDatabaseAtPath(current.db.name)
    try{assert.equal((reader.prepare("SELECT COUNT(*) AS n FROM library_scan_audit_entries WHERE run_id='scan'").get() as {n:number}).n,1)}finally{reader.close()}
    assert.equal((current.db.prepare("SELECT state FROM library_scan_audit_manifests WHERE run_id='scan'").get() as {state:string}).state,'collecting')
    assert.equal(current.db.inTransaction,false)
  }finally{release();await scanning.catch(()=>{})}
  const result=await scanning
  assert.equal(result.imported,2);assert.equal(current.rows().length,2)
})

it('timer cancellation preserves already committed entries and stops incremental delivery',async()=>{
  const current=setup(Array.from({length:20},(_,i)=>`CANCEL-${String(i+1).padStart(3,'0')}.mp4`));current.writer.start(current.meta)
  const abort=new AbortController();let delivered=0,timer:ReturnType<typeof setTimeout>|undefined
  try{
    const result=await scanFolders(current.request,undefined,{...current.options,signal:abort.signal,auditSink:{...current.sink,
      recordFile:entry=>{current.sink.recordFile(entry);if(++delivered===1)timer=setTimeout(()=>abort.abort(),0)}}})
    assert.equal(result.cancelled,true);assert.ok(delivered>0&&delivered<20)
    assert.equal(current.rows().length,delivered)
    assert.equal(result.scannedFiles,delivered)
    assert.ok(current.rows().every(row=>JSON.parse(row.entry_json).outcome==='added'))
    const before=current.rows();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(current.rows(),before)
  }finally{if(timer)clearTimeout(timer)}
})

it('rejects mutually exclusive sinks before database, directory, probe or callback work',async(t)=>{
  const current=setup(['EXCLUSIVE-001.mp4']);current.writer.start(current.meta)
  let work=0
  const prepare=current.db.prepare
  const spy=t.mock.method(current.db,'prepare',function(sql:string){work++;return prepare.call(current.db,sql)})
  try{
    await assert.rejects(scanFolders(current.request,undefined,{auditSink:current.sink,onFileResult:()=>{work++},
      readDirectory:async()=>{work++;return []},readDurationSeconds:async()=>{work++;return 120}}))
    assert.equal(work,0)
  }finally{spy.mock.restore()}
})

for(const operation of ['recordFile','readFileNfo','patchNfo'] as const)it(`propagates ${operation} sink failure without converting it to processing_failure`,async()=>{
  const current=setup(operation==='recordFile'?['FATAL-001.mp4','FATAL-002.mp4']:['FATAL-001.mp4']);current.writer.start(current.meta)
  const failure=new Error(`fatal ${operation}`);let calls=0,records=0
  const sink:NonNullable<ScanOptions['auditSink']>={...current.sink,recordFile:entry=>{records++;current.sink.recordFile(entry)}}
  if(operation==='recordFile')sink.recordFile=()=>{calls++;throw failure}
  if(operation==='readFileNfo')sink.readFileNfo=()=>{calls++;throw failure}
  if(operation==='patchNfo')sink.patchNfo=()=>{calls++;throw failure}
  await assert.rejects(scanFolders(current.request,undefined,{...current.options,autoImportLocalNfo:true,localNfoService:nfoService(),auditSink:sink}),error=>error instanceof ScanFoldersFailure && error.cause===failure)
  assert.equal(calls,1)
  assert.ok(current.rows().every(row=>JSON.parse(row.entry_json).outcome!=='processing_failure'))
  assert.equal(records,operation==='recordFile'?0:1)
  if(operation==='recordFile')assert.equal((current.db.prepare('SELECT COUNT(*) AS n FROM videos').get() as {n:number}).n,0,'failed first file rolls back and next file is not processed')
})

it('treats a missing NFO patch target after a successful read as fatal',async()=>{
  const current=setup(['PATCH-001.mp4']);current.writer.start(current.meta)
  let reads=0,patches=0
  await assert.rejects(scanFolders(current.request,undefined,{...current.options,autoImportLocalNfo:true,localNfoService:nfoService(),auditSink:{...current.sink,
    readFileNfo:file=>{reads++;const value=current.sink.readFileNfo(file);assert.ok(value);return value},
    patchNfo:()=>{patches++;return false}}}),/Audit anchor disappeared/)
  assert.equal(reads,1);assert.equal(patches,1)
  assert.equal(current.rows().length,1)
  assert.equal(JSON.parse(current.rows()[0].entry_json).outcome,'added')
})

for(const operation of ['recordFile','readFileNfo','patchNfo'] as const)for(const rejected of [false,true])it(`rejects ${operation} ${rejected?'rejected':'resolved'} thenables without late unhandled rejection`,async()=>{
  const current=setup(operation==='recordFile'?['ASYNC-001.mp4','ASYNC-002.mp4']:['ASYNC-001.mp4']);current.writer.start(current.meta)
  let calls=0
  const asyncMethod=()=>{
    calls++
    return rejected?Promise.reject(new Error('async sink rejected')):Promise.resolve(operation==='readFileNfo'?{}:operation==='patchNfo'?true:undefined)
  }
  // Deliberately invalid caller crosses the TypeScript boundary with a thenable.
  const sink={...current.sink,[operation]:asyncMethod} as unknown as NonNullable<ScanOptions['auditSink']>
  await assert.rejects(scanFolders(current.request,undefined,{...current.options,autoImportLocalNfo:true,localNfoService:nfoService(),auditSink:sink}),/synchronous/i)
  assert.equal(calls,1)
  assert.ok(current.rows().every(row=>JSON.parse(row.entry_json).outcome!=='processing_failure'))
  if(operation==='recordFile')assert.equal((current.db.prepare('SELECT COUNT(*) AS n FROM videos').get() as {n:number}).n,0)
  // The node test runner also fails on unhandledRejection; allow rejection observers to run.
  await new Promise(resolve=>setImmediate(resolve))
})

for(const mode of ['target-update','relocation'] as const)it(`atomically rolls back STRM ${mode} on native audit INSERT failure and retries with committed visibility`,async()=>{
  const current=setup(['ATOMIC-001.strm'])
  const oldPath=path.join(media,'ATOMIC-001.strm'),oldTarget='https://example.test/old.mp4'
  fs.writeFileSync(oldPath,oldTarget)
  let progressCalls=0,probeCalls=0
  const progress=()=>{progressCalls++;assert.equal(current.db.inTransaction,false)}
  const options:ScanOptions={...current.options,readDurationSeconds:async()=>{probeCalls++;assert.equal(current.db.inTransaction,false);return 120}}
  const initial=await scanFolders(current.request,progress,options)
  assert.equal(initial.imported,1)
  const resourceSQL='SELECT * FROM video_resources ORDER BY id'
  const before=current.db.prepare(resourceSQL).all()
  assert.equal(before.length,1)
  const resource=before[0] as {id:number;video_id:number;locator:string;strm_source_path:string}
  assert.equal(resource.locator,oldTarget);assert.equal(resource.strm_source_path,oldPath)
  const videosBefore=current.db.prepare('SELECT * FROM videos ORDER BY id').all()
  let newPath=oldPath,newTarget=oldTarget
  if(mode==='target-update'){
    newTarget='https://example.test/new.mp4';fs.writeFileSync(oldPath,newTarget)
  }else{
    const moved=path.join(media,'moved');fs.mkdirSync(moved)
    newPath=path.join(moved,'ATOMIC-001.strm');fs.renameSync(oldPath,newPath)
  }
  current.writer.start(current.meta)
  const independent=openReadOnlyDatabaseAtPath(current.db.name)
  let nativeFaults=0,sinkCalls=0
  // SQL supplies the already-mutated resource to the UDF; no reentrant database query.
  current.db.function('observe_strm_audit_fault',(locator,sourcePath)=>{
    nativeFaults++;assert.equal(locator,newTarget);assert.equal(sourcePath,newPath);return 1
  })
  current.db.exec(`CREATE TEMP TRIGGER fail_strm_audit AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='files' BEGIN
      SELECT observe_strm_audit_fault(
        (SELECT locator FROM video_resources WHERE id=${resource.id}),
        (SELECT strm_source_path FROM video_resources WHERE id=${resource.id}));
      SELECT RAISE(ABORT,'native STRM audit failure');
    END;`)
  const sink:NonNullable<ScanOptions['auditSink']>={...current.sink,recordFile:entry=>{
    sinkCalls++;assert.equal(current.db.inTransaction,true)
    const changed=current.db.prepare('SELECT locator,strm_source_path FROM video_resources WHERE id=?').get(resource.id)
    assert.deepEqual(changed,{locator:newTarget,strm_source_path:newPath})
    assert.deepEqual(independent.prepare(resourceSQL).all(),before,'separate connection sees pre-commit resource')
    assert.equal(entry.outcome,'updated')
    current.sink.recordFile(entry)
  }}
  try{
    await assert.rejects(scanFolders(current.request,progress,{...options,auditSink:sink}),/native STRM audit failure/)
    assert.equal(nativeFaults,1);assert.equal(sinkCalls,1)
    assert.equal(current.db.inTransaction,false)
    assert.deepEqual(current.rows(),[])
    assert.deepEqual(current.db.prepare(resourceSQL).all(),before)
    assert.deepEqual(independent.prepare(resourceSQL).all(),before)
    assert.deepEqual(current.db.prepare('SELECT * FROM videos ORDER BY id').all(),videosBefore)
    current.db.exec('DROP TRIGGER fail_strm_audit')
    const retry=await scanFolders(current.request,progress,{...options,auditSink:sink})
    assert.equal(sinkCalls,2);assert.equal(retry.failed,0)
    assert.equal(retry.refreshed,mode==='target-update'?1:0)
    assert.equal(retry.relocated,mode==='relocation'?1:0)
    const committed=current.db.prepare(resourceSQL).all()
    assert.equal(committed.length,1)
    assert.deepEqual(independent.prepare(resourceSQL).all(),committed,'separate connection sees committed update after scan')
    const updated=committed[0] as typeof resource
    assert.equal(updated.id,resource.id);assert.equal(updated.video_id,resource.video_id)
    assert.equal(updated.locator,newTarget);assert.equal(updated.strm_source_path,newPath)
    const auditRows=current.rows();assert.equal(auditRows.length,1);assert.equal(auditRows[0].ordinal,0)
    const entry=JSON.parse(auditRows[0].entry_json)
    assert.equal(entry.filePath,newPath);assert.equal(entry.resourceId,resource.id);assert.equal(entry.videoId,resource.video_id)
    assert.equal(entry.sourceKind,'strm');assert.equal(entry.outcome,'updated')
    assert.equal(entry.updateKind,mode==='target-update'?'strm_target_synced':'relocated')
    const unchanged=await scanFolders(current.request,progress,{...options,auditSink:current.sink})
    assert.equal(unchanged.skipped,1);assert.equal(unchanged.refreshed,0);assert.equal(unchanged.relocated,0)
    assert.deepEqual(current.db.prepare(resourceSQL).all(),committed)
    assert.equal(current.rows().length,1);assert.equal(current.rows()[0].ordinal,0)
    const skipped=JSON.parse(current.rows()[0].entry_json)
    assert.equal(skipped.outcome,'skipped');assert.equal(skipped.skipReason,'unchanged');assert.equal(skipped.filePath,newPath)
    assert.ok(progressCalls>0)
    assert.equal(probeCalls,0,'these remote STRM branches do not invoke duration probes; local probe boundary is covered above')
    assert.deepEqual(current.db.pragma('foreign_key_check'),[])
  }finally{independent.close()}
})

it('rolls back invalid STRM pending deletion on native audit failure and retries with one committed failure',async()=>{
  const current=setup(['INVALID-001.strm']),file=path.join(media,'INVALID-001.strm')
  // setup's non-URL text is deliberately an invalid STRM, with a previously valid queued target.
  upsertPendingScanResources(current.request.libraryId,'INVALID-001',[{
    rootId:current.request.roots[0].id,filePath:file,sourceKind:'strm',targetKind:'direct',
    targetLocator:'https://example.test/queued.mp4',targetKey:'direct:https://example.test/queued.mp4',sizeBytes:null,durationSeconds:null,fileMtimeMs:null
  }])
  const pending=()=>({
    resources:current.db.prepare('SELECT * FROM pending_scan_resources ORDER BY id').all(),
    groups:current.db.prepare('SELECT * FROM pending_scan_groups ORDER BY id').all()
  })
  const before=pending();assert.equal(before.resources.length,1);assert.equal(before.groups.length,1)
  current.writer.start(current.meta)
  const independent=openReadOnlyDatabaseAtPath(current.db.name)
  let faultCalls=0,sinkCalls=0,reportedFiles=0
  current.db.function('observe_pending_audit_fault',(remaining)=>{faultCalls++;assert.equal(remaining,0);return 1})
  current.db.exec(`CREATE TEMP TRIGGER fail_pending_audit AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='files' BEGIN
      SELECT observe_pending_audit_fault((SELECT COUNT(*) FROM pending_scan_resources));
      SELECT RAISE(ABORT,'pending audit INSERT failed');
    END;`)
  const sink:NonNullable<ScanOptions['auditSink']>={...current.sink,recordFile:entry=>{
    sinkCalls++;assert.equal(current.db.inTransaction,true);assert.equal(pending().resources.length,0)
    assert.deepEqual(independent.prepare('SELECT * FROM pending_scan_resources ORDER BY id').all(),before.resources)
    assert.deepEqual(independent.prepare('SELECT * FROM pending_scan_groups ORDER BY id').all(),before.groups)
    assert.equal(entry.outcome,'strm_failure');current.sink.recordFile(entry)
  }}
  const progress:Parameters<typeof scanFolders>[1]=value=>{
    assert.equal(current.db.inTransaction,false)
    if(value.currentFile===file)reportedFiles++
  }
  try{
    await assert.rejects(scanFolders(current.request,progress,{...current.options,auditSink:sink}),/pending audit INSERT failed/)
    assert.equal(faultCalls,1);assert.equal(sinkCalls,1);assert.equal(reportedFiles,0,'failed audit commit cannot report a completed file')
    assert.deepEqual(pending(),before);assert.deepEqual(current.rows(),[]);assert.equal(current.db.inTransaction,false)
    current.db.exec('DROP TRIGGER fail_pending_audit')
    const retry=await scanFolders(current.request,progress,{...current.options,auditSink:sink})
    assert.equal(retry.failed,1);assert.equal(retry.strmFailures.length,1);assert.equal(retry.scannedFiles,1)
    assert.equal(reportedFiles,1);assert.equal(sinkCalls,2)
    assert.equal(pending().resources.length,0);assert.equal(pending().groups.length,0)
    assert.deepEqual(independent.prepare('SELECT * FROM pending_scan_resources').all(),[])
    assert.deepEqual(independent.prepare('SELECT * FROM pending_scan_groups').all(),[])
    assert.equal(current.rows().length,1)
    const entry=JSON.parse(current.rows()[0].entry_json)
    assert.equal(entry.filePath,file);assert.equal(entry.outcome,'strm_failure');assert.ok(entry.failureCode)
    assert.deepEqual(current.db.pragma('foreign_key_check'),[])
  }finally{independent.close()}
})

for(const sourceKind of ['local','strm'] as const)for(const mode of ['new-video','existing-video','must-confirm','relocation'] as const){
if(sourceKind==='strm'&&mode==='relocation')continue // Covered by the existing STRM relocation test.
it(`rolls back ${sourceKind} ${mode} business rows with native audit failure and retries atomically`,async()=>{
  const name=`LOCAL-001.${sourceKind==='local'?'mp4':'strm'}`
  const current=setup([name]),oldFile=path.join(media,name)
  if(sourceKind==='strm')fs.writeFileSync(oldFile,'https://example.test/initial.mp4')
  if(mode!=='new-video'){
    const initial=await scanFolders(current.request,undefined,current.options)
    assert.equal(initial.imported,1)
  }
  let file=oldFile
  if(mode!=='new-video'){
    const extra=path.join(media,'extra');fs.mkdirSync(extra);file=path.join(extra,name)
    if(mode==='relocation')fs.renameSync(oldFile,file)
    else fs.writeFileSync(file,sourceKind==='strm'?'https://example.test/additional.mp4':'second synthetic video')
  }
  const snapshot=(connection:typeof current.db)=>({
    videos:connection.prepare('SELECT * FROM videos ORDER BY id').all(),
    resources:connection.prepare('SELECT * FROM video_resources ORDER BY id').all(),
    memberships:connection.prepare('SELECT * FROM library_video_memberships ORDER BY library_id,video_id').all(),
    groups:connection.prepare('SELECT * FROM pending_scan_groups ORDER BY id').all(),
    pending:connection.prepare('SELECT * FROM pending_scan_resources ORDER BY id').all()
  })
  const before=snapshot(current.db)
  current.writer.start(current.meta)
  const reader=openReadOnlyDatabaseAtPath(current.db.name)
  let faultCalls=0,sinkCalls=0,probes=0,reports=0,nfoApplies=0
  current.db.function('observe_local_insert',()=>{faultCalls++;return 1})
  current.db.exec(`CREATE TEMP TRIGGER fail_local_audit AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='files' BEGIN SELECT observe_local_insert();SELECT RAISE(ABORT,'local audit INSERT failed');END;`)
  const options:ScanOptions={...current.options,autoMergeSameCodeResources:mode!=='must-confirm',autoImportLocalNfo:true,
    localNfoService:{...nfoService(),apply:async()=>{nfoApplies++;return {disposition:'imported',warnings:[]}}},
    readDirectory:async dir=>(await current.options.readDirectory!(dir)).filter(entry=>entry.isDirectory()||path.join(dir,entry.name)===file),
    readDurationSeconds:async()=>{probes++;assert.equal(current.db.inTransaction,false);return 120},
    auditSink:{...current.sink,recordFile:entry=>{
      sinkCalls++;assert.equal(current.db.inTransaction,true)
      const changed=snapshot(current.db)
      if(mode==='must-confirm'){
        assert.equal(changed.groups.length,before.groups.length+1);assert.equal(changed.pending.length,before.pending.length+1)
        assert.equal(entry.outcome,'pending')
      }else{
        assert.notDeepEqual(changed.resources,before.resources)
        assert.equal(changed.resources.length,before.resources.length+(mode==='relocation'?0:1))
        assert.equal(changed.videos.length,before.videos.length+(mode==='new-video'?1:0))
        assert.equal(changed.memberships.length,before.memberships.length+(mode==='new-video'?1:0))
        assert.equal(entry.outcome,mode==='relocation'?'updated':'added')
      }
      assert.deepEqual(snapshot(reader),before,'uncommitted business rows stay invisible to independent reader')
      current.sink.recordFile(entry)
    }}}
  const progress:Parameters<typeof scanFolders>[1]=value=>{assert.equal(current.db.inTransaction,false);if(value.currentFile===file)reports++}
  try{
    await assert.rejects(scanFolders(current.request,progress,options),/local audit INSERT failed/)
    assert.equal(faultCalls,1);assert.equal(sinkCalls,1);assert.equal(reports,0);assert.equal(nfoApplies,0)
    assert.deepEqual(snapshot(current.db),before);assert.deepEqual(snapshot(reader),before);assert.deepEqual(current.rows(),[])
    assert.equal(current.db.inTransaction,false)
    current.db.exec('DROP TRIGGER fail_local_audit')
    const retry=await scanFolders(current.request,progress,options)
    assert.equal(sinkCalls,2);assert.equal(retry.failed,0);assert.equal(retry.scannedFiles,1)
    assert.equal(retry.imported,mode==='new-video'||mode==='existing-video'?1:0)
    assert.equal(retry.relocated,mode==='relocation'?1:0)
    assert.equal(retry.pendingResources,mode==='must-confirm'?1:0)
    assert.equal(retry.pendingGroups,mode==='must-confirm'?1:0)
    assert.equal(nfoApplies,mode==='new-video'||mode==='existing-video'?1:0)
    if(sourceKind==='local')assert.ok(probes>=2)
    else assert.equal(probes,0)
    assert.equal(reports,1)
    const committed=snapshot(current.db);assert.deepEqual(snapshot(reader),committed)
    assert.equal(current.rows().length,1);assert.equal(current.rows()[0].ordinal,0)
    const entry=JSON.parse(current.rows()[0].entry_json)
    assert.equal(entry.filePath,file)
    if(mode==='must-confirm'){
      const pending=committed.pending[0] as {group_id:number;file_path:string}
      assert.equal(entry.groupId,pending.group_id);assert.equal(pending.file_path,file)
      assert.deepEqual(committed.videos,before.videos);assert.deepEqual(committed.resources,before.resources);assert.deepEqual(committed.memberships,before.memberships)
    }else{
      const resource=current.db.prepare(`SELECT id,video_id FROM video_resources WHERE ${sourceKind==='local'?'locator':'strm_source_path'}=?`).get(file) as {id:number;video_id:number}
      assert.equal(entry.resourceId,resource.id);assert.equal(entry.videoId,resource.video_id)
      if(mode==='relocation')assert.equal(entry.updateKind,'relocated')
      else assert.equal(entry.createdVideo,mode==='new-video')
      assert.deepEqual(committed.groups,before.groups);assert.deepEqual(committed.pending,before.pending)
    }
    assert.deepEqual(current.db.pragma('foreign_key_check'),[])
  }finally{reader.close()}
})
}

for(const kind of ['local','strm'] as const)for(const mode of ['identity-create','identity-refresh','pending-refresh'] as const)it(`rolls back ${kind} ${mode} on native audit failure and commits retry with matching pending state`,async()=>{
  const name=`IDENT-001.${kind==='local'?'mp4':'strm'}`,current=setup([name]),file=path.join(media,name)
  const oldTarget='https://example.test/old.mp4',newTarget='https://example.test/changed-longer.mp4'
  const target=kind==='strm'?{targetKind:'direct' as const,targetLocator:oldTarget,targetKey:`direct:${oldTarget}`} : {}
  fs.writeFileSync(file,kind==='strm'?oldTarget:'old')
  fs.utimesSync(file,1000,1000)
  const original=fs.statSync(file)
  if(mode==='identity-refresh')upsertPendingResourceIdentity({
    libraryId:current.request.libraryId,rootId:current.request.roots[0].id,filePath:file,sourceKind:kind,
    filenameCode:'IDENT-001',nfoCode:'OTHER-999',sizeBytes:original.size,fileMtimeMs:original.mtimeMs,...target
  })
  if(mode==='pending-refresh')upsertPendingScanResources(current.request.libraryId,'IDENT-001',[{
    rootId:current.request.roots[0].id,filePath:file,sourceKind:kind,
    sizeBytes:original.size,fileMtimeMs:original.mtimeMs,durationSeconds:10,...target
  }])
  const snapshot=(connection:typeof current.db)=>({
    identities:connection.prepare('SELECT * FROM pending_resource_identities ORDER BY id').all() as Record<string,unknown>[],
    groups:connection.prepare('SELECT * FROM pending_scan_groups ORDER BY id').all() as Record<string,unknown>[],
    pending:connection.prepare('SELECT * FROM pending_scan_resources ORDER BY id').all() as Record<string,unknown>[],
    videos:connection.prepare('SELECT * FROM videos ORDER BY id').all(),
    resources:connection.prepare('SELECT * FROM video_resources ORDER BY id').all(),
    memberships:connection.prepare('SELECT * FROM library_video_memberships ORDER BY library_id,video_id').all()
  })
  const before=snapshot(current.db)
  fs.writeFileSync(file,kind==='strm'?newTarget:'new larger synthetic local content')
  fs.utimesSync(file,2000,2000)
  const fingerprint=fs.statSync(file)
  assert.notEqual(fingerprint.size,original.size);assert.notEqual(fingerprint.mtimeMs,original.mtimeMs)
  current.writer.start(current.meta)
  const reader=openReadOnlyDatabaseAtPath(current.db.name)
  let faults=0,calls=0,probes=0,reports=0,applies=0
  const changedState=(state:ReturnType<typeof snapshot>)=>{
    if(mode==='pending-refresh'){
      assert.equal(state.pending.length,1)
      assert.equal(state.pending[0].id,before.pending[0].id)
      assert.notDeepEqual(state.pending,before.pending)
      assert.ok(Number(state.groups[0].revision)>Number(before.groups[0].revision))
      if(kind==='local'){
        assert.equal(state.pending[0].duration_seconds,180)
        assert.equal(state.pending[0].size_bytes,fingerprint.size)
        assert.equal(state.pending[0].file_mtime_ms,fingerprint.mtimeMs)
      }else assert.equal(state.pending[0].target_locator,newTarget)
    }else{
      assert.equal(state.identities.length,1)
      const identity=state.identities[0]
      assert.equal(identity.filename_code,'IDENT-001');assert.equal(identity.nfo_code,'OTHER-999')
      assert.equal(identity.size_bytes,fingerprint.size);assert.equal(identity.file_mtime_ms,fingerprint.mtimeMs)
      if(kind==='strm')assert.equal(identity.target_locator,newTarget)
      if(mode==='identity-refresh'){
        assert.equal(identity.id,before.identities[0].id)
        assert.equal(identity.revision,Number(before.identities[0].revision)+1)
      }else assert.equal(identity.revision,1)
    }
  }
  current.db.function('observe_pending_native_fault',()=>{faults++;return 1})
  current.db.exec(`CREATE TEMP TRIGGER fail_pending_revision AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='files' BEGIN SELECT observe_pending_native_fault();SELECT RAISE(ABORT,'pending revision audit fault');END;`)
  const options:ScanOptions={...current.options,autoImportLocalNfo:mode==='identity-create',
    localNfoService:{inspectIdentity:()=>({status:'found',code:'OTHER-999',warnings:[]}),apply:async()=>{applies++;return {disposition:'none',warnings:[]}}},
    readDurationSeconds:async()=>{probes++;assert.equal(current.db.inTransaction,false);return 180},
    auditSink:{...current.sink,recordFile:entry=>{
      calls++;assert.equal(current.db.inTransaction,true)
      changedState(snapshot(current.db));assert.deepEqual(snapshot(reader),before)
      assert.equal(entry.filePath,file);assert.equal(entry.outcome,'pending')
      current.sink.recordFile(entry)
    }}}
  const progress:Parameters<typeof scanFolders>[1]=value=>{assert.equal(current.db.inTransaction,false);if(value.currentFile===file)reports++}
  try{
    await assert.rejects(scanFolders(current.request,progress,options),/pending revision audit fault/)
    assert.equal(faults,1);assert.equal(calls,1);assert.equal(reports,0);assert.equal(applies,0)
    assert.deepEqual(snapshot(current.db),before);assert.deepEqual(snapshot(reader),before);assert.deepEqual(current.rows(),[])
    assert.equal(current.db.inTransaction,false)
    current.db.exec('DROP TRIGGER fail_pending_revision')
    const result=await scanFolders(current.request,progress,options)
    assert.equal(calls,2);assert.equal(reports,1);assert.equal(result.failed,0);assert.equal(result.scannedFiles,1)
    assert.equal(result.imported,0);assert.equal(result.pendingResources,mode==='identity-create'?1:0)
    assert.equal(result.pendingGroups,mode==='pending-refresh'?1:0);assert.equal(applies,0)
    const committed=snapshot(current.db);changedState(committed);assert.deepEqual(snapshot(reader),committed)
    assert.deepEqual(committed.videos,before.videos);assert.deepEqual(committed.resources,before.resources);assert.deepEqual(committed.memberships,before.memberships)
    assert.equal(current.rows().length,1);assert.equal(current.rows()[0].ordinal,0)
    const entry=JSON.parse(current.rows()[0].entry_json)
    assert.equal(entry.filePath,file);assert.equal(entry.sourceKind,kind);assert.equal(entry.outcome,'pending')
    assert.equal(entry.addedToQueue,mode==='identity-create')
    if(mode==='pending-refresh')assert.equal(entry.groupId,committed.groups[0].id)
    else {
      assert.equal(entry.nfo.disposition,'identity-conflict')
      if(mode==='identity-create')assert.equal(entry.nfo.pendingIdentityId,committed.identities[0].id)
    }
    if(kind==='local'&&mode!=='identity-refresh')assert.ok(probes>=2)
    else assert.equal(probes,0,'this path has no duration await; not evidence of a probe having run')
    assert.deepEqual(current.db.pragma('foreign_key_check'),[])
  }finally{reader.close()}
})

for(const mode of ['fingerprint-backfill','changed-fingerprint'] as const)it(`rolls back registered local ${mode} on audit failure, retries and leaves skipped probes unchanged`,async()=>{
  const current=setup(['RFSH-001.mp4']),file=path.join(media,'RFSH-001.mp4')
  assert.equal((await scanFolders(current.request,undefined,current.options)).imported,1)
  if(mode==='fingerprint-backfill')current.db.prepare("UPDATE video_resources SET file_mtime_ms=NULL WHERE kind='local'").run()
  else {fs.appendFileSync(file,' changed fingerprint');fs.utimesSync(file,3000,3000)}
  const fingerprint=fs.statSync(file)
  const normalizedFingerprint=statFileFingerprint(file)
  assert.ok(normalizedFingerprint)
  assert.equal(normalizedFingerprint.file_mtime_ms,Math.round(fingerprint.mtimeMs))
  const snapshot=(connection:typeof current.db)=>({resources:connection.prepare('SELECT * FROM video_resources ORDER BY id').all(),videos:connection.prepare('SELECT * FROM videos ORDER BY id').all()})
  const before=snapshot(current.db)
  current.writer.start(current.meta)
  const reader=openReadOnlyDatabaseAtPath(current.db.name)
  let faults=0,calls=0,probes=0,reports=0
  current.db.function('observe_refresh_audit',()=>{faults++;return 1})
  current.db.exec(`CREATE TEMP TRIGGER fail_refresh_audit AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='files' BEGIN SELECT observe_refresh_audit();SELECT RAISE(ABORT,'refresh audit fault');END;`)
  const options:ScanOptions={...current.options,
    readDurationSeconds:async()=>{probes++;assert.equal(current.db.inTransaction,false);return 240},
    auditSink:{...current.sink,recordFile:entry=>{
      calls++;assert.equal(current.db.inTransaction,true)
      assert.notDeepEqual(snapshot(current.db).resources,before.resources)
      assert.deepEqual(snapshot(reader),before)
      assert.equal(entry.outcome,'updated');current.sink.recordFile(entry)
    }}}
  const progress:Parameters<typeof scanFolders>[1]=value=>{assert.equal(current.db.inTransaction,false);if(value.currentFile===file)reports++}
  try{
    await assert.rejects(scanFolders(current.request,progress,options),/refresh audit fault/)
    assert.equal(faults,1);assert.equal(calls,1);assert.equal(reports,0)
    assert.deepEqual(snapshot(current.db),before);assert.deepEqual(snapshot(reader),before);assert.deepEqual(current.rows(),[])
    current.db.exec('DROP TRIGGER fail_refresh_audit')
    const result=await scanFolders(current.request,progress,options)
    assert.equal(result.refreshed,1);assert.equal(result.failed,0);assert.equal(calls,2);assert.equal(reports,1)
    assert.equal(probes,mode==='changed-fingerprint'?2:0)
    const committed=snapshot(current.db);assert.deepEqual(snapshot(reader),committed)
    const resource=committed.resources[0] as {id:number;duration_seconds:number;size_bytes:number;file_mtime_ms:number}
    assert.equal(resource.size_bytes,normalizedFingerprint.file_size);assert.equal(resource.file_mtime_ms,normalizedFingerprint.file_mtime_ms)
    assert.equal(resource.duration_seconds,mode==='changed-fingerprint'?240:120)
    assert.equal(current.rows().length,1)
    const updated=JSON.parse(current.rows()[0].entry_json)
    assert.equal(updated.resourceId,resource.id);assert.equal(updated.updateKind,'metadata_refreshed')
    const unchanged=await scanFolders(current.request,progress,{...options,auditSink:current.sink,
      readDurationSeconds:async()=>{assert.fail('unchanged fingerprint must not probe');return null}})
    assert.equal(unchanged.skipped,1);assert.equal(unchanged.refreshed,0);assert.deepEqual(snapshot(current.db),committed)
    fs.appendFileSync(file,' invalid duration fingerprint')
    let invalidProbes=0
    const invalid=await scanFolders(current.request,progress,{...options,auditSink:current.sink,
      readDurationSeconds:async()=>{invalidProbes++;assert.equal(current.db.inTransaction,false);return null}})
    assert.equal(invalidProbes,1);assert.equal(invalid.skipped,1);assert.equal(invalid.refreshed,0)
    assert.deepEqual(snapshot(current.db),committed);assert.deepEqual(snapshot(reader),committed)
    const skipped=JSON.parse(current.rows()[0].entry_json)
    assert.equal(skipped.outcome,'skipped');assert.equal(skipped.skipReason,'unchanged');assert.equal(skipped.resourceId,resource.id)
    assert.deepEqual(current.db.pragma('foreign_key_check'),[])
  }finally{reader.close()}
})

it('rechecks root authorization after an awaited registered-resource probe before writing business fields',async()=>{
  const current=setup(['AUTH-001.mp4']),file=path.join(media,'AUTH-001.mp4')
  await scanFolders(current.request,undefined,current.options)
  const before=current.db.prepare('SELECT * FROM video_resources ORDER BY id').all()
  fs.appendFileSync(file,' changed')
  current.writer.start(current.meta)
  let release!:()=>void,entered!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve}),waiting=new Promise<void>(resolve=>{entered=resolve})
  const scanning=scanFolders(current.request,undefined,{...current.options,auditSink:current.sink,
    readDurationSeconds:async()=>{assert.equal(current.db.inTransaction,false);entered();await gate;return 300}})
  try{
    await Promise.race([waiting,scanning.then(()=>{throw new Error('Scan completed before authorization probe gate')})])
    current.db.prepare("UPDATE media_library_roots SET state='disabled' WHERE id=?").run(current.request.roots[0].id)
  }finally{release();await scanning.catch(()=>{})}
  const result=await scanning
  assert.equal(result.failed,1);assert.equal(result.refreshed,0)
  assert.deepEqual(current.db.prepare('SELECT * FROM video_resources ORDER BY id').all(),before)
  assert.equal(current.rows().length,1)
  assert.equal(JSON.parse(current.rows()[0].entry_json).outcome,'processing_failure')
})

for(const variant of ['fault','unchanged','postcommit-warnings'] as const)it(`NFO transaction callback ${variant}`,async()=>{
  const injectFault=variant==='fault',postcommitWarnings=variant==='postcommit-warnings'
  const current=setup(['NFO-200-CD1.mp4','NFO-200-CD2.mp4']);current.writer.start(current.meta)
  const reader=openReadOnlyDatabaseAtPath(current.db.name)
  let originalTitle:unknown,videoId:number|undefined,applyCalls=0,callbackCalls=0
  let beforeAnchors:ReturnType<typeof current.rows>=[]
  let retryBatch:(()=>void)|undefined
  let observedFault:unknown[]|undefined
  let auditUpdates=0
  current.db.function('count_nfo_revision',()=>{auditUpdates++;return 1})
  current.db.exec(`CREATE TEMP TRIGGER count_nfo_updates AFTER UPDATE OF entry_json ON library_scan_audit_entries
    WHEN NEW.section='files' BEGIN SELECT count_nfo_revision();END;`)
  current.db.function('observe_nfo_update',(title,earlierDisposition)=>{observedFault=[title,earlierDisposition];return 1})
  if(injectFault)current.db.exec(`CREATE TEMP TRIGGER fail_nfo_update AFTER UPDATE OF entry_json ON library_scan_audit_entries
    WHEN NEW.section='files' AND NEW.ordinal=1 BEGIN
      SELECT observe_nfo_update(
        (SELECT title FROM videos LIMIT 1),
        (SELECT json_extract(entry_json,'$.nfo.disposition') FROM library_scan_audit_entries WHERE run_id=NEW.run_id AND section='files' AND ordinal=0));
      SELECT RAISE(ABORT,'native NFO audit UPDATE failure');
    END;`)
  const service:LocalNfoScanService={
    inspectIdentity:()=>({status:'found',code:'NFO-200',warnings:['preflight warning']}),
    apply:async(id,code,anchors,onApplied)=>{
      applyCalls++;videoId=id;assert.equal(code,'NFO-200');assert.equal(anchors.length,2);assert.ok(onApplied)
      assert.equal(current.db.inTransaction,false)
      originalTitle=(current.db.prepare('SELECT title FROM videos WHERE id=?').get(id) as {title:unknown}).title
      beforeAnchors=current.rows();assert.equal(beforeAnchors.length,2)
      const committed={disposition:'imported' as const,warnings:['commit warning']}
      retryBatch=()=>current.db.transaction(()=>{
        current.db.prepare('UPDATE videos SET title=? WHERE id=?').run('NFO business committed',id)
        assert.equal((reader.prepare('SELECT title FROM videos WHERE id=?').get(id) as {title:unknown}).title,originalTitle)
        assert.equal(current.db.inTransaction,true)
        callbackCalls++;onApplied(committed)
      })()
      retryBatch()
      // Deliberately additional warning after the transaction, like asset cleanup diagnostics.
      return postcommitWarnings?{...committed,warnings:[...committed.warnings,'postcommit warning']}:committed
    }
  }
  try{
    const scan=scanFolders(current.request,undefined,{...current.options,autoImportLocalNfo:true,localNfoService:service,auditSink:current.sink})
    if(injectFault){
      await assert.rejects(scan,/native NFO audit UPDATE failure/)
      assert.deepEqual(observedFault,['NFO business committed','imported'],'business and first anchor updated before second anchor fails')
      assert.equal(callbackCalls,1);assert.equal(current.db.inTransaction,false)
      assert.equal((current.db.prepare('SELECT title FROM videos WHERE id=?').get(videoId!) as {title:unknown}).title,originalTitle)
      assert.deepEqual(current.rows(),beforeAnchors,'all anchor revisions, bytes and ordinals roll back together')
      assert.ok(current.rows().every(row=>JSON.parse(row.entry_json).nfo.warnings.every((warning:{message:string})=>warning.message==='preflight warning')))
      current.db.exec('DROP TRIGGER fail_nfo_update')
      assert.ok(retryBatch);retryBatch()
      assert.equal(callbackCalls,2)
      // Retry the exact captured NFO write transaction/callback, not an entire rediscovery scan.
    }else{
      const result=await scan
      assert.equal(result.imported,2);assert.equal(result.failed,0);assert.equal(callbackCalls,1)
      assert.equal(auditUpdates,postcommitWarnings?4:2,'one actual UPDATE per anchor unless returned warnings changed')
    }
    assert.equal(applyCalls,1)
    assert.equal((reader.prepare('SELECT title FROM videos WHERE id=?').get(videoId!) as {title:string}).title,'NFO business committed')
    const after=current.rows()
    assert.deepEqual(after.map(row=>({ordinal:row.ordinal,key:row.entry_key})),beforeAnchors.map(row=>({ordinal:row.ordinal,key:row.entry_key})))
    for(const [index,row] of after.entries()){
      const entry=JSON.parse(row.entry_json),before=JSON.parse(beforeAnchors[index].entry_json)
      assert.equal(entry.videoId,before.videoId);assert.equal(entry.resourceId,before.resourceId)
      assert.equal(entry.nfo.disposition,'imported')
      const warnings=entry.nfo.warnings.map((warning:{message:string})=>warning.message)
      assert.ok(warnings.includes('preflight warning'));assert.ok(warnings.includes('commit warning'))
      assert.equal(warnings.includes('postcommit warning'),postcommitWarnings)
    }
    assert.deepEqual(current.db.pragma('foreign_key_check'),[])
  }finally{reader.close()}
})

it('links real local NFO parsing and business apply to scanner audit rollback, then retries the captured NFO transaction',async(t)=>{
  const current=setup(['REAL-001.mp4'])
  fs.writeFileSync(path.join(media,'REAL-001.nfo'),'<movie><num>REAL-001</num><title>Actual built-in NFO title</title></movie>')
  current.writer.start(current.meta)
  const {localNfoScanService}=await import('../services/localNfoScanService')
  const apply=localNfoScanService.apply.bind(localNfoScanService)
  let retry:(()=>ReturnType<typeof apply>)|undefined
  let originalVideo:{id:number;title:string|null;scraped_status:number}|undefined
  let originalAudit:ReturnType<typeof current.rows>=[]
  let committedAttempt:unknown[]|undefined
  // Capture only the call for retry; both inspection and apply use the real built-in service.
  const spy=t.mock.method(localNfoScanService,'apply',(...args:Parameters<typeof apply>)=>{
    assert.ok(args[3],'real scanner must provide its transaction callback')
    originalVideo=current.db.prepare('SELECT id,title,scraped_status FROM videos WHERE id=?').get(args[0]) as typeof originalVideo
    originalAudit=current.rows()
    retry=()=>apply(...args)
    return apply(...args)
  })
  current.db.function('observe_builtin_nfo',(title,scraped)=>{committedAttempt=[title,scraped];return 1})
  current.db.exec(`CREATE TEMP TRIGGER fail_builtin_nfo AFTER UPDATE OF entry_json ON library_scan_audit_entries
    WHEN NEW.section='files' BEGIN
      SELECT observe_builtin_nfo((SELECT title FROM videos WHERE code='REAL-001'),(SELECT scraped_status FROM videos WHERE code='REAL-001'));
      SELECT RAISE(ABORT,'built-in NFO audit failure');
    END;`)
  try{
    await assert.rejects(scanFolders(current.request,undefined,{...current.options,autoImportLocalNfo:true,auditSink:current.sink}),/built-in NFO audit failure/)
    assert.deepEqual(committedAttempt,['Actual built-in NFO title',1])
    assert.ok(originalVideo);assert.equal(originalVideo.scraped_status,0)
    assert.deepEqual(current.db.prepare('SELECT id,title,scraped_status FROM videos WHERE id=?').get(originalVideo.id),originalVideo)
    assert.equal(originalAudit.length,1)
    assert.deepEqual(current.rows(),originalAudit,'failed apply leaves the complete original discovery/preflight audit intact')
    assert.equal(JSON.parse(current.rows()[0].entry_json).outcome,'added')
    assert.equal(current.db.inTransaction,false)
    current.db.exec('DROP TRIGGER fail_builtin_nfo')
    spy.mock.restore()
    assert.ok(retry)
    // Rediscovery of an already registered resource does not requeue NFO. Retry the
    // actual service call with the scanner's captured callback, not a full scan restart.
    const result=await retry()
    assert.equal(result.disposition,'imported')
    assert.deepEqual(current.db.prepare('SELECT id,title,scraped_status FROM videos WHERE id=?').get(originalVideo.id),
      {id:originalVideo.id,title:'Actual built-in NFO title',scraped_status:1})
    const after=current.rows();assert.equal(after.length,1)
    assert.equal(after[0].ordinal,originalAudit[0].ordinal);assert.equal(after[0].entry_key,originalAudit[0].entry_key)
    const entry=JSON.parse(after[0].entry_json)
    assert.equal(entry.videoId,originalVideo.id);assert.equal(entry.nfo.disposition,'imported')
    assert.deepEqual(current.db.pragma('foreign_key_check'),[])
  }finally{spy.mock.restore()}
})


it('transfers stopped partial counts including pending groups when a later NFO audit fails', async () => {
  const current = setup(['GROUP-001-CD1.mp4', 'GROUP-001-CD2.mp4', 'TAIL-002.mp4'])
  current.writer.start(current.meta)
  const failure = new Error('late NFO audit failure')
  await assert.rejects(scanFolders(current.request, undefined, {
    ...current.options, autoMergeSameCodeResources: false, autoImportLocalNfo: true,
    localNfoService: {
      inspectIdentity: (anchor) => path.basename(anchor.anchorPath).startsWith('TAIL-')
        ? { status: 'found', code: 'TAIL-002', warnings: [] }
        : { status: 'missing', code: null, warnings: [] },
      apply: async () => ({ disposition: 'imported', warnings: [] })
    },
    auditSink: { ...current.sink, patchNfo: () => { throw failure } }
  }), (error) => {
    assert.ok(error instanceof ScanFoldersFailure)
    assert.equal(error.cause, failure)
    assert.equal(error.partialResult.libraryId, current.request.libraryId)
    assert.equal(error.partialResult.runId, current.request.runId)
    assert.equal(error.partialResult.imported, 1)
    assert.equal(error.partialResult.pendingGroups, 1)
    assert.equal(error.partialResult.pendingResources, 2)
    assert.equal(error.partialResult.failed, 0)
    assert.equal(error.partialResult.scannedFiles, 3)
    assert.equal(current.db.inTransaction, false)
    return true
  })
  assert.equal(current.rows().length, 3)
})

it('does not rebuild the STRM relocation index for every audit-only write in a mixed scan', async (t) => {
  const names = Array.from({ length: 20 }, (_, index) => `${String.fromCharCode(97 + index)}.${index % 2 ? 'mp4' : 'strm'}`)
  const current = setup(names)
  for (const name of names.filter((name) => name.endsWith('.strm'))) {
    fs.writeFileSync(path.join(media, name), `https://example.test/${name}.mp4`)
  }
  current.writer.start(current.meta)
  const prepare = current.db.prepare
  let rebuilds = 0
  const spy = t.mock.method(current.db, 'prepare', function (sql: string) {
    if (sql.includes('strm_source_path AS source_path') && sql.includes('ORDER BY id')) rebuilds++
    return prepare.call(current.db, sql)
  })
  try {
    const result = await scanFolders(current.request, undefined, { ...current.options, auditSink: current.sink, resultMode: 'detailed' })
    assert.equal(result.unrecognizedFiles.length, names.length)
    assert.equal(current.rows().length, names.length)
    assert.equal(rebuilds, 1, 'audit-only writes must not force a full resource-index rebuild')
  } finally { spy.mock.restore() }
})
