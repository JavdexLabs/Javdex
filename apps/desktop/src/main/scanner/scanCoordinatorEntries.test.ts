import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LibraryScanAudit, LibraryScanEvent } from '@shared/libraryTypes'
import { initDatabaseAtPath, closeDatabase } from '../db/database'
import { createMediaLibrary } from '../db/mediaLibraryRepo'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { readScanAuditSource } from '../db/scanAuditSource'
import { recoverInterruptedLibraryScanRuns } from '../db/libraryScanRepo'
import { readScanAuditHeader } from '../services/scanAuditReadHeader'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { scanFolders } from './scanner'
import { createScanCoordinator } from './scanCoordinator'

let directory:string,media:string,previousUserData:string|undefined,sequence=0
beforeEach(()=>{
  previousUserData=process.env.JAVDEX_TEST_USER_DATA
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-coordinator-entries-'));media=path.join(directory,'media');fs.mkdirSync(media)
  process.env.JAVDEX_TEST_USER_DATA=directory
})
afterEach(()=>{
  closeDatabase();resetSettingsCacheForTests()
  if(previousUserData===undefined)delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA=previousUserData
  fs.rmSync(directory,{recursive:true,force:true})
})

function setup(storage?:'json',cancelAfterFirst=false,processingFailure=false){
  closeDatabase();resetSettingsCacheForTests()
  const db=initDatabaseAtPath(path.join(directory,`catalog-${++sequence}.db`))
  for(const name of ['AAA-001.mp4','DUP-001-CD1.mp4','DUP-001-CD2.mp4','unknown.mp4'])fs.writeFileSync(path.join(media,name),'synthetic media')
  fs.writeFileSync(path.join(media,'AAA-001.nfo'),'<movie><num>AAA-001</num><title>Coordinator real NFO title</title></movie>')
  const library=createMediaLibrary({name:'Entries',roots:[{path:media}]})
  db.prepare('UPDATE media_library_configs SET min_import_duration_minutes=1,auto_merge_same_code_resources=0,auto_import_local_nfo=1,remove_resource_less_memberships=1 WHERE library_id=?').run(library.id)
  const old=insertTestVideoWithFile(db,{libraryId:library.id,rootId:library.roots[0].id,code:'MISSING-001',filePath:path.join(media,'missing.mp4')})
  db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,finished_at,audit_json) VALUES('old',?,1,'manual','completed','old','old','{}')").run(library.id)
  db.prepare('INSERT INTO library_unrecognized_files(library_id,root_id,file_path,normalized_path,scan_run_id,last_seen_at) VALUES(?,?,?,?,?,?)')
    .run(library.id,library.roots[0].id,path.join(media,'old-unknown'),path.join(media,'old-unknown'),'old','old')
  const unrecognized=()=>db.prepare('SELECT * FROM library_unrecognized_files ORDER BY normalized_path').all()
  const originalUnrecognized=unrecognized()
  const entries=()=>db.prepare("SELECT * FROM library_scan_audit_entries WHERE run_id='cx-run' ORDER BY section,ordinal").all()
  let delivered=0,incrementalObserved=false,timer:ReturnType<typeof setTimeout>|undefined
  const coordinator=createScanCoordinator({
    ...(storage?{auditStorage:storage}:{}),createRunId:()=> 'cx-run',now:()=> '2026-09-11T00:00:00.000Z',
    scanFolders:async(request,onProgress,options)=>{
      if(storage==='json'){assert.equal(options?.resultMode,'detailed');assert.equal(options?.auditSink,undefined);assert.equal(typeof options?.onFileResult,'function')}
      else {assert.equal(options?.resultMode,'summary');assert.ok(options?.auditSink);assert.equal(options.onFileResult,undefined)}
      const sink=options?.auditSink
      return scanFolders(request,progress=>{
        assert.equal(db.inTransaction,false)
        if(!storage&&progress.scanned>0&&delivered>0){assert.ok(entries().length>0);incrementalObserved=true}
        onProgress?.(progress)
      },{...options,yieldEvery:1,readDurationSeconds:async(filePath)=>{assert.equal(db.inTransaction,false);if(processingFailure&&filePath.endsWith('AAA-001.mp4'))throw new Error('duration processing fault');return 120},
        readDirectory:async dir=>(await fs.promises.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name)),
        ...(sink?{auditSink:{...sink,recordFile:entry=>{
          sink.recordFile(entry);delivered++
          if(cancelAfterFirst&&delivered===1)timer=setTimeout(()=>coordinator.cancel(),0)
        }}}:{})})
    }
  })
  const events:LibraryScanEvent[]=[]
  coordinator.subscribe(event=>events.push(event))
  return {db,library,old,coordinator,events,entries,unrecognized,originalUnrecognized,get delivered(){return delivered},get incrementalObserved(){return incrementalObserved},clearTimer:()=>{if(timer)clearTimeout(timer)}}
}
function runState(current:ReturnType<typeof setup>){return current.db.prepare("SELECT status,audit_json FROM library_scan_runs WHERE id='cx-run'").get() as {status:string;audit_json:string|null}|undefined}
function body(current:ReturnType<typeof setup>){return JSON.parse(readScanAuditSource(current.db,{libraryId:current.library.id,runId:'cx-run'},'body')!.body) as LibraryScanAudit}

