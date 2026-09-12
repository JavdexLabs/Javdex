import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { ScanResult } from '@shared/libraryTypes'
import { initDatabaseAtPath, closeDatabase, openReadOnlyDatabaseAtPath } from '@library/db/database'
import { createMediaLibrary, addMediaLibraryRoot, getMediaLibrary } from '@library/db/mediaLibraryRepo'
import { previewLibraryPathRemoval, confirmLibraryPathRemoval } from '@library/scan/libraryPathCleanupService'
import { insertLocalVideoResource } from '@library/db/videoRepo'
import { readScanAuditSource } from '@library/db/scanAuditSource'
import { removeResourceLessMembershipPage } from '@library/db/libraryMembershipRepo'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { createScanCoordinator } from './scanCoordinator'
import { createScanCleanupPages, type CleanupCandidates } from '@library/scan/scanCleanupPages'

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

it('yields between committed pages with the real coordinator and complete audit',async()=>{
  let callbacks=0, beats=0, beatsAtLast=0
  let immediate:ReturnType<typeof setImmediate>|undefined
  const coordinator=createScanCoordinator({createRunId:()=> 'responsive',scanFolders:async scope=>empty(scope),
    recordCleanupAudit:()=>{
      if(++callbacks===1) immediate=setImmediate(()=>{beats++;assert.equal(db.inTransaction,false)})
      if(callbacks===count) beatsAtLast=beats
    }
  })
  try {
    const result=await coordinator.run({libraryId})
    assert.equal(result.deletedVideos,count);assert.equal(callbacks,count)
    assert.ok(beatsAtLast>0)
    assert.deepEqual(audit('responsive').deletedVideos,expected())
  } finally {if(immediate)clearImmediate(immediate)}
})

it('keeps committed pages and publishes truthful failed counts after a late native audit fault',async()=>{
  const reader=openReadOnlyDatabaseAtPath(db.name)
  db.exec(`CREATE TEMP TRIGGER fail_cleanup_page AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='deletedVideos' AND NEW.ordinal=129 BEGIN SELECT RAISE(ABORT,'late page fault');END;`)
  let calls=0
  const coordinator=createScanCoordinator({createRunId:()=> 'partial',scanFolders:async scope=>empty(scope),
    recordCleanupAudit:event=>{
      void event
      if(++calls===129) assert.equal((reader.prepare('SELECT COUNT(*) AS n FROM library_video_memberships WHERE library_id=? AND is_pinned=0').get(libraryId) as {n:number}).n,count-128)
    }
  })
  try {
    await assert.rejects(coordinator.run({libraryId}),/late page fault/)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM library_video_memberships WHERE library_id=? AND is_pinned=0').get(libraryId) as {n:number}).n,count-128)
    assert.equal(audit('partial').deletedVideos.length,128)
    const row=db.prepare("SELECT status,summary_json FROM library_scan_runs WHERE id='partial'").get() as {status:string;summary_json:string}
    assert.equal(row.status,'failed');assert.equal(JSON.parse(row.summary_json).videosDeleted,128)
    db.exec('DROP TRIGGER fail_cleanup_page')
    const retry=createScanCoordinator({createRunId:()=> 'retry-page',scanFolders:async scope=>empty(scope)})
    assert.equal((await retry.run({libraryId})).deletedVideos,count-128)
    assert.equal(audit('retry-page').deletedVideos.length,count-128)
    assert.deepEqual(memberships(reader),memberships())
  }finally{reader.close()}
})

it('cancels after the current committed page and drains before stopping admission',async()=>{
  let calls=0,drained=false,drain:Promise<void>|undefined
  let immediate:ReturnType<typeof setImmediate>|undefined
  const coordinator=createScanCoordinator({createRunId:()=> 'cancel-pages',scanFolders:async scope=>empty(scope),
    recordCleanupAudit:()=>{
      if(++calls===1) immediate=setImmediate(()=>{drain=coordinator.stopAndDrain().then(()=>{drained=true})})
    }
  })
  try {
    const result=await coordinator.run({libraryId})
    await drain
    assert.equal(drained,true);assert.equal(result.cancelled,true)
    assert.equal(result.deletedVideos,128);assert.equal(calls,128)
    assert.equal(audit('cancel-pages').deletedVideos.length,128)
    assert.equal(db.inTransaction,false);assert.equal(coordinator.running,false)
    await assert.rejects(coordinator.run({libraryId}),/关闭/)
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'scan_cleanup_%'").all(),[])
  }finally{if(immediate)clearImmediate(immediate)}
})

