import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { ScanResult } from '@shared/libraryTypes'
import { initDatabaseAtPath, closeDatabase, openReadOnlyDatabaseAtPath } from '@library/db/database'
import { createMediaLibrary } from '@library/db/mediaLibraryRepo'
import { removeResourceLessMemberships, removeResourceLessMembershipsWithAudit } from '@library/db/libraryMembershipRepo'
import { readScanAuditSource } from '@library/db/scanAuditSource'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { createScanCoordinator } from './scanCoordinator'

let db:Database.Database,directory:string,libraryId:number,previousUserData:string|undefined
const count=260
beforeEach(()=>{
  previousUserData=process.env.JAVDEX_TEST_USER_DATA
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-membership-entries-'));process.env.JAVDEX_TEST_USER_DATA=directory
  db=initDatabaseAtPath(path.join(directory,'catalog.db'))
  const media=path.join(directory,'media');fs.mkdirSync(media)
  libraryId=createMediaLibrary({name:'Membership cleanup',roots:[{path:media}]}).id
  db.prepare('UPDATE media_library_configs SET remove_resource_less_memberships=1 WHERE library_id=?').run(libraryId)
  const video=db.prepare('INSERT INTO videos(id,code,title) VALUES(?,?,?)')
  const membership=db.prepare('INSERT INTO library_video_memberships(library_id,video_id,discovery_key,is_pinned) VALUES(?,?,?,?)')
  db.transaction(()=>{
    for(let id=1;id<=count+1;id++){
      video.run(id,`MEM-${id}`,`原始标题 ${id}`)
      membership.run(libraryId,id,id,id===count+1?1:0)
      membership.run(1,id,id,0) // Shared global videos retain an independent library membership.
    }
  })()
})
afterEach(()=>{
  closeDatabase();resetSettingsCacheForTests()
  if(previousUserData===undefined)delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA=previousUserData
  fs.rmSync(directory,{recursive:true,force:true})
})
function empty(scope:{libraryId:number;runId:string}):ScanResult{return {...scope,scannedFiles:0,imported:0,skipped:0,skippedShort:0,failed:0,pendingGroups:0,pendingResources:0,
  relocated:0,refreshed:0,removed:0,promoted:0,deletedVideos:0,offlineFolders:[],newCodes:[],unrecognizedFiles:[],strmFailures:[],omittedStrmFailures:0}}
function memberships(connection=db){return connection.prepare('SELECT * FROM library_video_memberships ORDER BY library_id,video_id').all()}
function audit(runId:string){return JSON.parse(readScanAuditSource(db,{libraryId,runId},'body')!.body)}
function expected(){return Array.from({length:count},(_,index)=>({videoId:index+1,videoCode:`MEM-${index+1}`,videoTitle:`原始标题 ${index+1}`,reason:'resource_less'}))}

it('streams many scoped membership deletions into exact ordered audit rows without using the legacy array API',async()=>{
  const videos=db.prepare('SELECT * FROM videos ORDER BY id').all(),other=db.prepare('SELECT * FROM library_video_memberships WHERE library_id=1 ORDER BY video_id').all()
  let callbacks=0
  const coordinator=createScanCoordinator({cleanupMode:'atomic',createRunId:()=> 'many',scanFolders:async scope=>empty(scope),
    removeResourceLessMemberships:()=>assert.fail('entries mode must not materialize the legacy membership array'),
    removeResourceLessMembershipsWithAudit:(id,onRemoved)=>{
      assert.equal(id,libraryId);assert.equal(db.inTransaction,true)
      const removed=removeResourceLessMembershipsWithAudit(id,entry=>{callbacks++;assert.equal(db.inTransaction,true);onRemoved(entry)})
      assert.equal(typeof removed,'number');return removed
    }})
  const result=await coordinator.run({libraryId})
  assert.equal(callbacks,count);assert.equal(result.deletedVideos,count)
  assert.deepEqual(audit('many').deletedVideos,expected())
  const entries=db.prepare("SELECT ordinal FROM library_scan_audit_entries WHERE run_id='many' AND section='deletedVideos' ORDER BY ordinal").all()
  assert.deepEqual(entries,Array.from({length:count},(_,ordinal)=>({ordinal})))
  assert.deepEqual(db.prepare('SELECT * FROM videos ORDER BY id').all(),videos)
  assert.deepEqual(db.prepare('SELECT * FROM library_video_memberships WHERE library_id=1 ORDER BY video_id').all(),other)
  assert.deepEqual(db.prepare('SELECT video_id FROM library_video_memberships WHERE library_id=?').all(libraryId),[{video_id:count+1}])
  assert.equal(JSON.parse((db.prepare("SELECT summary_json FROM library_scan_runs WHERE id='many'").get() as {summary_json:string}).summary_json).videosDeleted,count)
  assert.deepEqual(db.pragma('foreign_key_check'),[])
})

