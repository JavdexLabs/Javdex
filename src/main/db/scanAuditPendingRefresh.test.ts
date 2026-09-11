import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { LibraryScanFileAuditEntry } from '@shared/libraryTypes'
import { initDatabaseAtPath, closeDatabase } from './database'
import { createScanAuditWriter, type ScanAuditMetadata, SCAN_AUDIT_WRITE_MAX_BYTES } from './scanAuditWriter'
import { upsertPendingScanResources } from './pendingScanRepo'
import { readPendingScanAuditEntries } from './pendingScanAuditRepo'

let db:Database.Database,directory:string,writer:ReturnType<typeof createScanAuditWriter>
let groupA:number,groupB:number
const scope={libraryId:1,runId:'pending-refresh'}
const meta:ScanAuditMetadata={schemaVersion:2,...scope,configRevision:1,trigger:'manual',startedAt:'start',finishedAt:'pending',status:'success'}
beforeEach(()=>{
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-pending-refresh-'))
  db=initDatabaseAtPath(path.join(directory,'catalog.db'))
  db.exec(`INSERT INTO media_library_roots(id,library_id,path,normalized_path) VALUES(1,1,'/fixture','/fixture');
    INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at) VALUES('pending-refresh',1,1,'manual','running','start');`)
  const resource=(filePath:string)=>({rootId:1,filePath,sizeBytes:1,durationSeconds:1,fileMtimeMs:1})
  groupA=upsertPendingScanResources(1,'GROUP-001',[resource('/fixture/a.mp4'),resource('/fixture/global.mp4')]).groupId
  groupB=upsertPendingScanResources(1,'GROUP-002',[resource('/fixture/b.mp4')]).groupId
  db.prepare("UPDATE pending_scan_groups SET updated_at=CASE WHEN id=? THEN 'b' ELSE 'a' END").run(groupA)
  writer=createScanAuditWriter(db,scope);writer.start(meta)
  // Match the platform-native paths stored by upsertPendingScanResources.
  // Each referenced path belongs to the other group: count must use the global
  // pending path set, including a path from a null-group pending file.
  writer.writeBatch('files',[
    {rootId:1,filePath:path.resolve('/fixture/b.mp4'),sourceKind:'local',outcome:'pending',normalizedCode:'GROUP-001',groupId:groupA,addedToQueue:false},
    {rootId:1,filePath:path.resolve('/fixture/a.mp4'),sourceKind:'local',outcome:'pending',normalizedCode:'GROUP-002',groupId:groupB,addedToQueue:false},
    {rootId:1,filePath:path.resolve('/fixture/global.mp4'),sourceKind:'local',outcome:'pending',normalizedCode:null,groupId:null,addedToQueue:false}
  ])
  const entry={resourceId:1,videoId:1,videoCode:'OLD-001',videoTitle:null,resourceKind:'local' as const,sourcePath:'/old',displayName:null}
  writer.writeBatch('removedResources',[{...entry,reason:'missing'}])
  writer.writeBatch('promotedResources',[{...entry,reason:'promoted_after_removal'}])
  writer.writeBatch('deletedVideos',[{videoId:1,videoCode:'OLD-001',videoTitle:null,reason:'resource_less'}])
  writer.writeBatch('pendingGroups',[{groupId:999,normalizedCode:'OLD',resourceCount:9}])
})
afterEach(()=>{closeDatabase();fs.rmSync(directory,{recursive:true,force:true})})