it('defaults to real incremental entries and publishes the same NFO/pending/cleanup audit as explicit legacy JSON',async()=>{
  const legacy=setup('json');const oldResult=await legacy.coordinator.run({libraryId:legacy.library.id,trigger:'manual'}),oldBody=body(legacy)
  const current=setup();const result=await current.coordinator.run({libraryId:current.library.id,trigger:'manual'})
  assert.deepEqual(result,oldResult);assert.deepEqual(body(current),oldBody)
  for(const value of [result,oldResult,...current.events.flatMap(event=>event.phase==='completed'?[event.result]:[]),...legacy.events.flatMap(event=>event.phase==='completed'?[event.result]:[])]){
    assert.equal('newCodes' in value,false);assert.equal('unrecognizedFiles' in value,false);assert.equal(value.unrecognizedCount,1)
  }
  assert.ok(current.delivered>=4);assert.equal(current.incrementalObserved,true)
  assert.deepEqual(runState(current),{status:'completed',audit_json:null})
  assert.equal((current.db.prepare("SELECT state FROM library_scan_audit_manifests WHERE run_id='cx-run'").get() as {state:string}).state,'published')
  const audit=body(current)
  assert.equal(audit.files.length,4);assert.equal(audit.files.find(entry=>entry.filePath.endsWith('AAA-001.mp4'))?.nfo?.disposition,'imported')
  assert.equal((current.db.prepare("SELECT title FROM videos WHERE code='AAA-001'").get() as {title:string}).title,'Coordinator real NFO title')
  assert.equal(audit.pendingGroups.length,1);assert.equal(audit.pendingGroups[0].resourceCount,2)
  assert.equal(audit.removedResources.length,1);assert.equal(audit.deletedVideos.length,1)
  const header=readScanAuditHeader(current.db,current.library.id)
  assert.equal(header.snapshot?.runId,'cx-run');assert.equal(header.unrecognizedCount,1)
  assert.equal(current.events.filter(event=>event.phase==='completed').length,1)
  assert.equal(current.events.some(event=>event.phase==='failed'),false)
  assert.deepEqual(current.db.prepare('SELECT file_path FROM library_unrecognized_files').all(),[{file_path:path.join(media,'unknown.mp4')}])
  assert.deepEqual(current.db.pragma('foreign_key_check'),[])
})

it('rolls run admission and state back when starting the audit manifest fails',async()=>{
  const current=setup(),before=current.db.prepare('SELECT * FROM media_library_scan_state ORDER BY library_id').all()
  current.db.exec("CREATE TEMP TRIGGER fail_start BEFORE INSERT ON library_scan_audit_manifests BEGIN SELECT RAISE(ABORT,'manifest start fault');END;")
  await assert.rejects(current.coordinator.run({libraryId:current.library.id}),/manifest start fault/)
  assert.equal(runState(current),undefined)
  assert.deepEqual(current.db.prepare('SELECT * FROM media_library_scan_state ORDER BY library_id').all(),before)
  assert.deepEqual(current.entries(),[]);assert.deepEqual(current.unrecognized(),current.originalUnrecognized)
  assert.equal(current.coordinator.running,false)
})

