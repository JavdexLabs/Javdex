import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { LibraryScanAudit, LibraryScanSummary } from '@shared/libraryTypes'
import { initDatabaseAtPath, closeDatabase } from './database'
import { beginLibraryScanRun, finishLibraryScanEntriesRun, recoverInterruptedLibraryScanRuns } from './libraryScanRepo'
import { readScanAuditSource } from './scanAuditSource'
import { createScanAuditWriter, type ScanAuditMetadata } from './scanAuditWriter'
import { readScanAuditHeader } from '../../../../apps/desktop/src/main/services/scanAuditReadHeader'
import { createScanAuditPathPermissionReader } from '../../../../apps/desktop/src/main/services/scanAuditPathPermission'

let directory: string, db: Database.Database
const sections = ['files','removedResources','promotedResources','deletedVideos','pendingGroups'] as const
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-publication-'))
  db = initDatabaseAtPath(path.join(directory, 'catalog.db'))
  db.exec(`INSERT INTO media_libraries(id,name) VALUES(2,'Other');
    INSERT INTO media_library_roots(id,library_id,path,normalized_path) VALUES(10,1,'/synthetic','/synthetic');
    INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,finished_at,audit_json)
      VALUES('old',1,1,'manual','completed','old-start','old-end','{}');
    INSERT INTO library_unrecognized_files(library_id,root_id,file_path,normalized_path,scan_run_id,last_seen_at)
      VALUES(1,10,'/synthetic/old.mp4','/synthetic/old.mp4','old','old-end');`)
})
afterEach(() => { closeDatabase(); fs.rmSync(directory, { recursive:true, force:true }) })

function summary(runId: string, status: LibraryScanSummary['status'] = 'success'): LibraryScanSummary {
  return { libraryId:1,runId,configRevision:3,trigger:'manual',startedAt:'start',finishedAt:'finish',status,
    scannedFiles:1,resourcesAdded:0,resourcesUpdated:0,resourcesRemoved:0,primaryResourcesPromoted:0,videosDeleted:0,
    skippedFiles:0,failedFiles:0,pendingScanGroups:0,pendingScanResources:0,offlineFolders:[],errorSummary:null }
}

function prepare(runId: string, options: { status?:LibraryScanSummary['status']; collecting?:boolean; meta?:Record<string,unknown> } = {}) {
  const result = summary(runId, options.status)
  beginLibraryScanRun({ libraryId:1,runId,configRevision:3,trigger:'manual',startedAt:'start' })
  const audit: LibraryScanAudit = { schemaVersion:2,libraryId:1,runId,configRevision:3,trigger:'manual',startedAt:'start',finishedAt:'finish',status:result.status,
    files:[{rootId:10,filePath:'/synthetic/new.mp4',sourceKind:'local',outcome:'unrecognized'}],
    removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[] }
  const meta: Record<string,unknown> = { ...audit, ...options.meta }
  for (const section of sections) delete meta[section]
  db.prepare('INSERT INTO library_scan_audit_manifests(run_id,meta_json) VALUES(?,?)').run(runId,JSON.stringify(meta))
  const entry = JSON.stringify(audit.files[0])
  db.prepare("INSERT INTO library_scan_audit_entries(run_id,section,ordinal,entry_key,entry_json,entry_bytes) VALUES(?,'files',0,?,?,?)")
    .run(runId,audit.files[0].filePath,entry,Buffer.byteLength(entry))
  if (!options.collecting) db.prepare("UPDATE library_scan_audit_manifests SET state='sealed',sealed_at='sealed' WHERE run_id=?").run(runId)
  return { result, audit }
}

function finish(result: LibraryScanSummary, status: 'completed'|'failed'|'cancelled' = 'completed', libraryId = 1) {
  finishLibraryScanEntriesRun({ libraryId,runId:result.runId,status,summary:result,
    replaceUnrecognizedRootIds:[10],unrecognizedFiles:[{rootId:10,filePath:'/synthetic/new.mp4',normalizedPath:'/synthetic/new.mp4'}] })
}