it('rolls back a late native audit failure with all earlier deletions, then retries with exact counts',async()=>{
  const before=memberships(),videos=db.prepare('SELECT * FROM videos ORDER BY id').all(),reader=openReadOnlyDatabaseAtPath(db.name)
  let sequence=0,faults=0,callbacks=0
  db.function('observe_late_membership',(remaining)=>{faults++;assert.equal(remaining,count-202);return 1})
  db.exec(`CREATE TEMP TRIGGER fail_late_membership AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='deletedVideos' AND NEW.ordinal=201 BEGIN
      SELECT observe_late_membership((SELECT COUNT(*) FROM library_video_memberships WHERE library_id=${libraryId} AND video_id<=${count}));
      SELECT RAISE(ABORT,'late membership audit failure');END;`)
  const coordinator=createScanCoordinator({cleanupMode:'atomic',createRunId:()=>`retry-${++sequence}`,scanFolders:async scope=>empty(scope),
    removeResourceLessMemberships:()=>assert.fail('legacy array API must not run'),
    removeResourceLessMembershipsWithAudit:(id,onRemoved)=>removeResourceLessMembershipsWithAudit(id,entry=>{
      callbacks++;if(callbacks===202)assert.deepEqual(memberships(reader),before)
      onRemoved(entry)
    })})
  try{
    await assert.rejects(coordinator.run({libraryId}),/late membership audit failure/)
    assert.equal(faults,1);assert.equal(callbacks,202);assert.deepEqual(memberships(),before);assert.deepEqual(memberships(reader),before)
    assert.deepEqual(db.prepare('SELECT * FROM videos ORDER BY id').all(),videos)
    assert.deepEqual(audit('retry-1').deletedVideos,[])
    const failed=JSON.parse((db.prepare("SELECT summary_json FROM library_scan_runs WHERE id='retry-1'").get() as {summary_json:string}).summary_json)
    assert.equal(failed.status,'failed');assert.equal(failed.videosDeleted,0)
    db.exec('DROP TRIGGER fail_late_membership')
    const result=await coordinator.run({libraryId})
    assert.equal(result.deletedVideos,count);assert.equal(callbacks,202+count)
    assert.deepEqual(audit('retry-2').deletedVideos,expected())
    assert.deepEqual(memberships(reader),memberships());assert.deepEqual(db.pragma('foreign_key_check'),[])
  }finally{reader.close()}
})

it('retains the explicit JSON cleanup API and legacy audit array contract',async()=>{
  let legacyCalls=0
  const coordinator=createScanCoordinator({cleanupMode:'atomic',auditStorage:'json',createRunId:()=> 'legacy',scanFolders:async scope=>empty(scope),
    removeResourceLessMemberships:id=>{legacyCalls++;return removeResourceLessMemberships(id)},
    removeResourceLessMembershipsWithAudit:()=>assert.fail('JSON mode should use its existing array API')})
  assert.equal((await coordinator.run({libraryId})).deletedVideos,count)
  assert.equal(legacyCalls,1);assert.deepEqual(audit('legacy').deletedVideos,expected())
  assert.equal(readScanAuditSource(db,{libraryId,runId:'legacy'},'identity')?.format,'json')
})