it('does not delete a membership added between pages for an old video ID',async()=>{
  db.prepare('DELETE FROM library_video_memberships WHERE library_id=? AND video_id=200').run(libraryId)
  let immediate:ReturnType<typeof setImmediate>|undefined,calls=0
  const coordinator=createScanCoordinator({createRunId:()=> 'new-membership',scanFolders:async scope=>empty(scope),
    recordCleanupAudit:()=>{
      if(++calls===1) immediate=setImmediate(()=>{
        db.prepare('INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES(?,200,200)').run(libraryId)
      })
    }
  })
  try {
    const result=await coordinator.run({libraryId})
    assert.equal(result.deletedVideos,count-1)
    assert.ok(db.prepare('SELECT 1 FROM library_video_memberships WHERE library_id=? AND video_id=200').get(libraryId))
    assert.ok(!audit('new-membership').deletedVideos.some((row:{videoId:number})=>row.videoId===200))
  }finally{if(immediate)clearImmediate(immediate)}
})

it('uses monotonic native query plans without per-page sorting for every cleanup table',async context=>{
  const prepare=db.prepare.bind(db), plans:string[]=[]
  context.mock.method(db,'prepare',(sql:string)=>{
    if(sql.startsWith('SELECT candidate.')) {
      const plan=prepare('EXPLAIN QUERY PLAN '+sql).all(libraryId,0,100000) as {detail:string}[]
      const text=plan.map(row=>row.detail).join(' | ')
      plans.push(text)
      assert.doesNotMatch(text,/TEMP B-TREE/)
      assert.match(text,sql.includes('library_video_memberships candidate') ? /video_id>.*video_id</ : /INTEGER PRIMARY KEY.*rowid>.*rowid</)
    }
    return prepare(sql)
  })
  const pages=createScanCleanupPages(db,libraryId),signal=new AbortController().signal
  try {
    for(const kind of ['resources','pendingScan','pendingIdentity','pendingGroups','memberships','unrecognized'] as CleanupCandidates[]) {
      await pages.each(kind,signal,operation=>db.transaction(operation)(),()=>{},()=>{})
    }
    assert.equal(plans.length,6)
    for(const table of ['video_resources','pending_scan_resources','pending_resource_identities','pending_scan_groups']) {
      assert.match((prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table) as {sql:string}).sql,/AUTOINCREMENT/)
    }
  }finally{pages.dispose()}
})

function seedMissingAndPending() {
  const root=db.prepare('SELECT id,path FROM media_library_roots WHERE library_id=?').get(libraryId) as {id:number;path:string}
  const missing=path.join(root.path,'missing.mp4')
  insertLocalVideoResource({libraryId,rootId:root.id,videoId:1,locator:missing,sizeBytes:1})
  const group=Number(db.prepare("INSERT INTO pending_scan_groups(library_id,normalized_code) VALUES(?,'PENDING')").run(libraryId).lastInsertRowid)
  db.prepare("INSERT INTO pending_scan_resources(library_id,group_id,root_id,file_path,normalized_path) VALUES(?,?,?,?,?)")
    .run(libraryId,group,root.id,path.join(root.path,'pending.mp4'),path.join(root.path,'pending.mp4'))
  db.prepare("INSERT INTO pending_resource_identities(library_id,root_id,file_path,normalized_path,source_kind,filename_code,nfo_code) VALUES(?,?,?,?,'local','A','B')")
    .run(libraryId,root.id,path.join(root.path,'identity.mp4'),path.join(root.path,'identity.mp4'))
  return root
}

