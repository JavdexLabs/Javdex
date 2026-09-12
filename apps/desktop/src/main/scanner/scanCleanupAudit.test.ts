import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { ScanResult } from '@shared/libraryTypes'
import { initDatabaseAtPath, closeDatabase, openReadOnlyDatabaseAtPath } from '../db/database'
import { createMediaLibrary } from '../db/mediaLibraryRepo'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { insertLocalVideoResource } from '../db/videoRepo'
import { beginLibraryScanRun } from '../db/libraryScanRepo'
import { createScanAuditWriter } from '../db/scanAuditWriter'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { createScanCoordinator, type ScanCoordinatorDependencies } from './scanCoordinator'

let directory:string,db:Database.Database,previousUserData:string|undefined
beforeEach(()=>{
  previousUserData=process.env.JAVDEX_TEST_USER_DATA
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-cleanup-audit-'))
  process.env.JAVDEX_TEST_USER_DATA=directory
  db=initDatabaseAtPath(path.join(directory,'catalog.db'))
})
afterEach(()=>{
  closeDatabase();resetSettingsCacheForTests()
  if(previousUserData===undefined)delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA=previousUserData
  fs.rmSync(directory,{recursive:true,force:true})
})

function empty(libraryId:number,runId:string):ScanResult {
  return {libraryId,runId,scannedFiles:0,imported:0,skipped:0,skippedShort:0,failed:0,pendingGroups:0,pendingResources:0,
    relocated:0,refreshed:0,removed:0,promoted:0,deletedVideos:0,offlineFolders:[],newCodes:[],unrecognizedFiles:[],strmFailures:[],omittedStrmFailures:0}
}
function businessSnapshot(connection:Database.Database) {
  // Run admission/finish state is deliberately outside cleanup. Include every other
  // user table, including all resource, membership, pending and audit-entry rows.
  const tables=connection.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
    AND name NOT IN ('library_scan_runs','media_library_scan_state','library_scan_audit_manifests') ORDER BY name`).all() as {name:string}[]
  return tables.map(({name})=>({name,rows:connection.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all()
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))}))
}

for(const section of ['removedResources','promotedResources','deletedVideos'] as const)it(`native ${section} audit INSERT failure rolls back real cleanup tables and retries without phantom counts`,async()=>{
  const media=path.join(directory,'media');fs.mkdirSync(media)
  const library=createMediaLibrary({name:'Cleanup',roots:[{path:media}]})
  if(section==='deletedVideos')db.prepare('UPDATE media_library_configs SET remove_resource_less_memberships=1 WHERE library_id=?').run(library.id)
  const missing=path.join(media,'CLEAN-001.mp4')
  const initial=insertTestVideoWithFile(db,{libraryId:library.id,rootId:library.roots[0].id,code:'CLEAN-001',filePath:missing,isPrimary:true})
  let promotedId:number|null=null
  if(section==='promotedResources'){
    const existing=path.join(media,'CLEAN-001-CD2.mp4');fs.writeFileSync(existing,'present')
    promotedId=insertLocalVideoResource({libraryId:library.id,videoId:initial.videoId,rootId:library.roots[0].id,locator:existing,sizeBytes:7,durationSeconds:120,fileMtimeMs:1000})
    assert.ok(promotedId)
  }
  const before=businessSnapshot(db),reader=openReadOnlyDatabaseAtPath(db.name)
  let sequence=0,writer:ReturnType<typeof createScanAuditWriter>,activeRunId='',faults=0,targetCalls=0
  const finished:Parameters<ScanCoordinatorDependencies['finishRun']>[0][]=[]
  db.function('observe_cleanup_audit',()=>{faults++;return 1})
  db.exec(`CREATE TEMP TRIGGER fail_cleanup_audit AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='${section}' BEGIN SELECT observe_cleanup_audit();SELECT RAISE(ABORT,'native cleanup audit failure');END;`)
  const coordinator=createScanCoordinator({cleanupMode:'atomic',
    auditStorage: 'json',
    createRunId:()=>`cleanup-${++sequence}`,
    beginRun:input=>{
      beginLibraryScanRun(input);activeRunId=input.runId
      writer=createScanAuditWriter(db,input)
      writer.start({schemaVersion:2,...input,finishedAt:'pending',status:'success'})
    },
    // Deliberately capture final summaries: this seam does not publish manifests
    // or pass a legacy JSON audit to an entries-backed run.
    finishRun:input=>{finished.push(input)},
    scanFolders:async request=>{assert.equal(db.inTransaction,false);return empty(request.libraryId,request.runId)},
    recordCleanupAudit:(identity,event)=>{
      assert.deepEqual(identity,{libraryId:library.id,runId:activeRunId});assert.equal(db.inTransaction,true)
      if(event.section===section){
        targetCalls++
        assert.equal(db.prepare('SELECT id FROM video_resources WHERE id=?').get(initial.fileId),undefined)
        if(section==='promotedResources')assert.equal((db.prepare('SELECT is_primary FROM video_resources WHERE id=?').get(promotedId!) as {is_primary:number}).is_primary,1)
        if(section==='deletedVideos')assert.equal(db.prepare('SELECT 1 FROM library_video_memberships WHERE library_id=? AND video_id=?').get(library.id,initial.videoId),undefined)
        assert.deepEqual(businessSnapshot(reader),before,'independent connection cannot see uncommitted cleanup or earlier audit entries')
      }
      if(event.section==='deletedVideos')writer.writeBatch('deletedVideos',[event.entry])
      else writer.writeBatch(event.section,[event.entry])
    }
  })
  try{
    await assert.rejects(coordinator.run({libraryId:library.id,trigger:'manual'}),/native cleanup audit failure/)
    assert.equal(faults,1);assert.equal(targetCalls,1);assert.equal(db.inTransaction,false)
    assert.deepEqual(businessSnapshot(db),before);assert.deepEqual(businessSnapshot(reader),before)
    assert.equal(finished.length,1);assert.equal(finished[0].summary.status,'failed')
    assert.equal(finished[0].summary.resourcesRemoved,0);assert.equal(finished[0].summary.primaryResourcesPromoted,0);assert.equal(finished[0].summary.videosDeleted,0)
    assert.deepEqual(finished[0].audit.removedResources,[]);assert.deepEqual(finished[0].audit.promotedResources,[]);assert.deepEqual(finished[0].audit.deletedVideos,[])
    db.exec('DROP TRIGGER fail_cleanup_audit')
    const result=await coordinator.run({libraryId:library.id,trigger:'manual'})
    assert.equal(targetCalls,2);assert.equal(result.removed,1)
    assert.equal(result.promoted,section==='promotedResources'?1:0);assert.equal(result.deletedVideos,section==='deletedVideos'?1:0)
    assert.equal(finished[1].summary.resourcesRemoved,1)
    assert.equal(finished[1].summary.primaryResourcesPromoted,result.promoted);assert.equal(finished[1].summary.videosDeleted,result.deletedVideos)
    assert.equal(db.prepare('SELECT id FROM video_resources WHERE id=?').get(initial.fileId),undefined)
    const entries=db.prepare('SELECT run_id,section,ordinal,entry_json FROM library_scan_audit_entries ORDER BY section,ordinal').all() as {run_id:string;section:string;ordinal:number;entry_json:string}[]
    assert.equal(entries.length,section==='removedResources'?1:2)
    for(const entry of entries){assert.equal(entry.run_id,activeRunId);assert.equal(entry.ordinal,0)}
    for(const name of ['removedResources','promotedResources','deletedVideos'] as const){
      assert.deepEqual(entries.filter(entry=>entry.section===name).map(entry=>JSON.parse(entry.entry_json)),finished[1].audit[name])
    }
    assert.deepEqual(businessSnapshot(reader),businessSnapshot(db))
    assert.deepEqual(db.pragma('foreign_key_check'),[])
  }finally{reader.close()}
})

for(const rejected of [false,true])it(`rejects ${rejected?'rejected':'resolved'} async cleanup callbacks and rolls back synchronous writes`,async()=>{
  const media=path.join(directory,'media');fs.mkdirSync(media)
  const library=createMediaLibrary({name:'Async cleanup',roots:[{path:media}]})
  insertTestVideoWithFile(db,{libraryId:library.id,rootId:library.roots[0].id,code:'ASYNC-001',filePath:path.join(media,'ASYNC-001.mp4')})
  const before=businessSnapshot(db)
  let writer:ReturnType<typeof createScanAuditWriter>,calls=0
  const coordinator=createScanCoordinator({cleanupMode:'atomic',
    auditStorage: 'json',
    beginRun:input=>{beginLibraryScanRun(input);writer=createScanAuditWriter(db,input);writer.start({schemaVersion:2,...input,finishedAt:'pending',status:'success'})},
    finishRun:()=>{},scanFolders:async request=>empty(request.libraryId,request.runId),
    recordCleanupAudit:(_identity,event)=>{
      calls++;assert.equal(db.inTransaction,true)
      if(event.section==='deletedVideos')writer.writeBatch(event.section,[event.entry])
      else writer.writeBatch(event.section,[event.entry])
      return rejected?Promise.reject(new Error('async cleanup rejected')):Promise.resolve()
    }
  })
  await assert.rejects(coordinator.run({libraryId:library.id}),/synchronous/i)
  assert.equal(calls,1);assert.deepEqual(businessSnapshot(db),before)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(db.inTransaction,false)
})

it('copies deferred cleanup events into legacy audit only after the outer transaction commits',async()=>{
  const media=path.join(directory,'media');fs.mkdirSync(media)
  const library=createMediaLibrary({name:'Deferred seam',roots:[{path:media}]})
  const file=path.join(media,'DEFER-001.mp4');fs.writeFileSync(file,'present')
  const video=insertTestVideoWithFile(db,{libraryId:library.id,rootId:library.roots[0].id,code:'DEFER-001',filePath:file})
  const base={resourceId:video.fileId,videoId:video.videoId,videoCode:'DEFER-001',videoTitle:null,resourceKind:'local' as const,sourcePath:file,displayName:null}
  const events=[
    {section:'removedResources' as const,entry:{...base,reason:'removed_library_path' as const}},
    {section:'promotedResources' as const,entry:{...base,reason:'promoted_after_removal' as const}}
  ]
  const before=businessSnapshot(db),finished:Parameters<ScanCoordinatorDependencies['finishRun']>[0][]=[]
  let writer:ReturnType<typeof createScanAuditWriter>,sequence=0,applyCalls=0
  db.exec(`CREATE TEMP TRIGGER fail_deferred_audit AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='promotedResources' BEGIN SELECT RAISE(ABORT,'deferred audit fault');END;`)
  const coordinator=createScanCoordinator({cleanupMode:'atomic',
    auditStorage: 'json',
    createRunId:()=>`deferred-${++sequence}`,
    beginRun:input=>{beginLibraryScanRun(input);writer=createScanAuditWriter(db,input);writer.start({schemaVersion:2,...input,finishedAt:'pending',status:'success'})},
    finishRun:input=>{finished.push(input)},scanFolders:async request=>empty(request.libraryId,request.runId),
    listPendingPathCleanups:()=>[{jobId:'synthetic-deferred',libraryId:library.id,rootId:library.roots[0].id}],
    // Only the coordinator event seam is modeled here; actual deferred deletion
    // and authorization are covered by the cleanup service's integration tests.
    applyPendingPathCleanups:(cleanups,record)=>{
      applyCalls++;assert.equal(db.inTransaction,true);assert.equal(cleanups.length,1);assert.ok(record)
      for(const event of events)record(event)
      return {removed:1,promoted:1,consumedRoots:[{libraryId:library.id,rootId:library.roots[0].id}]}
    },
    recordCleanupAudit:(_identity,event)=>{
      assert.equal(db.inTransaction,true)
      if(event.section==='deletedVideos')writer.writeBatch(event.section,[event.entry])
      else writer.writeBatch(event.section,[event.entry])
    }
  })
  await assert.rejects(coordinator.run({libraryId:library.id}),/deferred audit fault/)
  assert.deepEqual(businessSnapshot(db),before)
  assert.deepEqual(finished[0].audit.removedResources,[]);assert.deepEqual(finished[0].audit.promotedResources,[])
  assert.equal(finished[0].summary.resourcesRemoved,0);assert.equal(finished[0].summary.primaryResourcesPromoted,0)
  db.exec('DROP TRIGGER fail_deferred_audit')
  const result=await coordinator.run({libraryId:library.id})
  assert.equal(applyCalls,2);assert.equal(result.removed,1);assert.equal(result.promoted,1)
  for(const event of events){
    const persisted=db.prepare('SELECT entry_json FROM library_scan_audit_entries WHERE section=? ORDER BY ordinal').all(event.section) as {entry_json:string}[]
    assert.deepEqual(persisted.map(row=>JSON.parse(row.entry_json)),[event.entry])
    assert.deepEqual(finished[1].audit[event.section],[event.entry])
  }
})

for(const blocked of ['remove','promote'] as const)it(`rejects an SQL-ignored ${blocked} write without emitting its audit and rolls back earlier cleanup`,async()=>{
  const media=path.join(directory,'media');fs.mkdirSync(media)
  const library=createMediaLibrary({name:'Ignored cleanup',roots:[{path:media}]})
  // This first resource is removed successfully before the ignored write, proving
  // that both its deletion and its earlier audit INSERT roll back with the batch.
  const earlier=insertTestVideoWithFile(db,{libraryId:library.id,rootId:library.roots[0].id,code:'EARLY-001',filePath:path.join(media,'EARLY-001.mp4')})
  const target=insertTestVideoWithFile(db,{libraryId:library.id,rootId:library.roots[0].id,code:'BLOCK-001',filePath:path.join(media,'BLOCK-001.mp4'),isPrimary:true})
  let promotedId:number|null=null
  if(blocked==='promote'){
    const file=path.join(media,'BLOCK-001-CD2.mp4');fs.writeFileSync(file,'present')
    promotedId=insertLocalVideoResource({libraryId:library.id,videoId:target.videoId,rootId:library.roots[0].id,locator:file,sizeBytes:7,durationSeconds:120,fileMtimeMs:1000})
    assert.ok(promotedId)
    db.exec(`CREATE TEMP TRIGGER ignore_primary BEFORE UPDATE OF is_primary ON video_resources
      WHEN OLD.id=${promotedId} AND NEW.is_primary=1 BEGIN SELECT RAISE(IGNORE);END;`)
  }else{
    db.exec(`CREATE TEMP TRIGGER ignore_removal BEFORE DELETE ON video_resources
      WHEN OLD.id=${target.fileId} BEGIN SELECT RAISE(IGNORE);END;`)
  }
  const before=businessSnapshot(db),finished:Parameters<ScanCoordinatorDependencies['finishRun']>[0][]=[]
  const observed:Array<{section:string;resourceId:number}>=[]
  let writer:ReturnType<typeof createScanAuditWriter>
  const coordinator=createScanCoordinator({cleanupMode:'atomic',
    auditStorage: 'json',
    beginRun:input=>{beginLibraryScanRun(input);writer=createScanAuditWriter(db,input);writer.start({schemaVersion:2,...input,finishedAt:'pending',status:'success'})},
    scanFolders:async request=>empty(request.libraryId,request.runId),finishRun:input=>{finished.push(input)},
    recordCleanupAudit:(_identity,event)=>{
      assert.equal(db.inTransaction,true)
      if(event.section==='deletedVideos')writer.writeBatch(event.section,[event.entry])
      else {
        observed.push({section:event.section,resourceId:event.entry.resourceId})
        writer.writeBatch(event.section,[event.entry])
      }
    }
  })
  await assert.rejects(coordinator.run({libraryId:library.id}))
  assert.ok(observed.some(event=>event.section==='removedResources'&&event.resourceId===earlier.fileId))
  assert.equal(observed.some(event=>blocked==='remove'
    ? event.section==='removedResources'&&event.resourceId===target.fileId
    : event.section==='promotedResources'&&event.resourceId===promotedId),false)
  assert.deepEqual(businessSnapshot(db),before)
  assert.equal(db.inTransaction,false);assert.equal(finished.length,1)
  assert.equal(finished[0].summary.status,'failed')
  assert.equal(finished[0].summary.resourcesRemoved,0);assert.equal(finished[0].summary.primaryResourcesPromoted,0);assert.equal(finished[0].summary.videosDeleted,0)
  assert.deepEqual(finished[0].audit.removedResources,[]);assert.deepEqual(finished[0].audit.promotedResources,[])
  assert.deepEqual(db.pragma('foreign_key_check'),[])
})