function rows(table: string) {
  const order: Record<string,string> = {
    library_scan_runs:'id', media_library_scan_state:'library_id',library_unrecognized_files:'library_id,normalized_path',
    library_scan_audit_manifests:'run_id',library_scan_audit_entries:'run_id,section,ordinal'
  }
  assert.ok(Object.hasOwn(order,table))
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${order[table]}`).all()
}
function snapshot() {
  return Object.fromEntries(['library_scan_runs','media_library_scan_state','library_unrecognized_files','library_scan_audit_manifests','library_scan_audit_entries'].map(table=>[table,rows(table)]))
}
function manifest(runId: string) {
  return db.prepare('SELECT state FROM library_scan_audit_manifests WHERE run_id=?').get(runId) as {state:string}
}
function integrity() {
  assert.deepEqual(db.pragma('foreign_key_check'),[])
  assert.deepEqual(db.pragma('integrity_check'),[{integrity_check:'ok'}])
}

it('publishes sealed entries with run/state/unrecognized updates and exposes header/body/permissions', () => {
  const {result,audit} = prepare('published')
  assert.equal(readScanAuditSource(db,{libraryId:1,runId:result.runId},'identity'),undefined)
  finish(result)
  assert.equal(manifest(result.runId).state,'published')
  const run = db.prepare('SELECT status,audit_json,summary_json FROM library_scan_runs WHERE id=?').get(result.runId) as {status:string;audit_json:null;summary_json:string}
  assert.equal(run.status,'completed');assert.equal(run.audit_json,null);assert.deepEqual(JSON.parse(run.summary_json),result)
  const state = db.prepare('SELECT active_run_id,last_status,last_summary_json FROM media_library_scan_state WHERE library_id=1').get() as {active_run_id:null;last_status:string;last_summary_json:string}
  assert.equal(state.active_run_id,null);assert.equal(state.last_status,'completed');assert.deepEqual(JSON.parse(state.last_summary_json),result)
  assert.deepEqual(db.prepare('SELECT file_path,scan_run_id FROM library_unrecognized_files WHERE library_id=1').all(),[{file_path:'/synthetic/new.mp4',scan_run_id:result.runId}])
  assert.deepEqual(readScanAuditHeader(db,1),{summary:result,snapshot:{libraryId:1,runId:result.runId,finishedAt:'finish'},unrecognizedCount:1})
  const source=readScanAuditSource(db,{libraryId:1,runId:result.runId},'body')
  assert.equal(source?.format,'entries');assert.deepEqual(JSON.parse(source!.body),audit)
  // Remove the independent fastpath to prove authorization reads the published audit.
  db.prepare('DELETE FROM library_unrecognized_files WHERE library_id=1').run()
  const canReveal=createScanAuditPathPermissionReader(db)
  assert.equal(canReveal(1,'/synthetic/new.mp4'),true);assert.equal(canReveal(1,'/synthetic/old.mp4'),false)
  assert.equal(canReveal(2,'/synthetic/new.mp4'),false)
  integrity()
})

it('rolls back every finish write when late publication fails, then retries the same sealed audit', () => {
  const {result}=prepare('retry'),before=snapshot()
  let observed:unknown[]|undefined
  db.function('observe_publication',(status,active,lastStatus,newFiles,state)=>{observed=[status,active,lastStatus,newFiles,state];return 1})
  db.exec(`CREATE TEMP TRIGGER fail_publication AFTER UPDATE OF state ON library_scan_audit_manifests
    WHEN NEW.state='published' BEGIN SELECT observe_publication(
      (SELECT status FROM library_scan_runs WHERE id=NEW.run_id),
      (SELECT active_run_id FROM media_library_scan_state WHERE library_id=1),
      (SELECT last_status FROM media_library_scan_state WHERE library_id=1),
      (SELECT COUNT(*) FROM library_unrecognized_files WHERE scan_run_id=NEW.run_id),NEW.state);
      SELECT RAISE(ABORT,'publication interrupted'); END;`)
  assert.throws(()=>finish(result),/publication interrupted/)
  assert.deepEqual(observed,['completed',null,'completed',1,'published'])
  assert.deepEqual(snapshot(),before);assert.equal(db.inTransaction,false);integrity()
  db.exec('DROP TRIGGER fail_publication')
  finish(result);assert.equal(manifest(result.runId).state,'published');integrity()
})

it('rejects wrong scope, collecting manifests and metadata mismatches without partial writes', () => {
  let index=0
  for(const change of [{libraryId:2},{runId:'wrong'},{finishedAt:'wrong'},{configRevision:4},{trigger:'startup'},{startedAt:'wrong'},{status:'failed'}]){
    const {result}=prepare(`bad-${index++}`,{meta:change}),before=snapshot()
    assert.throws(()=>finish(result));assert.deepEqual(snapshot(),before)
  }
  const collecting=prepare('collecting',{collecting:true}).result,before=snapshot()
  assert.throws(()=>finish(collecting));assert.deepEqual(snapshot(),before)
  const scoped=prepare('scoped').result,scopedBefore=snapshot()
  assert.throws(()=>finish(scoped,'completed',2));assert.deepEqual(snapshot(),scopedBefore)
  integrity()
})

it('rejects persisted run mismatches, incompatible completion status and oversized metadata before changing data',()=>{
  let index=0
  for(const assignment of ["config_revision=4","started_at='wrong'","trigger='automatic'"]){
    const {result}=prepare(`raw-${index++}`)
    db.prepare(`UPDATE library_scan_runs SET ${assignment} WHERE id=?`).run(result.runId)
    const before=snapshot();assert.throws(()=>finish(result));assert.deepEqual(snapshot(),before)
  }
  for(const status of ['failed','cancelled'] as const){
    const {result}=prepare(`status-${status}`),before=snapshot()
    assert.throws(()=>finish(result,status));assert.deepEqual(snapshot(),before)
  }
  const {result}=prepare('oversized',{meta:{padding:'x'.repeat(256*1024)}}),before=snapshot()
  assert.throws(()=>finish(result));assert.deepEqual(snapshot(),before);integrity()
})

for(const status of ['failed','cancelled'] as const)it(`publishes ${status} audit without replacing previous unrecognized files`,()=>{
  const {result,audit}=prepare(status,{status}),before=rows('library_unrecognized_files')
  finish(result,status)
  assert.equal(manifest(result.runId).state,'published')
  assert.deepEqual(rows('library_unrecognized_files'),before)
  assert.deepEqual(JSON.parse(readScanAuditSource(db,{libraryId:1,runId:result.runId},'body')!.body),audit)
  assert.equal((db.prepare('SELECT last_status FROM media_library_scan_state WHERE library_id=1').get() as {last_status:string}).last_status,status)
  integrity()
})

it('abandons interrupted collecting/sealed audits while preserving published history and all entries, idempotently',()=>{
  const published=prepare('published').result;finish(published)
  const kept=db.prepare("SELECT * FROM library_scan_runs WHERE id='published'").get()
  prepare('collecting',{collecting:true});prepare('sealed')
  const entries=rows('library_scan_audit_entries'),unrecognized=rows('library_unrecognized_files')
  const result=recoverInterruptedLibraryScanRuns(db,'recovered')
  assert.equal(result.recoveredRunCount,2)
  for(const id of ['collecting','sealed'])assert.equal(manifest(id).state,'abandoned')
  assert.equal(manifest('published').state,'published')
  assert.deepEqual(db.prepare("SELECT * FROM library_scan_runs WHERE id='published'").get(),kept)
  assert.deepEqual(rows('library_scan_audit_entries'),entries);assert.deepEqual(rows('library_unrecognized_files'),unrecognized)
  const after=snapshot()
  assert.deepEqual(recoverInterruptedLibraryScanRuns(db,'later'),{recoveredRunCount:0,recoveredStateCount:0})
  assert.deepEqual(snapshot(),after);integrity()
})

it('abandons already-terminal unexposed manifests even when no interrupted runs remain',()=>{
  for(const collecting of [true,false]){
    const {result}=prepare(`terminal-${collecting}`,{collecting})
    db.prepare("UPDATE library_scan_runs SET status='failed',finished_at='stopped' WHERE id=?").run(result.runId)
  }
  const beforeEntries=rows('library_scan_audit_entries')
  assert.deepEqual(recoverInterruptedLibraryScanRuns(db,'recovered'),{recoveredRunCount:0,recoveredStateCount:0})
  for(const id of ['terminal-true','terminal-false'])assert.equal(manifest(id).state,'abandoned')
  assert.deepEqual(rows('library_scan_audit_entries'),beforeEntries)
  const after=snapshot();recoverInterruptedLibraryScanRuns(db,'later');assert.deepEqual(snapshot(),after);integrity()
})

it('rolls back recovery run/state/manifest changes on abandonment failure and succeeds on retry',()=>{
  prepare('recover-collecting',{collecting:true});prepare('recover-sealed')
  const before=snapshot();let injected=false
  db.function('observe_abandonment',()=>{injected=true;return 1})
  db.exec(`CREATE TEMP TRIGGER fail_abandon AFTER UPDATE OF state ON library_scan_audit_manifests
    WHEN NEW.state='abandoned' BEGIN SELECT observe_abandonment(); SELECT RAISE(ABORT,'recovery interrupted'); END;`)
  assert.throws(()=>recoverInterruptedLibraryScanRuns(db,'recovered'),/recovery interrupted/)
  assert.equal(injected,true);assert.deepEqual(snapshot(),before);assert.equal(db.inTransaction,false);integrity()
  db.exec('DROP TRIGGER fail_abandon')
  assert.equal(recoverInterruptedLibraryScanRuns(db,'retry').recoveredRunCount,2)
  assert.equal(manifest('recover-collecting').state,'abandoned');assert.equal(manifest('recover-sealed').state,'abandoned');integrity()
})

it('publishes the actual writer after stable upserts and an NFO revision through the production finish transaction', () => {
  const result=summary('writer-end-to-end')
  beginLibraryScanRun({libraryId:1,runId:result.runId,configRevision:3,trigger:'manual',startedAt:'start'})
  const writer=createScanAuditWriter(db,{libraryId:1,runId:result.runId})
  const metadata:ScanAuditMetadata={schemaVersion:2,libraryId:1,runId:result.runId,configRevision:3,
    trigger:'manual',startedAt:'start',finishedAt:'pending',status:'success'}
  writer.start(metadata)
  const file:LibraryScanAudit['files'][number]={rootId:10,filePath:'/synthetic/new.mp4',sourceKind:'local',outcome:'unrecognized'}
  writer.writeBatch('files',[file])
  writer.writeBatch('files',[file])
  const nfo={disposition:'warning' as const,warnings:[{code:'test',message:'warning'}]}
  assert.equal(writer.patchNfo(file.filePath,nfo),true)
  assert.equal(readScanAuditHeader(db,1).snapshot,null)
  writer.seal({...metadata,finishedAt:'finish'})
  finish(result)
  const source=readScanAuditSource(db,{libraryId:1,runId:result.runId},'body')!
  assert.deepEqual(JSON.parse(source.body),{...metadata,finishedAt:'finish',files:[{...file,nfo}],
    removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[]})
  assert.deepEqual(readScanAuditHeader(db,1).snapshot,{libraryId:1,runId:result.runId,finishedAt:'finish'})
  integrity()
})