it('publishes earlier pending and missing-resource commits when the later membership stage fails',async()=>{
  seedMissingAndPending()
  db.exec(`CREATE TEMP TRIGGER fail_last_stage AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='deletedVideos' BEGIN SELECT RAISE(ABORT,'membership stage failed');END;`)
  const coordinator=createScanCoordinator({createRunId:()=> 'stage-partial',scanFolders:async scope=>empty(scope)})
  await assert.rejects(coordinator.run({libraryId}),/membership stage failed/)
  for(const table of ['pending_scan_resources','pending_resource_identities','video_resources']) {
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM '+table+' WHERE library_id=?').get(libraryId) as {n:number}).n,0)
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM library_video_memberships WHERE library_id=?').get(libraryId) as {n:number}).n,count+1)
  const history=audit('stage-partial')
  assert.equal(history.removedResources.length,1);assert.equal(history.deletedVideos.length,0)
  const summary=JSON.parse((db.prepare("SELECT summary_json FROM library_scan_runs WHERE id='stage-partial'").get() as {summary_json:string}).summary_json)
  assert.equal(summary.status,'failed');assert.equal(summary.resourcesRemoved,1);assert.equal(summary.videosDeleted,0)
})

it('runs deferred roots between missing and membership stages, retaining truthful history on later failure',async()=>{
  seedMissingAndPending()
  const folder=path.join(directory,'deferred');fs.mkdirSync(folder)
  const root=addMediaLibraryRoot({libraryId,expectedRevision:getMediaLibrary(libraryId)!.revision,root:{path:folder}})
  insertLocalVideoResource({libraryId,rootId:root.id,videoId:2,locator:path.join(folder,'deferred.mp4'),sizeBytes:1})
  const preview=previewLibraryPathRemoval({libraryId,rootId:root.id})
  const job=confirmLibraryPathRemoval({libraryId,rootId:root.id,expectedRevision:preview.libraryRevision,expectedImpactRevision:preview.impactRevision})
  db.exec(`CREATE TEMP TRIGGER fail_after_deferred AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='deletedVideos' BEGIN SELECT RAISE(ABORT,'later stage failure');END;`)
  const coordinator=createScanCoordinator({createRunId:()=> 'all-stages',scanFolders:async scope=>empty(scope)})
  await assert.rejects(coordinator.run({libraryId}),/later stage failure/)
  assert.deepEqual(db.prepare('SELECT state FROM library_root_cleanup_jobs WHERE id=?').get(job.jobId),{state:'completed'})
  assert.deepEqual(db.prepare('SELECT state FROM media_library_roots WHERE id=?').get(root.id),{state:'disabled'})
  const history=audit('all-stages')
  assert.deepEqual(history.removedResources.map((row:{reason:string})=>row.reason),['missing','removed_library_path'])
  const summary=JSON.parse((db.prepare("SELECT summary_json FROM library_scan_runs WHERE id='all-stages'").get() as {summary_json:string}).summary_json)
  assert.equal(summary.resourcesRemoved,2);assert.equal(summary.videosDeleted,0);assert.equal(summary.status,'failed')
})

it('stopAndDrain remains pending through the current transaction, rejects new admission, and permits DB close only after terminal cleanup',async()=>{
  let drain:Promise<void>|undefined,settled=false,calls=0
  const coordinator=createScanCoordinator({createRunId:()=> 'drain-order',scanFolders:async scope=>empty(scope),recordCleanupAudit:()=>{
    if(++calls===1) {
      drain=coordinator.stopAndDrain().then(()=>{settled=true})
      assert.equal(settled,false);assert.equal(db.open,true);assert.equal(db.inTransaction,true)
    }
  }})
  const task=coordinator.run({libraryId})
  const result=await task
  assert.ok(drain);await drain
  assert.equal(settled,true);assert.equal(result.cancelled,true);assert.equal(result.deletedVideos,128)
  assert.equal(coordinator.running,false);assert.equal(db.inTransaction,false)
  await assert.rejects(coordinator.run({libraryId}),/关闭/)
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'scan_cleanup_%'").all(),[])
  closeDatabase()
})


it('uses the injected cooperative membership remover inside the page transaction and rolls back its failure', async () => {
  const pages: number[][] = []
  const coordinator = createScanCoordinator({
    createRunId: () => 'injected-membership-failure',
    scanFolders: async scope => empty(scope),
    removeResourceLessMembershipPage: (targetLibraryId, ids, onRemoved) => {
      assert.equal(targetLibraryId, libraryId)
      assert.equal(db.inTransaction, true)
      pages.push([...ids])
      const removed = removeResourceLessMembershipPage(targetLibraryId, ids, onRemoved)
      if (pages.length === 2) throw new Error('injected membership failure')
      return removed
    }
  })

  await assert.rejects(coordinator.run({ libraryId }), /injected membership failure/)
  assert.deepEqual(pages, [
    Array.from({ length: 128 }, (_, i) => i + 1),
    Array.from({ length: 128 }, (_, i) => i + 129)
  ])
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM library_video_memberships WHERE library_id=? AND is_pinned=0').get(libraryId) as { n: number }).n, count - 128)
  assert.deepEqual(audit('injected-membership-failure').deletedVideos, expected().slice(0, 128))
  const run = db.prepare('SELECT status,summary_json FROM library_scan_runs WHERE id=?').get('injected-membership-failure') as { status: string; summary_json: string }
  assert.equal(run.status, 'failed')
  assert.equal(JSON.parse(run.summary_json).videosDeleted, 128)

  const retry = createScanCoordinator({ createRunId: () => 'injected-membership-retry', scanFolders: async scope => empty(scope) })
  assert.equal((await retry.run({ libraryId })).deletedVideos, count - 128)
  assert.deepEqual(audit('injected-membership-retry').deletedVideos, expected().slice(128))
})