function rows(){return db.prepare('SELECT * FROM library_scan_audit_entries ORDER BY section,ordinal').all() as {section:string;ordinal:number;entry_json:string}[]}
function pending(){return rows().filter(row=>row.section==='pendingGroups')}
function others(){return rows().filter(row=>row.section!=='pendingGroups')}
function oracle(){
  const files=rows().filter(row=>row.section==='files').map(row=>JSON.parse(row.entry_json) as LibraryScanFileAuditEntry)
  const ids=new Set<number>(),paths=new Set<string>()
  for(const entry of files)if(entry.outcome==='pending'){paths.add(entry.filePath);if(entry.groupId!=null)ids.add(entry.groupId)}
  return readPendingScanAuditEntries(1,ids,paths)
}
function snapshot(){return {audit:rows(),groups:db.prepare('SELECT * FROM pending_scan_groups ORDER BY id').all(),resources:db.prepare('SELECT * FROM pending_scan_resources ORDER BY id').all()}}
function assertCurrent(){
  const actual=pending()
  assert.deepEqual(actual.map(row=>JSON.parse(row.entry_json)),oracle())
  assert.deepEqual(actual.map(row=>row.ordinal),actual.map((_,index)=>index))
}

it('rebuilds ordered pendingGroups repeatedly without duplicates and preserves all other sections',()=>{
  const untouched=others()
  writer.refreshPendingGroups();assertCurrent()
  assert.deepEqual(pending().map(row=>JSON.parse(row.entry_json)),[
    {groupId:groupB,normalizedCode:'GROUP-002',resourceCount:1},
    {groupId:groupA,normalizedCode:'GROUP-001',resourceCount:2}
  ])
  const first=pending();writer.refreshPendingGroups();assert.deepEqual(pending(),first);assert.deepEqual(others(),untouched)
  db.transaction(()=>{
    db.prepare("UPDATE pending_scan_groups SET normalized_code='RENAMED',updated_at='0',revision=revision+1 WHERE id=?").run(groupA)
    db.prepare("DELETE FROM pending_scan_resources WHERE file_path=?").run(path.resolve('/fixture/global.mp4'))
  })()
  writer.refreshPendingGroups();assertCurrent();assert.deepEqual(others(),untouched)
  assert.deepEqual(pending().map(row=>JSON.parse(row.entry_json)),[
    {groupId:groupA,normalizedCode:'RENAMED',resourceCount:1},
    {groupId:groupB,normalizedCode:'GROUP-002',resourceCount:1}
  ])
  db.prepare('DELETE FROM pending_scan_groups WHERE id=?').run(groupB)
  writer.refreshPendingGroups();assertCurrent();assert.equal(pending().length,1);assert.deepEqual(others(),untouched)
})

it('restores the previous section and outer business mutation after native second-group INSERT failure, then retries',()=>{
  writer.refreshPendingGroups();const before=snapshot();let faults=0
  db.function('observe_second_pending',()=>{faults++;return 1})
  db.exec(`CREATE TEMP TRIGGER fail_second_pending AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='pendingGroups' AND NEW.ordinal=1 BEGIN
      SELECT observe_second_pending();SELECT RAISE(ABORT,'second group INSERT fault');END;`)
  const refreshWithBusinessChange=()=>db.transaction(()=>{
    db.prepare("UPDATE pending_scan_groups SET normalized_code='TRANSACTION',revision=revision+1 WHERE id=?").run(groupA)
    db.prepare("DELETE FROM pending_scan_resources WHERE file_path=?").run(path.resolve('/fixture/global.mp4'))
    writer.refreshPendingGroups()
  })()
  assert.throws(refreshWithBusinessChange,/second group INSERT fault/)
  assert.equal(faults,1);assert.deepEqual(snapshot(),before);assert.equal(db.inTransaction,false)
  db.exec('DROP TRIGGER fail_second_pending')
  refreshWithBusinessChange();assertCurrent();assert.deepEqual(others(),before.audit.filter(row=>row.section!=='pendingGroups'))
  assert.equal(JSON.parse(pending().find(row=>JSON.parse(row.entry_json).groupId===groupA)!.entry_json).normalizedCode,'TRANSACTION')
  assert.deepEqual(db.pragma('foreign_key_check'),[])
})

it('rolls back an oversized single pending group together with its outer metadata change',()=>{
  writer.refreshPendingGroups();const before=snapshot()
  assert.throws(()=>db.transaction(()=>{
    db.prepare('UPDATE pending_scan_groups SET normalized_code=? WHERE id=?').run('X'.repeat(SCAN_AUDIT_WRITE_MAX_BYTES+1),groupA)
    writer.refreshPendingGroups()
  })(),/exceeds|MiB|budget/i)
  assert.deepEqual(snapshot(),before);assert.equal(db.inTransaction,false)
  writer.refreshPendingGroups();assertCurrent()
})