for(const phase of ['file','cleanup','pending-refresh','seal','publish'] as const)it(`does not falsely complete or replace old unrecognized rows after persistent ${phase} failure`,async()=>{
  const current=setup()
  const trigger=phase==='seal'||phase==='publish'
    ? `BEFORE UPDATE OF state ON library_scan_audit_manifests WHEN NEW.state='${phase==='seal'?'sealed':'published'}'`
    : `BEFORE INSERT ON library_scan_audit_entries WHEN NEW.section='${phase==='file'?'files':phase==='cleanup'?'removedResources':'pendingGroups'}'`
  current.db.exec(`CREATE TEMP TRIGGER fail_phase ${trigger} BEGIN SELECT RAISE(ABORT,'${phase} lifecycle fault');END;`)
  await assert.rejects(current.coordinator.run({libraryId:current.library.id}),new RegExp(`${phase} lifecycle fault`))
  assert.notEqual(runState(current)?.status,'completed')
  assert.equal(current.events.filter(event=>event.phase==='failed').length,1)
  assert.equal(current.events.some(event=>event.phase==='completed'),false)
  assert.deepEqual(current.unrecognized(),current.originalUnrecognized);assert.equal(current.coordinator.running,false)
  if(phase==='file'){
    assert.equal(current.db.prepare("SELECT id FROM videos WHERE code='AAA-001'").get(),undefined)
    assert.deepEqual(current.entries(),[])
  }
  if(phase==='cleanup')assert.ok(current.db.prepare('SELECT id FROM video_resources WHERE id=?').get(current.old.fileId))
  current.db.exec('DROP TRIGGER fail_phase')
  const beforeEntries=current.entries()
  recoverInterruptedLibraryScanRuns(current.db,'recovered')
  assert.equal(runState(current)?.status,'failed')
  assert.deepEqual(current.entries(),beforeEntries)
  const state=(current.db.prepare("SELECT state FROM library_scan_audit_manifests WHERE run_id='cx-run'").get() as {state:string}).state
  assert.equal(state,phase==='file'||phase==='cleanup'?'published':'abandoned')
  if(phase==='file'||phase==='cleanup')assert.equal(body(current).status,'failed')
  else assert.equal(readScanAuditSource(current.db,{libraryId:current.library.id,runId:'cx-run'},'identity'),undefined)
  assert.deepEqual(current.unrecognized(),current.originalUnrecognized)
  assert.deepEqual(current.db.pragma('foreign_key_check'),[])
})

it('a transient final publication fault cannot expose completed success or replace old unrecognized rows',async()=>{
  const current=setup();let publications=0
  current.db.function('fail_first_publication',()=>++publications===1?1:0)
  current.db.exec(`CREATE TEMP TRIGGER transient_publish BEFORE UPDATE OF state ON library_scan_audit_manifests
    WHEN NEW.state='published' AND fail_first_publication()=1 BEGIN SELECT RAISE(ABORT,'transient publication fault');END;`)
  await assert.rejects(current.coordinator.run({libraryId:current.library.id}),/transient publication fault/)
  assert.equal(publications,1);assert.equal(runState(current)?.status,'failed')
  assert.equal(current.events.filter(event=>event.phase==='failed').length,1)
  assert.equal(current.events.some(event=>event.phase==='completed'),false)
  assert.deepEqual(current.unrecognized(),current.originalUnrecognized)
  const source=readScanAuditSource(current.db,{libraryId:current.library.id,runId:'cx-run'},'body')
  assert.equal(source,undefined)
  assert.equal((current.db.prepare("SELECT state FROM library_scan_audit_manifests WHERE run_id='cx-run'").get() as {state:string}).state,'collecting')
  recoverInterruptedLibraryScanRuns(current.db,'recovered')
  assert.equal(runState(current)?.status,'failed')
  assert.equal((current.db.prepare("SELECT state FROM library_scan_audit_manifests WHERE run_id='cx-run'").get() as {state:string}).state,'abandoned')
  assert.equal(publications,1,'recovery must not retry publication')
})

it('cancellation retains incremental entries and the previous unrecognized snapshot',async()=>{
  const current=setup(undefined,true)
  try{
    const result=await current.coordinator.run({libraryId:current.library.id})
    assert.equal('newCodes' in result,false);assert.equal('unrecognizedFiles' in result,false);assert.equal(typeof result.unrecognizedCount,'number')
    assert.equal(result.cancelled,true);assert.ok(current.delivered>0&&current.delivered<4)
    assert.equal(runState(current)?.status,'cancelled');assert.equal(runState(current)?.audit_json,null)
    assert.deepEqual(current.unrecognized(),current.originalUnrecognized)
    assert.equal(body(current).files.length,current.delivered);assert.equal(body(current).status,'cancelled')
    assert.equal(current.coordinator.running,false)
  }finally{current.clearTimer()}
})

for(const phase of ['second-file','nfo-tail'] as const)it(`preserves committed partial counts on ${phase} storage failure`,async()=>{
  const current=setup()
  if(phase==='nfo-tail')fs.writeFileSync(path.join(media,'BBB-001.mp4'),'second unique video')
  current.db.exec(phase==='second-file'
    ? `CREATE TEMP TRIGGER fail_partial BEFORE INSERT ON library_scan_audit_entries
        WHEN NEW.section='files' AND NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'partial audit failure');END;`
    : `CREATE TEMP TRIGGER fail_partial BEFORE UPDATE OF entry_json ON library_scan_audit_entries
        WHEN NEW.section='files' BEGIN SELECT RAISE(ABORT,'partial audit failure');END;`)
  await assert.rejects(current.coordinator.run({libraryId:current.library.id}),/partial audit failure/)
  const row=current.db.prepare("SELECT status,summary_json FROM library_scan_runs WHERE id='cx-run'").get() as {status:string;summary_json:string}
  assert.equal(row.status,'failed')
  assert.ok(row.summary_json,'failed run must persist the committed partial summary')
  const summary=JSON.parse(row.summary_json)
  assert.equal(summary.status,'failed');assert.equal(summary.resourcesAdded,phase==='second-file'?1:2)
  assert.equal(summary.failedFiles,phase==='second-file'?0:1,'storage failure does not become another file failure')
  assert.equal(summary.pendingScanGroups,phase==='second-file'?0:1)
  assert.equal(summary.pendingScanResources,phase==='second-file'?0:2)
  assert.equal((current.db.prepare("SELECT COUNT(*) AS n FROM videos WHERE code IN ('AAA-001','BBB-001')").get() as {n:number}).n,phase==='second-file'?1:2)
  assert.equal(current.db.prepare("SELECT id FROM videos WHERE code='DUP-001'").get(),undefined)
  if(phase==='second-file'){
    assert.equal((current.db.prepare('SELECT COUNT(*) AS n FROM pending_scan_resources').get() as {n:number}).n,0)
    assert.equal(current.entries().length,1)
  }else{
    assert.equal((current.db.prepare("SELECT scraped_status FROM videos WHERE code='AAA-001'").get() as {scraped_status:number}).scraped_status,0)
  }
  assert.deepEqual(current.unrecognized(),current.originalUnrecognized)
})

it('leaves persistent failed-terminalization recoverable and startup preserves durable entries',async()=>{
  const current=setup()
  current.db.exec(`CREATE TEMP TRIGGER fail_file_storage BEFORE INSERT ON library_scan_audit_entries
    WHEN NEW.section='files' AND NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'persistent file fault');END;
    CREATE TEMP TRIGGER fail_terminalization BEFORE UPDATE OF status ON library_scan_runs
    WHEN NEW.id='cx-run' AND NEW.status='failed' BEGIN SELECT RAISE(ABORT,'persistent terminalization fault');END;`)
  await assert.rejects(current.coordinator.run({libraryId:current.library.id}),/persistent file fault/)
  assert.equal(runState(current)?.status,'running')
  assert.equal((current.db.prepare("SELECT state FROM library_scan_audit_manifests WHERE run_id='cx-run'").get() as {state:string}).state,'collecting')
  const before=current.entries();assert.equal(before.length,1)
  assert.deepEqual(current.unrecognized(),current.originalUnrecognized)
  current.db.exec('DROP TRIGGER fail_file_storage;DROP TRIGGER fail_terminalization')
  assert.equal(recoverInterruptedLibraryScanRuns(current.db,'recovered').recoveredRunCount,1)
  assert.equal(runState(current)?.status,'failed')
  assert.equal((current.db.prepare("SELECT state FROM library_scan_audit_manifests WHERE run_id='cx-run'").get() as {state:string}).state,'abandoned')
  assert.deepEqual(current.entries(),before);assert.deepEqual(current.unrecognized(),current.originalUnrecognized)
})

for(const storage of [undefined,'json'] as const)it(`keeps cleanup blocked for processing failures alongside unrecognized files in ${storage??'entries'} mode`,async()=>{
  const current=setup(storage,false,true)
  const result=await current.coordinator.run({libraryId:current.library.id})
  assert.equal(result.unrecognizedCount,1)
  assert.equal('newCodes' in result,false);assert.equal('unrecognizedFiles' in result,false)
  assert.equal(result.failed,2)
  assert.equal(result.removed,0);assert.equal(result.deletedVideos,0)
  assert.ok(current.db.prepare('SELECT id FROM video_resources WHERE id=?').get(current.old.fileId))
  assert.deepEqual(current.unrecognized(),current.originalUnrecognized)
  assert.equal(body(current).status,'failed')
  assert.equal(current.events.filter(event=>event.phase==='failed').length,1)
  assert.equal(current.events.some(event=>event.phase==='completed'),false)
})