for(const state of ['sealed','terminal'] as const)it(`rejects ${state} writer state without deleting prior sections`,()=>{
  writer.refreshPendingGroups()
  if(state==='sealed')writer.seal({...meta,finishedAt:'finish'})
  else db.prepare("UPDATE library_scan_runs SET status='failed',finished_at='finish' WHERE id=?").run(scope.runId)
  const before=snapshot()
  assert.throws(()=>writer.refreshPendingGroups(),/collecting|running/i)
  assert.deepEqual(snapshot(),before);assert.equal(db.inTransaction,false)
})

it('refreshes more than 100 referenced groups across item-bounded batches with stable global ordinals',()=>{
  const insert=db.prepare('INSERT INTO pending_scan_groups(library_id,normalized_code,revision,created_at,updated_at) VALUES(1,?,1,?,?)')
  const files:LibraryScanFileAuditEntry[]=[]
  db.transaction(()=>{
    for(let index=0;index<205;index++){
      const stamp=`extra-${String(205-index).padStart(3,'0')}`
      const groupId=Number(insert.run(`EXTRA-${index}`,stamp,stamp).lastInsertRowid)
      files.push({rootId:1,filePath:`/fixture/extra-${index}.mp4`,sourceKind:'local',outcome:'pending',normalizedCode:`EXTRA-${index}`,groupId,addedToQueue:false})
    }
  })()
  for(let offset=0;offset<files.length;offset+=100)writer.writeBatch('files',files.slice(offset,offset+100))
  const untouched=others()
  writer.refreshPendingGroups();assertCurrent();assert.equal(pending().length,207)
  assert.deepEqual(pending().map(row=>row.ordinal),Array.from({length:207},(_,index)=>index))
  assert.deepEqual(others(),untouched)
  const first=pending();writer.refreshPendingGroups();assert.deepEqual(pending(),first);assert.deepEqual(others(),untouched)
})

it('flushes by bytes when moderately large valid singletons together exceed the batch budget',()=>{
  const update=db.prepare('UPDATE pending_scan_groups SET normalized_code=? WHERE id=?')
  update.run(`A${'x'.repeat(600*1024)}`,groupA)
  update.run(`B${'y'.repeat(600*1024)}`,groupB)
  const expected=oracle(),untouched=others()
  assert.equal(expected.length,2)
  for(const entry of expected){
    assert.ok(Buffer.byteLength(JSON.stringify(entry))+1024<SCAN_AUDIT_WRITE_MAX_BYTES,'each individual page fits with wrapper headroom')
  }
  assert.ok(Buffer.byteLength(JSON.stringify(expected))>SCAN_AUDIT_WRITE_MAX_BYTES,'one aggregate writeBatch would fail')
  writer.refreshPendingGroups();assertCurrent()
  assert.deepEqual(pending().map(row=>JSON.parse(row.entry_json)),expected)
  assert.deepEqual(pending().map(row=>row.ordinal),[0,1]);assert.deepEqual(others(),untouched)
  const first=pending();writer.refreshPendingGroups();assert.deepEqual(pending(),first);assert.deepEqual(others(),untouched)
  assert.deepEqual(db.pragma('foreign_key_check'),[])
})

it('refreshes the captured writer identity after the caller mutates its original scope object',()=>{
  const callerScope={...scope}
  const capturedWriter=createScanAuditWriter(db,callerScope)
  const untouched=others()
  callerScope.libraryId=999
  callerScope.runId='mutated-missing-run'
  capturedWriter.refreshPendingGroups()
  assertCurrent();assert.equal(pending().length,2);assert.deepEqual(others(),untouched)
  assert.deepEqual(db.prepare('SELECT DISTINCT run_id FROM library_scan_audit_entries').all(),[{run_id:scope.runId}])
})
